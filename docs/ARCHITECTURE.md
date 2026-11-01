# Architecture

MercadoTrack is a local-first price tracker for Mercado Livre. It is deliberately
small: ~2,300 lines across 17 files, one runtime dependency, no build step, no
frontend framework, no database server.

The shape of the code follows from three constraints that were decided before
anything was written.

| Constraint | Consequence |
|---|---|
| Mercado Livre has **no price-history API** | The app must record its own history, forever, from the day of install |
| Scraping a hostile site is **fragile** | Sources are pluggable adapters behind one interface; failures are data, not crashes |
| This runs on **a person's laptop** | Zero-dependency storage (`node:sqlite`), no daemon to babysit, no build step to break |

---

## Process model

There is exactly **one** process: `node server.mjs`. It does three jobs.

```
┌─────────────────────────────────────────────────────────────┐
│  server.mjs (single Node process, 127.0.0.1:4747)           │
│                                                             │
│  ┌───────────────┐   ┌──────────────┐   ┌───────────────┐   │
│  │ HTTP server   │   │  scheduler   │   │ static files  │   │
│  │ /api/*        │──▶│  lib/poller  │   │ public/       │   │
│  └───────┬───────┘   └──────┬───────┘   └───────────────┘   │
│          │                  │                               │
│          ▼                  ▼                               │
│  ┌─────────────────────────────────────────┐                │
│  │  lib/db.mjs  ── node:sqlite (WAL)       │                │
│  └─────────────────────────────────────────┘                │
│                    ▲                                        │
│                    │                                        │
│         ┌──────────┴───────────┐                            │
│         │ lib/sources/index    │  browser.mjs | api.mjs     │
│         └──────────────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

The scheduler is a `setTimeout` chain inside the same process, `unref()`ed so it
never keeps the process alive on its own. It is **not** a separate worker, and it
does not queue jobs: if a cycle is still running when the next tick would fire,
`runOnce()` returns `{ skipped: true }` because `state.running` is already true.

For cron-driven setups, `bin/check.mjs` runs one cycle and exits, and the HTTP
server can be omitted entirely — the database is the only shared state.

---

## Layer map

| Layer | Files | Owns | Must not |
|---|---|---|---|
| Presentation | `public/*` | Rendering, chart, forms | Know about SQLite or Playwright |
| HTTP | `server.mjs` | Routing, JSON, static files | Contain price logic |
| Domain | `lib/alerts.mjs`, `lib/poller.mjs` | Alert rules, poll cycle | Know about HTTP or Playwright |
| Sources | `lib/sources/*` | Talking to Mercado Livre | Write to the database |
| Storage | `lib/db.mjs` | Schema, queries | Know about prices-as-deals |
| Config | `lib/config.mjs` | Defaults, env overrides | Be imported by `public/` |

Dependencies point **downward only**. `lib/alerts.mjs` imports nothing but the
formatter; `lib/sources/*` imports nothing but config. That is what makes the
alert engine unit-testable with plain objects and the sources swappable without
touching the poller.

---

## Request lifecycle: adding an item

The most interesting path in the app, because it is the only one that does a
synchronous network fetch.

```
POST /api/items {url}
   │
   ├─ parseTarget(url)                lib/mltarget.mjs
   │     → { mlId, url }              throws if unparseable → 400
   │
   ├─ getItemByMlId(mlId)             already tracked? → 200 + update
   │
   ├─ fetchForItem({url, ml_id})      ← best effort, bounded by
   │     withTimeout(…, timeout+20s)     timeoutSeconds + 20 s
   │     │
   │     ├─ success → snap {title, price, image, seller}
   │     └─ failure → lookupError (item is STILL created)
   │
   ├─ addItem({...})                  title fallback chain:
   │                                    snap.title → body.title
   │                                    → titleFromUrl(url) → target.id
   ├─ addSnapshot(item.id, snap)      first data point (if lookup succeeded)
   │
   └─ 201 { item: withStats(item), created: true, lookupError }
```

**Why fetch synchronously in the request?** Because the alternative is worse. A
row that says `MLB3554042705` with no price is not a product the user recognises,
and a background "enrichment" job means the list is wrong for an indeterminate
time after adding. The user has just pasted a URL and is watching; a two-second
wait for a real title is the better trade. The 20 s slack on the timeout exists
because the browser adapter's own internal waits (2.5 s challenge window, 3 s
render wait) must not be cut off by the outer guard.

**Why the item is created even when the lookup fails.** The user's intent was
"track this". A transient challenge page is not a reason to refuse. The item is
stored with a slug-derived title, `lookupError` is returned, and the poller
retries later. `last_error` is left `NULL` on this path on purpose — it is
reserved for poll failures, and mixing the two makes the UI badge lie.

---

## Poll cycle

```
startScheduler()
   │
   ├─ scheduleNext()  → pollMinutes + random(0, jitterMinutes)
   ▼
runOnce({ notifyUser: true })
   │
   ├─ if state.running → return { skipped: true }
   ├─ items = activeItems()                  (active = 1 only)
   │
   └─ for each item:
        │
        ├─ checkItem(item.id)
        │    ├─ prev = lastSnapshot(item.id)
        │    ├─ snap = withTimeout(fetchForItem(item), timeout+30s)
        │    ├─ if (snap.price == null) throw     ← the critical guard
        │    ├─ fired = recordAlerts(item, evaluate(item, snap, prev))
        │    │                                        ▲ before addSnapshot
        │    ├─ addSnapshot(item.id, {…snap, ts})
        │    ├─ updateItem(id, {last_checked, last_error: null, error_streak: 0,
        │    │                  title: keep-if-set, image/seller: fill-if-empty})
        │    └─ notify each alert (400 ms apart)
        │
        │    on error:
        │    ├─ streak = error_streak + 1
        │    ├─ updateItem({last_error, error_streak: streak})
        │    └─ if (streak >= maxErrorStreak) → active = 0
        │
        └─ if not last item → sleep(random(4..9) s)
   │
   ├─ finally: state.lastRunAt / lastRunMs / lastResult
   └─ scheduleNext() → next setTimeout
```

Three details carry most of the robustness:

1. **`evaluate()` runs before `addSnapshot()`.** So `new_low` compares against
   the history *excluding* the price being evaluated. Reversing these two lines
   silently breaks every "record low" alert — the price would always be equal to
   its own minimum.
2. **The `snap.price == null` throw.** The single line that prevents a failed
   parse from being stored as a snapshot. Every adapter is supposed to throw
   instead, but this is the last line of defence.
3. **`finally` around the loop.** `state.running` is always cleared, so a thrown
   error cannot permanently wedge the poller into "already running".

---

## Why the scheduler is a timeout chain, not `setInterval`

`setInterval` fires on a fixed wall clock and does not care that the previous
cycle is still running — with a slow source you get overlapping cycles and a
doubling request rate. A `setTimeout` scheduled *after* the work completes gives
"at least N minutes between cycles" semantics, which is what politeness requires.

The jitter is re-rolled every cycle (`scheduleNext()` on each pass), so the
cadence never settles into a fingerprintable pattern.

---

## Frontend

`public/` is three files served statically: `index.html`, `styles.css`,
`app.js`. No bundler, no framework, no dependencies.

- **State** lives in module-level variables in `app.js` (`items`, `alerts`,
  `selected`, `range`). There is no reactive system — mutations call an explicit
  `render*()` function.
- **The chart is hand-rolled SVG.** `buildPath()` maps `(ts, price)` to `(x, y)`
  and emits a `d` attribute; `buildArea()` closes it to the baseline for the
  fill. Crosshair, tooltip and the range selector are plain DOM events.
- **Ranges** (`7d`, `30d`, `90d`, `1y`, `all`) filter the in-memory history and
  re-render. No refetch: `GET /api/items/:id` already returned the full series.
- **Stat cards** (min, max, median, average, current, "abaixo da mediana") are
  computed client-side from `stats`, which the server already provided.

This is the right trade-off for a single-user local app: an SVG chart in ~120
lines beats adding a charting library and a bundler to a project whose entire
selling point is `npm install && npm start`.

---

## Failure philosophy

The same rule appears in four places, which is why it is worth stating once:

> **A failure must be visible, attributable and non-destructive.**

| Place | Failure becomes | Never |
|---|---|---|
| `checkItem` | `last_error` + `error_streak`, item auto-paused after 8 | A wrong price |
| `evaluate` | `return` with nothing fired | A 100%-off alert from `price: 0` |
| `notify` | Logged warning | A thrown error that fails the poll |
| `loadConfig` | Logged warning + defaults | A crash on a JSON typo |

Corollary: `updateItem` is whitelisted, so a malformed `PATCH` body cannot write
`id` or `created_at` even if it tries.

---

## Known structural warts

Honest list, all documented in [`ROADMAP.md`](ROADMAP.md):

1. **`server.mjs` dynamically imports `fetchForItem` and `addSnapshot`** inside
   the `POST /api/items` handler instead of importing at the top. It works, but
   it hides the dependency and costs a module lookup on every add.
2. **`/api/check-all` is a long-lived request.** With 10 items and a 4–9 s gap it
   holds the connection for over a minute. Fine on localhost, wrong for anything
   with a proxy in front.
3. **No pagination anywhere.** `listAlerts` caps at 100 and `history()` returns
   everything. Both are correct for a personal watchlist and both would need to
   change for a multi-user deployment.
4. **No schema versioning.** Additive `ALTER TABLE` only.
5. **The third extraction layer is a comment, not code** — `__PRELOADED_STATE__`
   is described in `browser.mjs`'s header but never implemented.
