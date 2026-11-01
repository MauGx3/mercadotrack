# Data Model

MercadoTrack stores everything in a single SQLite database. There is no ORM, no
migration framework and no native dependency: the driver is `node:sqlite`, which
ships inside Node 22.5+.

- **Default path:** `data/mercado.db` (relative to the project root).
- **Override:** set `MT_DB=/absolute/path/to/file.db`.
- The directory is created on first import if it does not exist.
- The database is opened in **WAL** mode with **`foreign_keys = ON`** so the
  `ON DELETE CASCADE` rules actually fire.

Two `node:sqlite` quirks leak into the code and are worth knowing before you
touch it:

1. JS booleans are **not** accepted as bound parameters — store `0`/`1`
   integers and normalise at the edges (`available`, `free_shipping`,
   `alert_low`, `active`, `seen`).
2. Integers come back as JS numbers, so `!!row.active` is the safe read.

---

## Entity overview

```
items ──1:N──> snapshots      one price observation per poll
  │
  └───1:N──> alerts           events derived from snapshots
```

Deleting an item cascades to both children. There is no soft delete — the
`active` flag is used for "paused", not for deletion.

---

## `items` — the watchlist

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | Internal id, used in URLs (`/api/items/7`). |
| `ml_id` | TEXT UNIQUE | Mercado Livre id (`MLB1234567890`). `NULL` is allowed for items added by raw URL that were never resolved to an id. |
| `url` | TEXT | The canonical product URL. |
| `title` | TEXT NOT NULL | User-editable. Never overwritten once set. |
| `image` | TEXT | Thumbnail URL, filled from the first successful scrape. |
| `seller` | TEXT | Seller nickname, filled from the first successful scrape. |
| `currency` | TEXT DEFAULT `'BRL'` | |
| `target_price` | REAL | "Tell me when it drops to this price." `NULL` = no target. |
| `drop_pct` | REAL | "Tell me when it drops by this percentage." `NULL` = disabled. |
| `alert_low` | INTEGER DEFAULT `1` | Enable the all-time-low alert. |
| `active` | INTEGER DEFAULT `1` | `0` = paused. The poller skips paused items **and** auto-pauses items that exceed the error streak. |
| `created_at` | TEXT NOT NULL | ISO-8601 UTC. |
| `last_checked` | TEXT | ISO-8601 UTC of the last attempt (success **or** failure). |
| `last_error` | TEXT | `NULL` on success. Human-readable message on failure. |
| `error_streak` | INTEGER DEFAULT `0` | Consecutive failures. Reset to `0` on any success. |

**Why `last_error` lives on the item.** A failed lookup must never be silent and
must never be papered over with a stale price. The item stays in the list, shows
a red badge in the UI, and keeps whatever title it had (falling back to a title
derived from the URL slug when the very first lookup failed).

**Why `ml_id` is nullable-but-unique.** SQLite treats `NULL`s as distinct in a
`UNIQUE` column, which is exactly what we want: two unrelated URL-only items do
not collide, but two rows for `MLB1234` cannot exist.

---

## `snapshots` — the price history

This is the core of the app. **Every row is something we observed ourselves.**
There is no backfill: Mercado Livre exposes no historical price endpoint, so the
history starts on the day the item was added.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `item_id` | INTEGER NOT NULL → `items.id` ON DELETE CASCADE | |
| `ts` | TEXT NOT NULL | ISO-8601 UTC observation time. |
| `price` | REAL | Observed price. `NULL` is tolerated but excluded from stats. |
| `list_price` | REAL | "De R$ X" crossed-out price, when the listing shows one. |
| `available` | INTEGER DEFAULT `1` | |
| `free_shipping` | INTEGER | Tri-state: `1`, `0`, or `NULL` (unknown). |
| `rating` | REAL | Average review score, when present. |
| `reviews` | INTEGER | Review count, when present. |
| `source` | TEXT | Which adapter produced it: `browser` or `api`. Essential when debugging a source-specific regression. |

Index: `idx_snap_item_ts ON snapshots(item_id, ts)` — every read is
"one item, ordered by time", so this covers the chart, `lastSnapshot` and
`history`.

---

## `alerts` — the event log

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `item_id` | INTEGER → `items.id` ON DELETE CASCADE | Nullable for future global alerts. |
| `ts` | TEXT NOT NULL | |
| `kind` | TEXT NOT NULL | `new_low`, `target`, `drop`, `back_in`. |
| `message` | TEXT NOT NULL | Pre-rendered, human-readable, in Portuguese (the UI language). |
| `price` | REAL | Price at the moment the alert fired. |
| `seen` | INTEGER DEFAULT `0` | Drives the unread badge. |

Index: `idx_alert_ts ON alerts(ts DESC)` — the alerts feed is always
"newest first, limit N".

Alert rows are **written before** the snapshot they describe, because
`evaluate()` compares the incoming snapshot against the previous one. See
[`ALERTS.md`](ALERTS.md).

---

## Exported API (`lib/db.mjs`)

Everything the rest of the app is allowed to do to the database. Keeping this
list explicit is what makes the storage layer swappable.

| Function | Returns | Purpose |
|---|---|---|
| `db` | `DatabaseSync` | Escape hatch, used only by tooling. |
| `now()` | ISO string | Single clock source, so timestamps are consistent. |
| `addItem(fields)` | `{ item, created }` | Idempotent on `ml_id`. |
| `getItem(id)` / `getItemByMlId(mlId)` | row \| `null` | |
| `listItems()` | rows | Active first, then newest. |
| `activeItems()` | rows | Only `active = 1`, ascending id. |
| `updateItem(id, patch)` | row | Whitelisted columns only. |
| `deleteItem(id)` | run result | Cascades. |
| `addSnapshot(itemId, snap)` | — | Normalises booleans. |
| `history(itemId, since?)` | rows | Ascending by `ts`. |
| `lastSnapshot(itemId)` | row \| `null` | |
| `statsFor(itemId)` | `{n,min,max,avg,first_ts,last_ts}` | Ignores `NULL`/`0` prices. |
| `medianPrice(itemId)` | number \| `null` | Computed in JS, not SQL. |
| `addAlert({itemId,kind,message,price})` | — | |
| `listAlerts(limit)` | rows | Joined with item title/url. |
| `unseenAlertCount()` | number | |
| `markAlertsSeen()` | — | Bulk update. |
| `alertedSince(itemId, kind, sinceIso)` | boolean | Cooldown lookup. |

### `updateItem` is whitelisted

Only these columns can be patched: `title, image, seller, currency,
target_price, drop_pct, alert_low, active, last_checked, last_error,
error_streak, url, ml_id`. Anything else is silently dropped. This blocks the
HTTP layer from writing `id` or `created_at` if a client sends a crafted body.

### `medianPrice` is deliberately not SQL

SQLite has no `MEDIAN` aggregate. Doing it in JS keeps the query trivial and
lets us return the true middle for both odd and even counts:

```js
const mid = Math.floor(rows.length / 2);
return rows.length % 2 ? rows[mid].price : (rows[mid - 1].price + rows[mid].price) / 2;
```

The **mean is never used** for the "is this a good price?" signal. One flash
sale on a 90-day window can drag an average far enough to make an obviously bad
price look average.

---

## Growth and retention

Snapshots grow by one row per item per poll. With the default
`pollMinutes: 60`, one item produces ~24 rows/day, ~8.8k rows/year — a few
hundred KB. SQLite handles this without any thought, so there is currently **no
retention policy**.

If you ever add one, downsample rather than delete: keep the min/max per day for
old windows, because those are the points the chart and the "all-time low" alert
depend on.

## Migrations

There are none — the schema is created with `CREATE TABLE IF NOT EXISTS` on
import. If you need to change a column:

1. Add the new column with `ALTER TABLE ... ADD COLUMN` (safe, additive).
2. Backfill in JS.
3. Never rename or drop in place; SQLite's `ALTER` support is limited and a
   half-applied rename will corrupt an existing user's database.

There is no schema version row yet. Adding `PRAGMA user_version` is a good
first contribution (see [`ROADMAP.md`](ROADMAP.md)).
