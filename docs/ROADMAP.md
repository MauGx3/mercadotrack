# Roadmap

Ordered by value, not by effort. The first two items are the difference between
"written" and "proven".

---

## P0 — Prove the scraper

### 1. Verify the extraction layers against live markup

**The single open risk in the project.** The JSON-LD and DOM layers in
`lib/sources/browser.mjs` have never executed against a real Mercado Livre page:
Chromium could not launch in the environment where the code was written
(`SecCodeCheckValidity` failure, then a mach-port bootstrap failure).

What to do:

```bash
npm run setup          # if Playwright's Chromium is missing
node --no-warnings -e "
  import('./lib/sources/browser.mjs').then(m => m.fetchProduct('https://produto.mercadolivre.com.br/MLB-...'))
    .then(console.log, console.error)"
```

Expect either a normalised object, or an error whose message ends with
`(title: ...)`.

| `<title>` in the error | Diagnosis | Action |
|---|---|---|
| `Just a moment...` / `suspicious-traffic` | Challenge not cleared | Increase the waits; do not reduce them |
| Normal product title | Selectors drifted | Update the DOM layer only |
| `Página não encontrada` | Listing gone | Correct behaviour — no fix |

Success criteria: `price` is a plausible number and `source` is
`browser:ld+json`. If only `browser:dom` works, the JSON-LD layer needs a fix but
the app is functional.

### 2. Implement the `__PRELOADED_STATE__` layer

`browser.mjs`'s header describes three extraction layers; only two exist. The
third — parsing the page's embedded preloaded state — is the most resilient of
the three, because it is data rather than presentation.

It belongs **between** JSON-LD and DOM: JSON-LD is a public contract, the
preloaded state is an implementation detail but far more stable than CSS classes,
and the DOM is the last resort.

Acceptance: `source: 'browser:preloaded'` appears in `snapshots.source` when the
other two fail, and `parsePrice` is reused for its money strings.

---

## P1 — Robustness

### 3. Retry a failed launch once, with a clear diagnostic

A transient browser launch failure currently fails the whole cycle. One retry
after a 2 s pause would absorb most of it. When both attempts fail, the error
should name the exact remedy (`npm run setup` vs "Chrome is running with a
profile lock").

### 4. `PRAGMA user_version` migrations

There is no schema version. Additive `ALTER TABLE` is the only safe change today.
A `user_version` plus a small migration array makes it possible to evolve the
schema without asking users to delete their history — which, given that history
cannot be backfilled, is the most destructive possible request.

### 5. Surface the error streak in the UI before auto-pause

An item pauses silently at 8 consecutive failures. The badge should show
`3/8 falhas` from the first failure, so a user notices *before* tracking stops.

### 6. Snapshot retention with downsampling

Not urgent (~8.8k rows/item/year), but the right shape matters: keep raw rows for
the last 90 days, then keep daily min/max/close forever. Never delete extrema —
the all-time-low alert and the chart both depend on them.

---

## P2 — Ergonomics

### 7. Replace the long-lived `/api/check-all` request

It holds the connection for over a minute with 10 items. Server-Sent Events would
stream per-item progress and keep the UI honest about what is happening. Current
behaviour (spinner, no double-fire) is correct but opaque.

### 8. Remove the dynamic imports in `POST /api/items`

`server.mjs` imports `fetchForItem` and `addSnapshot` inside the handler. Hoist
them to the top — the dynamic form hides the dependency and costs a module
lookup per add.

### 9. Export history

CSV or JSON per item, so the data is not trapped in a SQLite file. This matters
because the history is irreplaceable.

### 10. Telegram `test` command

`node bin/notify-test.mjs` sending one message would remove the most common
setup question ("did it work?").

### 11. Store alert data structurally, render on the client

`alerts.message` is pre-rendered Portuguese. Storing `kind`, `price` and
`ref_price` (already there) and rendering in `app.js` would make the feed
translatable and keep `message` as a fallback for old rows.

---

## P3 — Scope extensions (deliberately deferred)

- **Other Mercado Livre sites** (`MLM`, `MLA`, …). `parseTarget` and the search
  URL are Brazil-specific. The schema already stores `currency`, so the data
  model does not need to change.
- **Category-level tracking** ("alert me when any 65" OLED drops below X"). Would
  need a second entity and a search-driven poll; a different product, really.
- **Multi-user.** The single-process, single-database, `127.0.0.1` design is a
  feature. Do not change it in place.

---

## Explicitly not planned

- **Buying automation.** The tool informs a decision; it does not make one.
- **Seller-side analytics or repricing.** Different product, different ethics.
- **Buying historical data from a third party.** That is Keepa's business, not
  this one's.
- **Reducing the politeness delays for speed.** Every one of them exists because
  the alternative is a permanent challenge page. If you want throughput, use the
  official API.
