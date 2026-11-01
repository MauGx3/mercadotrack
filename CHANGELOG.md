# Changelog

All notable changes to this project. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`0.x` means the schema and the HTTP surface may still change between minor
versions. The `snapshots` table is the part that cannot be regenerated, so any
change to it will be additive and announced here.

---

## [Unreleased]

### Added

- Documentation set: architecture, data model, sources, alerts, HTTP API,
  configuration, development guide, development history, roadmap.
- Portuguese README (`README.pt-BR.md`) alongside the English one.

### Known issues

- The browser adapter's JSON-LD and DOM extraction layers have not been executed
  against live Mercado Livre markup — Chromium could not launch in the
  environment where the project was built. See
  [Roadmap P0](docs/ROADMAP.md#p0--prove-the-scraper).

---

## [0.1.0] — 2026-11-01

First working version: a local watchlist with self-accumulated price history,
four alert kinds and a hand-rolled SVG chart.

### Added

- **Watchlist** — add by product URL, `MLB` id, or search result. Items are
  stored even when the initial lookup fails, with a title derived from the URL
  slug and a readable error.
- **Price history** — one snapshot per poll with price, list price, availability,
  free shipping, rating, review count and the source that produced it.
- **Charts** — SVG price chart with crosshair, tooltip and 7d / 30d / 90d / 1y /
  all-time ranges, rendered client-side from the full series.
- **Deal score** — current price versus the observed **median** (not mean),
  clamped to ±100%, so a single flash sale cannot distort the signal.
- **Alerts** — `new_low`, `target`, `drop`, `back_in`, each with a per-item,
  per-kind cooldown (`alertCooldownHours`, default 12).
- **Notifications** — macOS banners via `osascript`, plus optional Telegram.
- **Two data sources** — Playwright-driven real browser (default, no
  credentials) and the official `api.mercadolibre.com` path with automatic OAuth
  token refresh written back to `config.json`.
- **Scheduler** — `setTimeout` chain with per-cycle jitter, randomised 4–9 s gaps
  between items, and per-item error-streak backoff that pauses an item after
  `maxErrorStreak` consecutive failures.
- **Storage** — `node:sqlite` (built into Node 22.5+), WAL mode, foreign keys on,
  cascade delete. No native compilation, no database server.
- **CLI** — `bin/add.mjs` (with `--target`, `--drop`), `bin/check.mjs` for cron,
  `bin/list.mjs`, `bin/seed.mjs` for demo data.

### Fixed during development

- `parsePrice` read Brazilian thousands separators as decimals: `"R$ 1.234"` →
  `1.234` (a 1000× error) and `"1.299"` → `1.299`. Also accepted `0` as a valid
  price. Now follows an explicit decision table and rejects non-positive values.
- `titleFromUrl` returned `null` for URLs ending in `/p`, producing bare ids as
  titles. Now scores every path segment and keeps the most descriptive remainder.
- `bin/add.mjs` mis-parsed flags placed before the positional argument; replaced
  index filtering with a scanning `positional()`.
- The server and the poller could hang indefinitely on a browser launch failure.
  Added `lib/util.mjs` (`withTimeout`, `TimeoutError`) and bounded the poller's
  item fetch (`timeoutSeconds + 30 s`) and the add route
  (`timeoutSeconds + 20 s`).
- The add route could fall back to a bare `MLB…` id as a title; the fallback chain
  is now `snap.title → body.title → titleFromUrl(url) → id`.

### Verified

- `parsePrice` / `parseTarget`: 18 assertions.
- Database and alerts: stats (n=4, min 3600, max 4000, median 3850), `new_low`,
  `target`, `drop` at 11.1% but not 3.9%, `back_in`, cooldown suppression,
  cascade delete.
- Error backoff: streak increments, deactivation at `maxErrorStreak`, inactive
  items skipped by `runOnce`.
- Frontend: 181 seeded snapshots → 31 plotted points in the 30d view, valid SVG
  path, 6 stat cards, zero runtime errors.
- HTTP: `/`, `/styles.css`, `/app.js`, `/api/status`, `/api/items`,
  `/api/alerts` all `200`.

### Not verified

- Live scraping. See above.
