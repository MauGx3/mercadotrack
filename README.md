# MercadoTrack

**A Keepa for Mercado Livre — buyer's side.** Track the products you actually
want to buy, watch their price history build up over time, and get told when a
price is genuinely good instead of when a retailer says it is.

Runs entirely on your machine. One Node process, one SQLite file, no account, no
cloud, no telemetry.

```
┌──────────────────────────────────────────────────────────────┐
│  Fone Bluetooth Over-Ear                    R$ 329,90        │
│  ─────────────────────────────────────────────────────────   │
│  mediana  R$ 389,90    mínimo  R$ 289,90    nº 181           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                                    ╭─╮                 │  │
│  │        ╭──╮     ╭──╮              ╱   ╲    ╭─╮         │  │
│  │   ╭────╯  ╰─────╯  ╰──────────────╯     ╰────╯ ╰───     │  │
│  │ ──┴───────────────────────────────────────────────────  │  │
│  └────────────────────────────────────────────────────────┘  │
│  7d   30d   90d   1y   tudo           23.5% abaixo da mediana│
└──────────────────────────────────────────────────────────────┘
```

---

## The one thing to understand first

**Mercado Livre does not publish price history.** There is no endpoint, no
archive, no backfill — this was verified endpoint by endpoint before a line of
code was written (see [the recon table](docs/SOURCES.md#the-bot-challenge-why-browser-is-the-default)).

So MercadoTrack records its own history, starting the day you add an item. That
has real consequences you should know about up front:

- The first day is useless. The second day is mildly interesting. After two
  weeks the median starts to mean something.
- "All-time low" needs at least two observations to exist.
- Deleting `data/mercado.db` deletes the only copy of that history. Back it up.

This is a tool for *deciding whether to buy*, not for researching the market's
past. If that is what you need, it will not get you there.

---

## What it does

- **Watchlist** — add by product URL, by `MLB` id, or by searching.
- **Price history** — one snapshot per poll, charted with 7d / 30d / 90d / 1y /
  all-time ranges.
- **Deal score** — today's price versus the **median** of the observed window,
  not the average (one flash sale should not make a bad price look average).
- **Four kinds of alerts** — target price, percentage drop, all-time low, back in
  stock.
- **Delivery** — macOS notification banners, and/or Telegram.
- **Failure visibility** — a failed lookup never becomes a wrong price. The item
  shows an error badge and keeps whatever title it had.
- **Politeness** — randomised intervals, randomised gaps between items,
  per-item error backoff that pauses an item after repeated failures.

## What it does not do

- Backfill history (impossible — see above).
- Track sellers, competitors, or categories. This is the buyer's side.
- Run as a service on a server for multiple people. It binds to `127.0.0.1`.

---

## Requirements

- **Node ≥ 22.5** — for the built-in `node:sqlite`. No native compilation, no
  database server.
- **Google Chrome** (optional but recommended) — if present, Playwright drives
  your installed Chrome instead of downloading a 150 MB Chromium.

## Quick start

```bash
git clone https://github.com/MauGx3/mercadotrack.git
cd mercadotrack
npm install
npm run setup      # downloads the Chromium build Playwright expects
npm start          # → http://localhost:4747
```

Then paste a Mercado Livre product URL into the box at the top.

Want to see the chart before you have any history?

```bash
npm run seed             # demo item with 181 synthetic snapshots
npm run seed -- --clear
```

---

## Usage

### From the UI

Add a URL or `MLB` id, or use the search box. Click an item to open its history,
set a target price, set a drop percentage, pause it, or check it immediately.

### From the terminal

```bash
node bin/add.mjs https://produto.mercadolivre.com.br/MLB-3554042705-fone --target 299 --drop 10
npm run list
npm run check          # one poll cycle, then exit
```

`bin/check.mjs` is the cron entry point:

```cron
0 * * * * cd /path/to/mercadotrack && /usr/local/bin/node bin/check.mjs >> data/cron.log 2>&1
```

Use **either** cron **or** the built-in scheduler. Running both doubles your
request rate and your snapshot density.

---

## Configuration

`config.json` at the project root, created on demand and gitignored (it holds
tokens). Everything has a sane default:

```jsonc
{
  "pollMinutes": 60,
  "jitterMinutes": 10,
  "delayBetweenItems": [4, 9],
  "source": "auto",           // "auto" | "browser" | "api"
  "timeoutSeconds": 60,
  "maxErrorStreak": 8,
  "alertCooldownHours": 12,
  "port": 4747,
  "notify": { "desktop": true, "telegram": { "enabled": false, "botToken": "", "chatId": "" } }
}
```

Every key is documented in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md),
including environment-variable overrides (`MT_PORT`, `MT_DB`, `MT_POLL_MINUTES`,
`TELEGRAM_BOT_TOKEN`, …).

### The optional official API

The browser scraper needs no credentials, which is why it is the default. If you
would rather not scrape — or you poll many items — you can register a free
developer app and use `api.mercadolibre.com` instead:

1. Create an app at [developers.mercadolivre.com.br](https://developers.mercadolivre.com.br).
2. Exchange the authorisation code for tokens.
3. Put `clientId`, `clientSecret`, `accessToken`, `refreshToken` in `config.json`
   under `ml`, and set `"source": "api"`.

Tokens are refreshed automatically and written back to `config.json`. Full
walkthrough: [`docs/SOURCES.md`](docs/SOURCES.md#apimjs).

---

## Your data

| What | Where |
|---|---|
| Database | `data/mercado.db` (override with `MT_DB`) |
| Config + tokens | `config.json` (override with `MT_CONFIG`) |

Both are gitignored. To back up, copy the database — but stop the server first,
or copy the `-wal` and `-shm` files along with it:

```bash
pkill -f server.mjs
cp data/mercado.db ~/Backups/mercado-$(date +%F).db
```

To start over: delete `data/mercado.db`. To start over *safely*:
`MT_DB=/tmp/scratch.db npm start`.

---

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Process model, layers, request lifecycle, poll cycle, failure philosophy |
| [Data Model](docs/DATA-MODEL.md) | Schema, indexes, every exported query, migrations |
| [Data Sources](docs/SOURCES.md) | The bot challenge, scraping layers, `parsePrice`, the API path, adding an adapter |
| [Alerts](docs/ALERTS.md) | The four rules, cooldown, formatting, delivery |
| [HTTP API](docs/HTTP-API.md) | Every route with request/response examples |
| [Configuration](docs/CONFIGURATION.md) | Every key and env var, with recipes |
| [Development](docs/DEVELOPMENT.md) | Setup, conventions, testing, debugging, extension recipes |
| [Development History](docs/DEVELOPMENT-HISTORY.md) | Decisions, recon findings, bugs found, lessons |
| [Roadmap](docs/ROADMAP.md) | Known gaps, ordered by value |
| [Contributing](CONTRIBUTING.md) | How to send a change |

Leia em português: [`README.pt-BR.md`](README.pt-BR.md).

---

## Status and known limitations

Working end to end, with one unverified path:

- ⚠️ **The scraper's selectors have never run against live markup.** Chromium
  could not launch in the environment where this was built (code-signing failure),
  so the JSON-LD and DOM extraction layers are written from the page structure and
  unit-tested only through `parsePrice`. If the first fetch fails, the error
  message includes the page `<title>` — that identifies the cause in one line.
  See [`docs/ROADMAP.md`](docs/ROADMAP.md).
- Desktop notifications are macOS-only (`osascript`). On Linux/Windows use
  Telegram.
- No retention policy for snapshots. At one poll per hour that is ~8.8k rows per
  item per year — a few hundred KB, so it does not matter yet.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Mercado Livre. Scraping is subject to their terms of service;
this tool is rate-limited and personal-scale by design, but you are responsible
for how you use it.
