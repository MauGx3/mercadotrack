# Troubleshooting

Symptom first. Each entry says what it means and what to do.

---

## The app will not start

### `Cannot find module 'node:sqlite'` / `ERR_UNKNOWN_BUILTIN_MODULE`

Your Node is older than 22.5. Check with `node -v`.

```bash
node -v          # must be >= v22.5.0
```

Use `nvm install 22 && nvm use 22`, or install the current LTS. `engines` in
`package.json` only warns — npm does not enforce it without
`engine-strict=true`.

### `EADDRINUSE: address already in use :::4747`

Something else owns the port. Usually a stale copy of this app:

```bash
lsof -ti:4747 | xargs kill -9
```

or start on another port: `MT_PORT=4800 npm start`.

---

## Nothing is being scraped

### `Executable doesn't exist at .../chrome-headless-shell`

Playwright's pinned Chromium is not installed. This is expected on a fresh
machine:

```bash
npm run setup
```

If you have Chrome installed, the adapter normally falls back to it — but the
fallback only happens *after* the Playwright attempt fails, so you will still see
this message once in the logs.

### `Could not read a price (title: Just a moment...)`

The bot challenge was not cleared. The browser got the interstitial, not the
product page.

- Check you are not polling too fast: `delayBetweenItems` should be at least
  `[4, 9]`.
- Check the machine is not hammering the site from other tools.
- Confirm the waits in `lib/sources/browser.mjs` are intact (`2500` ms after
  `domcontentloaded`, `3000` ms before extraction). If you shortened them, put
  them back.

If it persists across many items and many hours, the challenge has changed and
the adapter needs work. See
[`docs/SOURCES.md`](docs/SOURCES.md#the-bot-challenge-why-browser-is-the-default).

### `Could not read a price (title: <normal product title>)`

The page loaded but the selectors no longer match — a markup change. The fix is
confined to the DOM layer of `lib/sources/browser.mjs`. Open the product page in
a real browser, inspect the price element, and add a selector to the front of the
priority list rather than replacing the existing ones (older selectors still work
on some page variants).

### `Página não encontrada` / 404

The listing is gone. Nothing to fix — delete or pause the item.

### Everything worked yesterday

Two usual causes: (1) a challenge triggered by too-frequent polling, (2) a markup
change. Distinguish them with the `<title>` in the error message.

---

## The item is there but nothing happens

### An item stopped updating and shows a red badge

It hit `maxErrorStreak` (default 8) consecutive failures and was auto-paused
(`active = 0`). The last error is in `last_error`:

```bash
sqlite3 data/mercado.db 'select title, error_streak, last_error from items where active = 0;'
```

Fix the underlying cause, then re-enable it from the UI or:

```bash
curl -X PATCH localhost:4747/api/items/1 -H 'content-type: application/json' -d '{"active":true}'
```

The streak resets on the next success.

### The chart is empty

Expected on a new item: history starts at zero and grows one point per poll. Use
`npm run seed` to see a populated chart, or wait for the first cycles.

If the chart is empty for an item that has been tracked for days:

```bash
sqlite3 data/mercado.db 'select count(*), min(ts), max(ts) from snapshots where item_id=1;'
```

No rows means every poll is failing — check `last_error`.

### The deal score says "coletando histórico"

`stats.score` is `null` until there is a median, which needs observations. Not a
bug.

---

## The UI is stale or the server behaves oddly

### I fixed the code and nothing changed

**You are almost certainly talking to a stale process.** This bit repeatedly
during development: orphaned `server.mjs` instances on old ports kept serving old
code.

```bash
pkill -9 -f server.mjs
lsof -ti:4747 | xargs kill -9
npm start
```

Also check you are not looking at a cached page — hard-reload, and note the API
sets `Cache-Control: no-store` but the HTML does not.

### The page is blank and the console shows a JS error

`public/app.js` is one self-contained module: a syntax error anywhere in it kills
the whole file and nothing renders. Open the console and read the *first* error —
it is almost always a stray character from an edit. Because the file imports
nothing, a failure cannot be blamed on module resolution.

### `/api/check-all` hangs for a minute

By design: it fetches every item with a randomised 4–9 s gap. With 10 items that
is over a minute. It is not stuck; watch the server log for per-item lines.

---

## Notifications

### No macOS banner appears

- Check **System Settings → Notifications** and make sure the app that owns
  `osascript` (usually Script Editor or Terminal) is allowed.
- Do Not Disturb / Focus mode silently suppresses banners.
- Manual checks from the UI deliberately do not notify (`notifyUser: false`).
  Only scheduled polls and cron notify.

Test the path directly:

```bash
osascript -e 'display notification "teste" with title "MercadoTrack"'
```

If that does nothing, the problem is macOS, not the app.

### Telegram messages never arrive

1. `notify.telegram.enabled` must be `true` **and** both `botToken` and `chatId`
   set. (Setting `TELEGRAM_BOT_TOKEN` in the environment enables it implicitly.)
2. Get the chat id by messaging the bot, then reading
   `https://api.telegram.org/bot<TOKEN>/getUpdates`.
3. A bot cannot message a user who has never started a conversation with it —
   send it `/start` first.
4. Failures are logged as `[notify] telegram failed: ...` and never thrown, so
   check the server log rather than expecting an error in the UI.

---

## Data problems

### `database is locked`

Another process holds a write lock — usually a second `server.mjs`, or a
`sqlite3` session with an open transaction. Close it. WAL mode allows many
readers and one writer, so concurrent reads are fine.

### I want to start over without losing the old data

```bash
pkill -f server.mjs
mv data/mercado.db data/mercado.backup.db
npm start
```

Never `rm` the database as a first move — the price history cannot be
regenerated.

### Timestamps look wrong

Everything is stored in UTC ISO-8601 and rendered in your local timezone by the
browser. A discrepancy of exactly your UTC offset means you are looking at raw
rows in `sqlite3`, which is correct behaviour.

### Prices look absurd (R$ 1,23 for a R$ 1.234 product)

A `parsePrice` regression. It is covered by the decision table in
[`docs/SOURCES.md`](docs/SOURCES.md#parseprice--the-subtle-one). Check
`snapshots.price` and `snapshots.source` for the affected rows; a wrong parse is
almost always a new page variant with an unexpected money format.

---

## Still stuck

Collect these four things before opening an issue — they identify almost every
problem:

```bash
node -v
node -e "const c=require('./config.json');console.log(c.source, c.pollMinutes, c.timeoutSeconds)"
sqlite3 data/mercado.db 'select id,title,active,error_streak,last_error from items;'
tail -50 data/cron.log 2>/dev/null || true
```

Plus the full error text, including the `(title: ...)` suffix.
