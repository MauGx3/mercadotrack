# Configuration Reference

All configuration lives in **`config.json` at the project root**. It is created
on demand and is gitignored, because it holds OAuth tokens and a Telegram bot
token.

Precedence, lowest to highest:

1. `DEFAULTS` in `lib/config.mjs`
2. `config.json`
3. environment variables

Merging is **deep** for nested objects (`notify`, `ml`), so setting only
`notify.telegram.botToken` in `config.json` keeps the other defaults.

If `config.json` is not valid JSON, the app logs
`[config] <path> is not valid JSON: ...` and continues with defaults rather than
crashing — a typo should not take the whole tracker offline.

---

## Full reference

```jsonc
{
  "pollMinutes": 60,          // how often every item is re-checked
  "jitterMinutes": 10,        // random 0..jitter added to each cycle
  "delayBetweenItems": [4, 9],// seconds, randomised, between items in a cycle
  "source": "auto",           // "auto" | "browser" | "api"
  "timeoutSeconds": 60,       // per-page budget
  "maxErrorStreak": 8,        // consecutive failures before auto-pause
  "alertCooldownHours": 12,   // min gap between repeats of the same alert kind
  "port": 4747,

  "notify": {
    "desktop": true,
    "telegram": { "enabled": false, "botToken": "", "chatId": "" }
  },

  "ml": {
    "clientId": "",
    "clientSecret": "",
    "accessToken": "",
    "refreshToken": "",
    "tokenExpiresAt": null    // written back automatically after a refresh
  }
}
```

### `pollMinutes` / `jitterMinutes`

The scheduler sleeps `pollMinutes + random(0, jitterMinutes)`. With the defaults
that is a 60–70 minute cycle, so a market full of users does not all hit
Mercado Livre on the same minute. The jitter is applied **per cycle**, not once
at startup, so cycles drift naturally.

### `delayBetweenItems`

`[min, max]` in seconds. Each item fetch is followed by a randomised pause in
that range. This is the single most important politeness knob: without it, ten
items would be fetched within a second and the account/IP would look like a
crawler immediately.

Raising it is always safe. Lowering it below ~2 s is how you get challenged.

### `source`

| Value | Behaviour |
|---|---|
| `auto` (default) | Use `api` when credentials exist, otherwise `browser`. |
| `browser` | Always scrape with Playwright. No credentials needed. |
| `api` | Always use `api.mercadolibre.com`. Throws a clear error if unconfigured. |

### `timeoutSeconds`

Budget for a single page load / API call. The poller adds 30 s of slack on top
(`ITEM_TIMEOUT_MS = timeoutSeconds * 1000 + 30_000`) so the timeout fires after
the source's own internal wait, not during it. Without that slack, a slow page
would be reported as a hard failure even though the source was about to succeed.

### `maxErrorStreak`

After this many consecutive failures an item is set to `active = 0` and stops
being polled. Nothing is deleted — the history is preserved and you can
re-enable the item from the UI or with a `PATCH`.

Why 8 rather than 3: a legitimately delisted item, a temporary challenge page and
a network hiccup are indistinguishable from the outside. 8 failures at one poll
per hour means roughly half a day of consistent failure before we give up — long
enough to ride out a challenge, short enough to stop wasting cycles.

### `alertCooldownHours`

The same alert kind will not fire twice for the same item inside this window.
Without it, an item hovering around its all-time low would produce an alert every
single hour. See [`ALERTS.md`](ALERTS.md).

### `notify.desktop`

Sends a banner through `osascript`, which means **macOS only**. There is no
`process.platform` guard: on Linux or Windows the `osascript` call fails, the
failure is logged as `[notify] desktop failed: ...` and the poll carries on.
Harmless, but noisy — set `notify.desktop: false` there and rely on Telegram.

Manual checks from the UI pass `notifyUser: false` so you do not get banners for
actions you just triggered.

### `notify.telegram`

When `enabled` and both `botToken` and `chatId` are set, alerts are also sent to
Telegram. Get a token from [@BotFather](https://t.me/BotFather); get your chat id
by messaging the bot and reading
`https://api.telegram.org/bot<TOKEN>/getUpdates`.

Telegram failures are logged, never thrown — a notification channel being down
must not make the poll itself look failed.

### `ml.*`

OAuth credentials for the official API path. `tokenExpiresAt` is a **timestamp
written back to `config.json`** by `saveConfig()` after every refresh, so a
restart does not force a re-auth. The refresh happens 60 s before expiry to avoid
racing it.

---

## Environment variables

Useful for cron, containers and CI — anything you would rather not write to disk.

| Variable | Overrides |
|---|---|
| `MT_PORT` | `port` |
| `MT_SOURCE` | `source` |
| `MT_POLL_MINUTES` | `pollMinutes` |
| `MT_DB` | Database path (`lib/db.mjs`) |
| `MT_CONFIG` | Config file path |
| `ML_CLIENT_ID` | `ml.clientId` |
| `ML_CLIENT_SECRET` | `ml.clientSecret` |
| `ML_ACCESS_TOKEN` | `ml.accessToken` |
| `ML_REFRESH_TOKEN` | `ml.refreshToken` |
| `TELEGRAM_BOT_TOKEN` | `notify.telegram.botToken` **and** forces `enabled = true` |
| `TELEGRAM_CHAT_ID` | `notify.telegram.chatId` |

Note the asymmetry: setting `TELEGRAM_BOT_TOKEN` implies opt-in, because anyone
who exports a bot token clearly wants alerts.

---

## Recipes

**Faster polling while testing a new selector**

```bash
MT_POLL_MINUTES=2 MT_PORT=4800 npm start
```

**Throwaway database for experiments**

```bash
MT_DB=/tmp/mt-test.db npm start
```

This is the cleanest way to reproduce a bug from scratch without touching real
history — and the recommended first step in
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

**Run headless from cron instead of keeping the server up**

```cron
0 * * * * cd /path/to/mercadotrack && /usr/local/bin/node bin/check.mjs >> data/cron.log 2>&1
```

`bin/check.mjs` runs exactly one cycle and exits, so it is safe under cron. Use
either cron **or** the built-in scheduler, not both — two schedulers polling the
same items doubles your request rate and your snapshot density.
