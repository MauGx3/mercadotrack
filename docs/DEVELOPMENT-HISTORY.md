# Development History

A record of how MercadoTrack was built: the brief, the decisions and their
reasons, the reconnaissance that shaped the architecture, and every bug found
along the way. Written so that the next person does not have to rediscover any of
it.

---

## 1. The brief

> "A Keepa-equivalent for Mercado Livre, for the consumer side — tracking things
> I want to buy."

With an explicit instruction not to ask clarifying questions and to plan and
build. So the scope was inferred and stated rather than negotiated:

**In scope:** a personal watchlist of specific products; price history recorded
by the app itself; alerts on target price, percentage drops, all-time lows and
restock; a local web UI.

**Out of scope:** seller-side analytics, repricing, competitor research,
multi-user accounts, cloud hosting, anything requiring a paid data provider.

The single most important scoping decision was made first, because it determines
what the product *is*:

> **There is no historical price data available for Mercado Livre. The app must
> accumulate its own, starting on install day.**

This was surfaced to the user immediately rather than shipping a chart that
implies history it does not have. Everything downstream follows: the median needs
weeks to become meaningful, "all-time low" needs at least two observations, and
the first useful insight arrives after a few days of polling.

---

## 2. Decisions and why

### Self-accumulated history is not a limitation, it is the product

Keepa's value is its archive. MercadoTrack cannot have an archive, so its value
has to be *"the history of the items you actually care about, measured from
now"*. That reframing is why the chart, the median score and the low-water alerts
are the centre of the UI, and why nothing in the app pretends to know the past.

### Two sources, one interface

A real browser needs no credentials and always works — until markup changes. The
official API is stable but requires a developer account and OAuth. Both are
implemented behind `fetchForItem()`, defaulting to `auto` (API when configured,
browser otherwise). Neither is a fallback for the other's *errors* — a configured
API that fails fails loudly, because silent fallback makes you debug the wrong
adapter.

### `node:sqlite` instead of `better-sqlite3`

`better-sqlite3` needs a native build: a compiler, Python, and a rebuild after
every Node upgrade. For a tool that should be `git clone && npm install`, that is
an unacceptable failure mode. Node 22.5's built-in `node:sqlite` provides
`DatabaseSync` and `StatementSync` with a nearly identical API, zero compilation,
and one `ExperimentalWarning` (suppressed with `--no-warnings`).

### No frontend build step

The alternative is Vite + React + a charting library, which would mean a
`node_modules` of 300 MB and a build step between editing and seeing the result —
for one chart and a list. Hand-rolled SVG in vanilla JS is ~120 lines and starts
instantly. The trade-off is accepted knowingly: no component reuse, no types.

### Median, not mean

The "is this a good price?" signal compares today's price against the **median**
of the observed window. A single flash sale on a 90-day window can move an
average enough to make an obviously bad price look average; the median is
unmoved. This is a product decision encoded in `medianPrice()` and `stats.score`.

### Politeness over speed

Randomised cycle intervals (`pollMinutes` + jitter), randomised inter-item delays
(4–9 s), a fresh browser context per item, and per-item error-streak backoff. The
goal is a tracker that survives for months, not one that fetches 50 items in ten
seconds and gets challenged permanently.

### Fail loudly, never silently

The rule that shaped the schema: a failed lookup stores the item with a readable
`last_error` and a slug-derived title, and **never** stores a guessed price.
`snap.price == null` throws in the poller; `evaluate()` returns nothing for
`price <= 0`; adapters throw rather than returning `null`.

---

## 3. Reconnaissance

Before writing an adapter, every plausible data path was probed. This is the
evidence behind the architecture, and it is worth keeping because it explains why
the browser path is not over-engineering.

### Unauthenticated API

| Endpoint | Status | Body |
|---|---|---|
| `GET /sites` | `403` | `{"message":"forbidden"}` |
| `GET /sites/MLB` | `403` | `{"message":"forbidden"}` |
| `GET /sites/MLB/search` | `403` | `{"message":"forbidden"}` |
| `GET /sites/MLB/categories` | `403` | `{"message":"forbidden"}` |
| `GET /trends/MLB` | `403` | `{"message":"forbidden"}` |
| `GET /items/MLB1234` | `403` | `{"blocked_by":"PolicyAgent","code":"PA_UNAUTHORIZED_RESULT_FROM_POLICIES"}` |
| `GET /items?ids=...` | `401` | — |
| `GET /products/MLB1234` | `401` | `{"code":"unauthorized","message":"authorization value not present"}` |

The distinction between `403 blocked_by PolicyAgent` and `401 authorization value
not present` is the crucial finding: `/products/*` is **not** IP-blocked, it
simply requires a token. That single row is what makes the optional API path
viable at all.

Adding browser-ish headers (`Origin`, `Referer`, `Accept-Language`) changed
nothing — the block is at the policy layer, not the header layer.

### HTML

| Request | Result |
|---|---|
| `lista.mercadolivre.com.br/...` | `302` → `/gz/account-verification` |
| `www.mercadolivre.com.br/p/MLB1234` | `200`, body is a `suspicious-traffic-frontend` proof-of-work challenge shell |
| Googlebot user agent | `200`, 11,524 bytes, `<title>` present, **no prices** |

The Googlebot attempt is worth remembering: it returns a *valid-looking page*
with a title and no prices. Any scraper that trusts a `200` would store nothing
or, worse, a partial record. This is precisely why the adapters throw when a
price is missing instead of storing `null`.

**Conclusion:** only a real browser that executes the challenge script gets a
price. Hence Playwright, `domcontentloaded`, and a 2.5 s wait for the challenge
to resolve.

---

## 4. Bugs found during the build

Each of these was found by testing, not by reading. They are documented because
they are the non-obvious failure modes of this problem domain.

### `parsePrice` misread Brazilian thousands separators

```js
parsePrice('R$ 1.234')  // was → 1.234     (a 1000× error)
parsePrice('1.299')     // was → 1.299
parsePrice('R$ 0')      // was → 0         (accepted as a price)
```

The old implementation treated the last separator as a decimal point
unconditionally. In BRL, a dot followed by exactly three digits is a thousands
separator. The fix encodes the full decision table (see
[`SOURCES.md`](SOURCES.md#parseprice--the-subtle-one)) and rejects
non-positive values.

This is the highest-severity bug found: it would have recorded a R$ 1.234,00
product as R$ 1,23 and then alerted the user about a 99.9% drop.

### `titleFromUrl` returned `null` for `/p` URLs

URLs ending in `/p` (the product-page form) produced no usable slug, so items
added that way got a bare id as a title. Rewritten to score every path segment
and keep the most descriptive remainder, with the id as the last resort.

### `bin/add.mjs` mis-parsed flags before the positional argument

`add --target 299 <url>` failed because the parser filtered flags by index. Now a
scanning `positional()` helper consumes flag/value pairs and returns the first
true positional, so flag order no longer matters.

### Server and poller could hang forever on a browser launch failure

A failed Chromium launch left both the `/api/items` add route and the poll cycle
waiting indefinitely. Fixed by introducing `lib/util.mjs` (`withTimeout`,
`TimeoutError`) and bounding both the poller's item fetch
(`timeoutSeconds + 30 s`) and the add route (`timeoutSeconds + 20 s`). The
30/20 s asymmetry is deliberate: the poller can afford to wait longer, the add
request is interactive.

### The add route fell back to a bare ID as a title

`snap?.title || target.id` produced `MLB3554042705` as a title when the lookup
failed. Now: `snap?.title || body.title || titleFromUrl(target.url) || target.id`,
so a failed lookup still yields something human-readable.

---

## 5. What was verified

| Area | Method | Result |
|---|---|---|
| `parsePrice` / `parseTarget` | 18 assertions | all pass after the fixes above |
| Database + alerts | scripted suite | stats (n=4, min 3600, max 4000, median 3850), `new_low`, `target`, `drop` at 11.1% but not 3.9%, `back_in`, cooldown suppression, cascade delete |
| Error streak | scripted suite | increments 1→2→3, item deactivates at `maxErrorStreak`, `runOnce` skips inactive items |
| Frontend | `happy-dom` with 181 seeded snapshots | 31 plotted points in the 30d view, valid SVG `d` (327 chars), 6 stat cards, score "23.5% abaixo da mediana", **zero runtime errors** |
| HTTP surface | curl | `/`, `/styles.css`, `/app.js`, `/api/status`, `/api/items`, `/api/alerts` all `200` |

### What was **not** verified

**The scraper's selectors have never run against live Mercado Livre markup.**

Chromium could not be launched in the build environment: `codesign_util.cc:
SecCodeCheckValidity` failed, followed by a mach-port bootstrap failure
(`Permission denied (1100)`, `KERN_FAILURE`). So the JSON-LD and DOM extraction
layers were written from the known structure of the page and unit-tested only
through `parsePrice`.

This is the single open risk in the project, and it is why the extraction is
split into layers: if the DOM selectors are wrong, the JSON-LD layer may still
work, and if both are wrong the fix is confined to one file. See
[`ROADMAP.md`](ROADMAP.md).

---

## 6. Lessons worth carrying forward

1. **Probe before you architect.** The whole design pivoted on one HTTP status
   code (`401` vs `403` on `/products`). Ten minutes of `curl` saved a rewrite.
2. **A `200` is not a success.** The Googlebot page was a valid document with no
   data in it. Validate *content*, not status codes.
3. **Put the "no data" case in the schema, not in the caller.** `price` is
   nullable in `snapshots` but the poller throws before writing `null` — the
   decision lives in one place.
4. **Ordering bugs are invisible.** `evaluate()` before `addSnapshot()` looks
   arbitrary and is load-bearing. It needed a comment, not a convention.
5. **Kill your stale processes.** Multiple hours were lost to orphaned servers on
   old ports serving old code. `pkill -9 -f server.mjs` before every run.
6. **Fixed sleeps are not laziness.** The 2500 ms wait is the challenge-solving
   window. Every "optimisation" that removes it turns a working scraper into a
   broken one.
7. **A demo seed pays for itself.** `bin/seed.mjs` with 181 synthetic snapshots
   made the frontend testable before a single real price had been recorded — and
   it caught the chart bug immediately.

---

## 7. Timeline of the build

| Phase | Work |
|---|---|
| 1 | Scoping and the "no backfill" decision, stated to the user upfront |
| 2 | Endpoint and HTML reconnaissance; the browser-only conclusion |
| 3 | Storage layer, config, target parsing |
| 4 | Browser adapter, `parsePrice`, the price-format bugs |
| 5 | Alert engine, poller, notifications, backoff |
| 6 | HTTP server, then the UI and the SVG chart |
| 7 | Test suites, the frontend `happy-dom` test, the timeout and title fixes |
| 8 | Documentation, packaging |
