# Alert Engine

`lib/alerts.mjs` decides whether a fresh snapshot deserves a notification. It is
a pure function over `(item, snapshot, prev)` — no I/O, no notifications — which
is why it is the easiest part of the codebase to test.

```js
evaluate(item, snapshot, prev) → [{ kind, message, price }]
```

`prev` is the snapshot *before* the incoming one. **`evaluate()` runs before the
new snapshot is inserted**, which is what makes `new_low` meaningful: it compares
today's price against the history that existed before today.

---

## The four rules

Evaluated in this order, all of them independently — a single poll can fire
several alerts.

### 1. `back_in` — back in stock

```js
if (prev && prev.available === 0 && snapshot.available !== false)
```

Fires when the previous observation was explicitly out of stock and the new one
is not. The `prev.available === 0` guard matters: it requires a *known*
transition, so an item whose stock state was never readable (`NULL`) does not
produce a "back in stock" on its first successful read.

Message: `"<title> está disponível de novo — R$ 289,90"`

### 2. `new_low` — all-time low

```js
if (stats.min != null && stats.n >= 2 && price <= stats.min)
```

- `stats.n >= 2` — you cannot have a "lowest ever" from a single observation.
  This is the guard that stops the very first snapshot from announcing a record.
- `price <= stats.min` — equality counts, so a price that sits flat at its low
  still qualifies (subject to cooldown).

Message: `"Menor preço já registrado: <title> — R$ 289,90"`

### 3. `target` — user's target price

```js
if (item.target_price && price <= item.target_price)
```

The user's own threshold. Fires on every poll below the target, so the cooldown
does the rate limiting.

Message: `"<title> atingiu seu alvo: R$ 250,00 (alvo R$ 299,00)"`

### 4. `drop` — percentage fall

```js
const pct = ((prev.price - price) / prev.price) * 100;
if (pct >= item.drop_pct)
```

Compares against the **previous snapshot only**, not the median. This is a
"something just happened" signal, deliberately different from the median-based
`stats.score` in the UI, which is a "where are we historically" signal. Mixing
the two is the most common source of confusion when extending this file.

Message: `"<title> caiu 12,5% — R$ 262,50 (era R$ 300,00)"`

---

## Cooldown

```js
const cooldownSince = new Date(Date.now() - COOLDOWN_HOURS() * 3600 * 1000).toISOString();
const cooled = (kind) => !alertedSince(item.id, kind, cooldownSince);
```

The cooldown is **per item, per kind** — `alertedSince(itemId, kind, since)`
queries the `alerts` table. A price hovering at its all-time low therefore
notifies at most once per `alertCooldownHours` (default 12), while still letting a
`target` alert through in the same window if that is genuinely new information.

Setting `alertCooldownHours: 0` disables rate limiting entirely. Useful while
debugging, dangerous in production.

---

## Formatting

All money is formatted with `Intl.NumberFormat('pt-BR', { style: 'currency' })`
and the messages are stored **pre-rendered** in the `alerts.message` column.

This is a deliberate trade-off: the text is frozen in Portuguese at the moment
the alert fires, so changing the UI language later will not retroactively
translate the feed. In exchange, the feed is a historical record of exactly what
the user was told, and the UI needs zero logic to render it.

If you add internationalisation, store `kind` + `price` + `ref_price` and render
on the client, keeping `message` as a fallback for old rows.

---

## Delivery

`recordAlerts()` persists first, then the poller notifies:

```js
const alerts = recordAlerts(item, evaluate(item, snap, prev));
```

Notification failures are swallowed and logged by `lib/notify.mjs` — a dead
Telegram bot must never make a successful poll look like a failure. This is the
same principle as `last_error`: infrastructure problems get their own channel,
they do not corrupt the data.

---

## Manual checks are quiet

`POST /api/items/:id/check` calls `checkItem(item, { notifyUser: false })`.
You are already looking at the screen; a desktop banner for an action you just
clicked is noise. The alert rows are still written, so the feed stays complete.

---

## Testing this module

`evaluate()` is pure, so tests are direct. The scenarios worth covering (all were
verified during the build):

| Scenario | Expectation |
|---|---|
| first snapshot, no history | no `new_low` (n < 2) |
| price below all history | `new_low` |
| price equal to history minimum | `new_low` |
| price ≤ `target_price` | `target` |
| price 11.1% below previous, `drop_pct: 10` | `drop` |
| price 3.9% below previous, `drop_pct: 10` | no `drop` |
| `prev.available = 0`, now available | `back_in` |
| two identical events inside cooldown | second suppressed |
| `price: 0` or `null` | nothing at all |

The last row is why `evaluate()` starts with:

```js
if (price == null || price <= 0) return fired;
```

A zero price is never a deal. It is a parse failure that slipped through, and it
must not reach the user as a 100%-off notification.
