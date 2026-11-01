# Development Guide

Everything you need to change this codebase without breaking it, including the
conventions that are not obvious from reading a single file.

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node | **≥ 22.5.0** | `node:sqlite` was added in 22.5. The `engines` field enforces it. |
| npm | any recent | Only used to install Playwright. |
| Google Chrome | optional | If present, Playwright drives your installed Chrome instead of downloading Chromium. |

Verified on Node `v22.16.0` / npm `11.16.0` on macOS (Apple Silicon).

`node:sqlite` is still marked experimental and prints
`ExperimentalWarning: SQLite is an experimental feature` on startup. The npm
scripts pass `--no-warnings` to keep the console clean; if you run a file
directly with `node`, expect the warning.

---

## First run

```bash
npm install
npm run setup      # installs the Chromium build Playwright expects
npm start          # http://localhost:4747
```

`npm run setup` is not optional on a fresh machine: the pinned Playwright version
expects a specific Chromium build, and without it the first fetch dies with
`Executable doesn't exist at .../chrome-headless-shell`. If you have Chrome
installed, the browser adapter will usually fall back to it and you may never
notice — until you run in a container.

### Scripts

| Script | Does |
|---|---|
| `npm start` | Runs `server.mjs` (HTTP + scheduler) |
| `npm run setup` | `playwright install chromium` |
| `npm run check` | One poll cycle, then exit — for cron |
| `npm run add -- <url>` | Add an item from the terminal |
| `npm run list` | Print the watchlist as a table |
| `npm run seed` | Insert (or `-- --clear`) a demo item with 181 snapshots |

Seeding is the fastest way to see the chart, the stat cards and the deal score
without waiting a week for real data:

```bash
npm run seed              # adds the demo item
npm run seed -- --clear   # removes it
```

---

## Repository layout

```
mercadotrack/
├── server.mjs              HTTP server, routes, static files
├── package.json
├── config.json             (gitignored) created on demand
├── data/                   (gitignored) SQLite database + WAL files
├── lib/
│   ├── db.mjs              schema + every query
│   ├── config.mjs          defaults, deep merge, env overrides
│   ├── alerts.mjs          pure alert rules
│   ├── poller.mjs          the poll cycle and the scheduler
│   ├── notify.mjs          desktop + Telegram delivery
│   ├── mltarget.mjs        URL/id parsing
│   ├── util.mjs            withTimeout, TimeoutError, sleep
│   └── sources/
│       ├── index.mjs       router
│       ├── browser.mjs     Playwright adapter (+ parsePrice, searchProducts)
│       └── api.mjs         official API adapter + OAuth refresh
├── bin/                    add / check / list / seed
├── public/                 index.html, styles.css, app.js
└── docs/                   this documentation
```

---

## Conventions

**ESM only on the server.** `"type": "module"`, every Node file `.mjs`,
`import`/`export` only, no CommonJS anywhere. `public/app.js` is loaded as
`<script type="module">` but deliberately imports nothing: it is a single
self-contained file, so the UI needs no bundler and no module resolution at
runtime. Keep it that way — adding an `import` to it means adding a build step or
relying on the browser resolving bare specifiers, and neither is worth it for one
file.

**Node built-ins, no utility libraries.** `node:http`, `node:sqlite`,
`node:fs/promises`, `node:path`. If you find yourself reaching for Express or
Lodash, the feature probably does not belong here.

**Comments explain *why*.** The code is short enough to read; what is not
obvious is the reasoning — why the wait is 2500 ms, why the median is computed in
JS, why `evaluate()` must run before `addSnapshot()`. Every non-obvious decision
carries a comment. Do not add comments that restate the code.

**Errors carry context.** `throw new Error('...')` must say what failed and, when
possible, how to fix it. Compare:

```js
throw new Error('launch failed');                                  // no
throw new Error(`Playwright could not launch a browser. Run: npm run setup`); // yes
```

**Portuguese at the edges, English inside.** Code, identifiers, comments, docs
and commit messages are English. User-facing strings — API error messages, alert
text, CLI output, UI copy — are Portuguese, because the user is buying from
Mercado Livre Brasil.

**Booleans become integers at the SQLite boundary.** Bind `0`/`1`, read with
`!!`. See [`DATA-MODEL.md`](DATA-MODEL.md).

---

## Testing

There is no test runner in `package.json` — the project ships zero dev
dependencies, and adding Jest/Vitest for five files felt wrong. The suites used
during the build were standalone scripts run with plain `node`, and that pattern
is worth keeping.

### What to test, and how

The two pure-ish modules carry almost all the risk:

**`parsePrice` and `parseTarget`** — no I/O, call directly.

```js
import { parsePrice } from './lib/sources/browser.mjs';
import assert from 'node:assert/strict';

assert.equal(parsePrice('R$ 1.234,56'), 1234.56);
assert.equal(parsePrice('1.299'), 1299);      // thousands, not 1.299
assert.equal(parsePrice('R$ 0'), null);       // a price must be positive
assert.equal(parsePrice(null), null);
```

**`evaluate`** — pure, takes plain objects. See the scenario table in
[`ALERTS.md`](ALERTS.md). Use `MT_DB=/tmp/test.db` so the cooldown queries hit a
throwaway database.

**The poller** — test the *policy*, not the network. Stub the source by importing
`runOnce` with a fake `activeItems()` result, or point `source` at a module you
control. What matters: the error streak increments, the item deactivates at
`maxErrorStreak`, and inactive items are skipped.

**The database** — every suite must run against `MT_DB=/tmp/whatever.db`.
Never against `data/mercado.db`.

### Manual smoke test

```bash
pkill -9 -f server.mjs 2>/dev/null; lsof -ti:4747 | xargs kill -9 2>/dev/null
MT_PORT=4747 npm start &
sleep 1
for p in / /styles.css /app.js /api/status /api/items /api/alerts; do
  printf '%s → %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' localhost:4747$p)"
done
```

All six must be `200`. Then `npm run seed`, open the UI, and confirm the
chart renders with points and the stat cards show a median.

> **Kill stale servers before every test run.** During development, orphaned
> `server.mjs` processes on ports 4799/4811/4822 repeatedly served *old code*
> and produced confusing results ("my fix didn't work"). The `pkill` above is not
> paranoia; it is the single most common source of wasted debugging time in this
> project.

---

## Debugging

### The source returned nothing

The error message includes the page `<title>`, which usually identifies the cause
immediately:

| `<title>` in the error | Meaning | Fix |
|---|---|---|
| `Just a moment...` / `suspicious-traffic` | Bot challenge | Increase waits; use a real browser; slow down |
| `Página não encontrada` / `404` | Listing is gone | Delete or pause the item |
| A normal product title | Selectors drifted | Update the DOM layer in `browser.mjs` |

### Reproduce a scrape outside the app

```js
// /tmp/scrape.mjs
import { fetchProduct } from '/path/to/mercadotrack/lib/sources/browser.mjs';
console.log(await fetchProduct('https://produto.mercadolivre.com.br/MLB-...'));
```

Run with `node --no-warnings /tmp/scrape.mjs`. This isolates the adapter from the
poller, the database and the HTTP layer.

### Watch the poller

`server.mjs` and `bin/check.mjs` print one line per item, so a failing item is
visible without opening the database:

```
[poll] next check in 63 min (2026-11-01T14:20:00.000Z)
  ✓ Fone Bluetooth Over-Ear — R$ 329,90  ⚡ new_low
  ✗ Fone Bluetooth Over-Ear — Could not read a price (page title: "Just a moment...")
```

`error_streak` in the database is the durable version of the `✗` line.

### Inspect the database

```bash
sqlite3 data/mercado.db 'select id, title, active, error_streak, last_error from items;'
sqlite3 data/mercado.db 'select ts, price, source from snapshots where item_id=1 order by ts desc limit 10;'
```

The `source` column tells you which adapter produced each row — the first thing
to check when a price looks wrong.

---

## Recipes for extending

### Add a field to the snapshot

1. `lib/db.mjs` — add the column in `CREATE TABLE` **and** an `ALTER TABLE ...
   ADD COLUMN` guard for existing databases.
2. `lib/sources/browser.mjs` — extract it in the DOM layer and in the JSON-LD
   branch; default to `null` rather than guessing.
3. `lib/sources/api.mjs` — map it from the API response.
4. `lib/poller.mjs` — pass it through to `addSnapshot` (it spreads `snap`, so
   usually nothing to do).
5. `server.mjs` — surface it in `withStats` if the UI needs it.
6. `public/app.js` — render it.

### Add an alert kind

1. `lib/alerts.mjs` — push `{ kind, message, price }` in `evaluate()`. Keep it
   pure and keep the cooldown guard (`cooled(kind)`).
2. Document it in [`ALERTS.md`](ALERTS.md) with the exact condition.
3. `public/app.js` — the feed renders `message` verbatim, so nothing is required;
   add an icon mapping only if you want one.

Do **not** add I/O, `fetch`, or notification calls inside `evaluate()`. That
function is the reason alert behaviour is testable.

### Add a chart range

Add one button to the `#range-picker` group in `public/index.html` with a
`data-days` value (`0` means all time). `app.js` reads it into `state.rangeDays`
and re-renders from the history it already holds, so there is no server change and
no refetch.

### Change the poll cadence

Prefer `config.json` over code. If a value is genuinely not configurable yet, add
it to `DEFAULTS` in `lib/config.mjs` and to the reference table in
[`CONFIGURATION.md`](CONFIGURATION.md) — those two must stay in sync.

---

## Commit conventions

```
<area>: <imperative summary>

Optional body explaining why, not what.
```

Areas: `db`, `poller`, `alerts`, `sources`, `server`, `ui`, `cli`, `docs`,
`config`. Examples from the build:

```
sources: fix BRL thousands separator in parsePrice
db: cascade snapshots and alerts on item delete
poller: bound item fetches with a timeout so a hung browser cannot wedge a cycle
```

---

## Before opening a pull request

- [ ] `npm start` serves all six smoke-test routes with `200`
- [ ] `npm run seed` produces a chart with visible points
- [ ] `parsePrice` / `parseTarget` / `evaluate` still pass their checks
- [ ] No new runtime dependency (if you need one, explain why in the PR)
- [ ] Docs updated: [`HTTP-API.md`](HTTP-API.md) for routes,
      [`CONFIGURATION.md`](CONFIGURATION.md) for knobs,
      [`DATA-MODEL.md`](DATA-MODEL.md) for schema
- [ ] Portuguese for anything the user sees
