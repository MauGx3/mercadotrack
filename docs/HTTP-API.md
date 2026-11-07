# HTTP API Reference

The server is a plain `node:http` server — no Express, no middleware chain, no
CORS. It binds to **`127.0.0.1` only**, so nothing is exposed to your network.

- Default base URL: `http://localhost:4747`
- Port override: `MT_PORT` env var, or `port` in `config.json`
- Request bodies: JSON, **max 1 MB** (larger requests are rejected)
- Responses: JSON with `Cache-Control: no-store`
- `/api/*` requires a loopback `Host` (`localhost`, `127.0.0.1`, `[::1]`), and
  writes that carry an `Origin` header must come from a loopback origin.
  Anything else gets `403`. This blocks other websites (cross-site requests,
  DNS rebinding) from driving the API through your browser.
- Errors: `{ "error": "mensagem" }` with a 4xx/5xx status. Messages are in
  Portuguese because they are rendered directly in the UI.

## Route table

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/status` | App + scheduler state |
| `GET` | `/api/items` | Watchlist with computed stats |
| `POST` | `/api/items` | Add by URL or MLB id |
| `GET` | `/api/items/:id` | One item + full history |
| `PATCH` | `/api/items/:id` | Edit target, drop %, alerts, title, pause |
| `DELETE` | `/api/items/:id` | Remove item (cascades) |
| `POST` | `/api/items/:id/check` | Poll one item now |
| `POST` | `/api/check-all` | Poll the whole watchlist now |
| `GET` | `/api/alerts` | Last 100 alerts |
| `POST` | `/api/alerts/seen` | Clear the unread badge |
| `GET` | `/api/search?q=` | Search Mercado Livre, returns candidates |
| `POST` | `/api/scheduler` | `{"action":"start"\|"stop"}` |
| `GET` | `/*` | Static files from `public/` |

---

## `GET /api/status`

```json
{
  "source": "browser",
  "configuredSource": "auto",
  "pollMinutes": 60,
  "itemCount": 4,
  "unseenAlerts": 2,
  "scheduler": {
    "running": true,
    "nextRunAt": "2026-11-01T14:20:00.000Z",
    "lastRunAt": "2026-11-01T13:19:00.000Z",
    "lastRunMs": 18422,
    "lastResult": { "ok": 4, "failed": 0, "alerts": 1 }
  },
  "telegram": false
}
```

`source` is the **resolved** adapter (`browser` or `api`); `configuredSource` is
what `config.json` asked for (`auto`, `browser`, `api`). When `auto` cannot
resolve to `api` — no client id — it falls back to `browser`.

`scheduler.running` is derived from `state.nextRunAt`, not from a separate flag,
so it cannot drift out of sync with the actual timer.

---

## `GET /api/items`

```json
{
  "items": [
    {
      "id": 1,
      "ml_id": "MLB3554042705",
      "url": "https://www.mercadolivre.com.br/...",
      "title": "Fone Bluetooth Over-Ear",
      "image": "https://http2.mlstatic.com/...",
      "seller": "LOJA123",
      "currency": "BRL",
      "target_price": 299,
      "drop_pct": 10,
      "alert_low": 1,
      "active": 1,
      "created_at": "2026-10-02T11:00:00.000Z",
      "last_checked": "2026-11-01T13:19:00.000Z",
      "last_error": null,
      "error_streak": 0,

      "currentPrice": 329.9,
      "listPrice": 399,
      "available": true,
      "freeShipping": true,
      "lastChecked": "2026-11-01T13:19:00.000Z",

      "stats": {
        "n": 181,
        "min": 289.9,
        "max": 449,
        "avg": 351.2,
        "median": 339.9,
        "firstTs": "2026-05-04T12:00:00.000Z",
        "lastTs": "2026-11-01T13:19:00.000Z",
        "score": 2.94
      }
    }
  ]
}
```

### The computed fields

`withStats()` decorates every stored row before it leaves the server. The UI
never has to derive anything, which keeps `app.js` dumb and the numbers
consistent between the list, the detail view and the alert messages.

| Field | Derivation |
|---|---|
| `currentPrice` | `price` of the newest snapshot |
| `listPrice` | `list_price` of the newest snapshot ("de R$ X") |
| `available` | newest snapshot's `available === 1`, `null` if no snapshots |
| `freeShipping` | newest snapshot's `free_shipping === 1` |
| `lastChecked` | newest snapshot `ts`, falling back to `last_checked` |
| `stats.n` | count of snapshots with a usable price |
| `stats.min/max/avg` | SQL aggregate over the same set |
| `stats.median` | computed in JS (SQLite has no `MEDIAN`) |
| `stats.score` | `clamp((median - current) / median * 100, -100, 100)` |

`score` is the whole point of the app in one number: **positive = today's price
is below the observed median**, negative = above it. It is `null` when there is
no current price or no median yet (first observation). It is clamped so a single
absurd snapshot cannot produce a 4000% "deal".

---

## `POST /api/items`

Adds an item. Accepts either `url` or `query`.

```json
{ "url": "https://produto.mercadolivre.com.br/MLB-3554042705-fone...", "targetPrice": 299, "dropPct": 10 }
```

```json
{ "query": "MLB3554042705" }
```

Optional fields: `title`, `targetPrice`, `dropPct`.

**Behaviour.** The server performs a *synchronous best-effort lookup* before
storing, so the user gets a real title and a first price immediately instead of
a row that says "MLB3554042705". That lookup is bounded
(`timeoutSeconds + 20s`), and if it fails:

- the item is still created,
- `lookupError` is returned in the response,
- `last_error` is **not** set (that field is reserved for the poller),
- the title falls back through `snap.title → body.title → titleFromUrl(url) → target.id`.

Responses:

- `201` — created
- `200` — already tracked (`ml_id` existed), now updated
- `400` — empty input, or a URL that `parseTarget()` cannot read

```json
{ "item": { …withStats… }, "created": true, "lookupError": null }
```

---

## `GET /api/items/:id`

```json
{
  "item": { …withStats… },
  "history": [
    { "ts": "2026-05-04T12:00:00.000Z", "price": 349.9, "listPrice": 399, "available": true }
  ]
}
```

The history array is **the entire series, ascending** — no server-side
downsampling. Downsampling happens in the browser (`app.js` picks the range and
buckets), because the client already has every point it could ever ask for and a
round trip per range change would be slower for a few thousand rows.

---

## `PATCH /api/items/:id`

Partial update. Only the keys present in the body are touched.

```json
{ "targetPrice": 250, "dropPct": 15, "alertLow": false, "active": true, "title": "Fone — presente" }
```

- `targetPrice` / `dropPct`: `null` or `""` clears the rule.
- `alertLow`, `active`: coerced to `0`/`1`.
- `title`: ignored when empty (a blank title would break the UI).

Returns `{ item: …withStats… }`, or `404`.

---

## `DELETE /api/items/:id`

```json
{ "ok": true }
```

Always returns `ok`, even for an unknown id — deletion is idempotent. Snapshots
and alerts go with it via `ON DELETE CASCADE`.

---

## `POST /api/items/:id/check`

Polls one item immediately.

- `200` on success: `{ "ok": true, "price": 329.9, "alerts": [...], "item": {...} }`
- `502` on failure: `{ "ok": false, "error": "...", "item": {...} }`

`notifyUser: false` is passed here on purpose: a manual check from the UI should
update the screen, not fire a desktop banner at the user who is already looking
at it. Scheduled polls use `notifyUser: true`.

---

## `POST /api/check-all`

Runs the poller's `runOnce()` inline and returns the refreshed list:

```json
{ "ok": 3, "failed": 1, "alerts": 2, "items": [ …withStats… ] }
```

This request is **long-lived** — it holds until every item has been fetched,
including the randomised 4–9 s gap between items. With 10 items that is over a
minute. The UI shows a spinner and does not let you fire it twice.

---

## `GET /api/alerts`

```json
{
  "alerts": [
    {
      "id": 12,
      "item_id": 1,
      "ts": "2026-11-01T13:19:00.000Z",
      "kind": "new_low",
      "message": "Novo menor preço: R$ 289,90 (antes R$ 329,90)",
      "price": 289.9,
      "seen": 0,
      "title": "Fone Bluetooth Over-Ear",
      "url": "https://..."
    }
  ]
}
```

Joined with `items` so the UI can render the feed without a second request.
Capped at 100 — the feed is a notification list, not an audit log.

## `POST /api/alerts/seen`

`{ "ok": true }`. Bulk-sets `seen = 1`.

---

## `GET /api/search?q=fone+bluetooth`

Returns candidate listings so the user can pick one instead of pasting a URL.

```json
{
  "source": "browser",
  "results": [
    {
      "title": "Fone Bluetooth Over-Ear",
      "price": 329.9,
      "listPrice": 399,
      "url": "https://produto.mercadolivre.com.br/MLB-3554042705-...",
      "image": "https://http2.mlstatic.com/...",
      "freeShipping": true
    }
  ]
}
```

There is no `id` field: the adapter deliberately returns only what it can read
reliably, and the client re-submits the chosen `url` to `POST /api/items`, which
resolves the id itself. Cards without a readable price or link are filtered out
server-side (`.filter(i => i.price && i.url)`), so the array never contains a
"R$ —" row.

`502` with `{ error }` when the search itself fails (challenge page, network,
timeout). Search is best-effort: an empty array is a valid answer, a thrown
error is not swallowed.

---

## `POST /api/scheduler`

```json
{ "action": "stop" }
```

`start` (or any other value) restarts the timer and returns
`{ running: true, nextRunAt }`. Useful for pausing polling while you debug a
source without editing `config.json` and restarting.

---

## Static files

`public/` is served with an explicit MIME map and a containment check:

```js
const filePath = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
if (!filePath.startsWith(PUBLIC)) return 403;
```

Path traversal is blocked by both the normalisation and the prefix check.
Unknown paths return a plain-text `404`, not the SPA shell, so a typo in an API
path fails loudly. `HEAD` is served too — headers only, no body.

---

## Error handling

Every handler is wrapped by the dispatcher:

```js
catch (err) {
  console.error(`[http] ${req.method} ${pathname}: ${err.message}`);
  if (!res.headersSent) json(res, 500, { error: err.message });
  else res.end();
}
```

`headersSent` matters: `/api/check-all` can fail after the response has started
in a streaming future, and re-writing headers would throw a second error on top
of the first.

## Adding a route

```js
route('GET', /^\/api\/items\/(\d+)\/export$/, async (_req, res, [id]) => {
  json(res, 200, { csv: toCsv(history(Number(id))) });
});
```

Pattern captures arrive as the third argument, already `string[]`. Order matters
— routes are matched top to bottom, so put `/api/items/:id/check` **before** any
broader `/api/items/:id` pattern if you ever switch to non-anchored regexes.
