import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * SQLite storage. Uses node:sqlite (built into Node 22.5+), so there is no
 * native module to compile and nothing to install.
 *
 * Note: node:sqlite requires JS booleans to be stored as 0/1 integers, and
 * returns integers as numbers, so we normalise at the edges.
 */

const DB_PATH = resolve(
  process.env.MT_DB || new URL('../data/mercado.db', import.meta.url).pathname
);

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_id         TEXT UNIQUE,
    url           TEXT,
    title         TEXT NOT NULL,
    image         TEXT,
    seller        TEXT,
    currency      TEXT DEFAULT 'BRL',
    target_price  REAL,
    drop_pct      REAL,
    alert_low     INTEGER DEFAULT 1,
    active        INTEGER DEFAULT 1,
    created_at    TEXT NOT NULL,
    last_checked  TEXT,
    last_error    TEXT,
    error_streak  INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    ts            TEXT NOT NULL,
    price         REAL,
    list_price    REAL,
    available     INTEGER DEFAULT 1,
    free_shipping INTEGER,
    rating        REAL,
    reviews       INTEGER,
    source        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_snap_item_ts ON snapshots(item_id, ts);

  CREATE TABLE IF NOT EXISTS alerts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id   INTEGER REFERENCES items(id) ON DELETE CASCADE,
    ts        TEXT NOT NULL,
    kind      TEXT NOT NULL,
    message   TEXT NOT NULL,
    price     REAL,
    seen      INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_alert_ts ON alerts(ts DESC);
`);

export const now = () => new Date().toISOString();

/* ------------------------------- items ---------------------------------- */

export function addItem({
  mlId = null,
  url = null,
  title,
  image = null,
  seller = null,
  currency = 'BRL',
  targetPrice = null,
  dropPct = null,
}) {
  const existing = mlId ? getItemByMlId(mlId) : null;
  if (existing) return { item: existing, created: false };

  const info = db
    .prepare(
      `INSERT INTO items (ml_id, url, title, image, seller, currency, target_price, drop_pct, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(mlId, url, title, image, seller, currency, targetPrice, dropPct, now());

  return { item: getItem(Number(info.lastInsertRowid)), created: true };
}

export const getItem = (id) =>
  db.prepare('SELECT * FROM items WHERE id = ?').get(id) ?? null;

export const getItemByMlId = (mlId) =>
  db.prepare('SELECT * FROM items WHERE ml_id = ?').get(mlId) ?? null;

export const listItems = () =>
  db.prepare('SELECT * FROM items ORDER BY active DESC, id DESC').all();

export const activeItems = () =>
  db.prepare('SELECT * FROM items WHERE active = 1 ORDER BY id').all();

export function updateItem(id, patch) {
  const allowed = [
    'title', 'image', 'seller', 'currency', 'target_price',
    'drop_pct', 'alert_low', 'active', 'last_checked', 'last_error',
    'error_streak', 'url', 'ml_id',
  ];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return getItem(id);

  const sql = `UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => patch[k]), id);
  return getItem(id);
}

export const deleteItem = (id) => db.prepare('DELETE FROM items WHERE id = ?').run(id);

/* ----------------------------- snapshots -------------------------------- */

export function addSnapshot(itemId, s) {
  db.prepare(
    `INSERT INTO snapshots (item_id, ts, price, list_price, available, free_shipping, rating, reviews, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    itemId,
    s.ts ?? now(),
    s.price ?? null,
    s.listPrice ?? null,
    s.available === false ? 0 : 1,
    s.freeShipping == null ? null : s.freeShipping ? 1 : 0,
    s.rating ?? null,
    s.reviews ?? null,
    s.source ?? null
  );
}

export const history = (itemId, since = null) =>
  since
    ? db
        .prepare('SELECT * FROM snapshots WHERE item_id = ? AND ts >= ? ORDER BY ts')
        .all(itemId, since)
    : db.prepare('SELECT * FROM snapshots WHERE item_id = ? ORDER BY ts').all(itemId);

export const lastSnapshot = (itemId) =>
  db
    .prepare('SELECT * FROM snapshots WHERE item_id = ? ORDER BY ts DESC LIMIT 1')
    .get(itemId) ?? null;

/** Aggregate stats used for the deal score and the chart header. */
export function statsFor(itemId) {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n,
                MIN(price) AS min,
                MAX(price) AS max,
                AVG(price) AS avg,
                MIN(ts)    AS first_ts,
                MAX(ts)    AS last_ts
         FROM snapshots
         WHERE item_id = ? AND price IS NOT NULL AND price > 0`
      )
      .get(itemId) ?? {}
  );
}

/**
 * Median of observed prices. Used instead of the mean for the "is this a good
 * price?" signal because a single flash-sale outlier skews an average badly.
 */
export function medianPrice(itemId) {
  const rows = db
    .prepare(
      'SELECT price FROM snapshots WHERE item_id = ? AND price IS NOT NULL AND price > 0 ORDER BY price'
    )
    .all(itemId);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid].price : (rows[mid - 1].price + rows[mid].price) / 2;
}

/* ------------------------------- alerts --------------------------------- */

export function addAlert({ itemId, kind, message, price }) {
  db.prepare(
    'INSERT INTO alerts (item_id, ts, kind, message, price) VALUES (?, ?, ?, ?, ?)'
  ).run(itemId, now(), kind, message, price ?? null);
}

export const listAlerts = (limit = 50) =>
  db
    .prepare(
      `SELECT a.*, i.title, i.ml_id, i.url
       FROM alerts a LEFT JOIN items i ON i.id = a.item_id
       ORDER BY a.ts DESC LIMIT ?`
    )
    .all(limit);

export const unseenAlertCount = () =>
  db.prepare('SELECT COUNT(*) AS c FROM alerts WHERE seen = 0').get().c;

export const markAlertsSeen = () =>
  db.prepare('UPDATE alerts SET seen = 1 WHERE seen = 0').run();

/** Has this alert kind already fired for this item since `sinceIso`? */
export const alertedSince = (itemId, kind, sinceIso) =>
  !!db
    .prepare(
      'SELECT 1 AS x FROM alerts WHERE item_id = ? AND kind = ? AND ts >= ? LIMIT 1'
    )
    .get(itemId, kind, sinceIso);
