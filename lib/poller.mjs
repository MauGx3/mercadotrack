/**
 * The poller: re-checks every active item, stores a snapshot, evaluates alerts.
 *
 * Politeness matters here. Mercado Livre will throttle or block a client that
 * hammers them, so we fetch one item at a time with a randomised pause, and we
 * back off an item that keeps failing instead of retrying forever.
 */

import { config } from './config.mjs';
import {
  activeItems,
  addSnapshot,
  getItem,
  lastSnapshot,
  updateItem,
  now,
} from './db.mjs';
import { evaluate, recordAlerts } from './alerts.mjs';
import { notify } from './notify.mjs';
import { fetchForItem, activeSource } from './sources/index.mjs';
import { sleep, withTimeout } from './util.mjs';

/** Hard ceiling for one item, so a hung page can't stall the whole cycle. */
const ITEM_TIMEOUT_MS = () => (config.timeoutSeconds ?? 60) * 1000 + 30_000;

function randomDelay() {
  const [min, max] = config.delayBetweenItems ?? [4, 9];
  return (min + Math.random() * (max - min)) * 1000;
}

export const state = {
  running: false,
  lastRunAt: null,
  lastRunMs: null,
  nextRunAt: null,
  lastResult: null,
  source: null,
};

/**
 * Check a single item. Returns { ok, snapshot, alerts, error }.
 */
export async function checkItem(id, { notifyUser = true } = {}) {
  const item = getItem(id);
  if (!item) throw new Error(`No item with id ${id}`);

  const prev = lastSnapshot(item.id);
  const checkedAt = now();

  try {
    const snap = await withTimeout(fetchForItem(item), ITEM_TIMEOUT_MS(), `check de "${item.title}"`);
    if (snap.price == null) throw new Error('No price found on the page.');

    const fired = recordAlerts(item, evaluate(item, snap, prev));
    addSnapshot(item.id, { ...snap, ts: checkedAt });

    updateItem(item.id, {
      last_checked: checkedAt,
      last_error: null,
      error_streak: 0,
      // Keep the listing fresh without clobbering a user-edited title.
      title: item.title?.trim() ? item.title : snap.title || item.title,
      image: item.image || snap.image || null,
      seller: item.seller || snap.seller || null,
      currency: snap.currency || item.currency,
    });

    if (notifyUser) {
      for (const a of fired) {
        await notify('MercadoTrack', a.message);
        await sleep(400);
      }
    }

    return { ok: true, snapshot: { ...snap, ts: checkedAt }, alerts: fired, error: null };
  } catch (err) {
    const streak = (item.error_streak ?? 0) + 1;
    const patch = { last_checked: checkedAt, last_error: err.message, error_streak: streak };

    // Park an item that has failed repeatedly so we stop wasting cycles on it.
    if (streak >= (config.maxErrorStreak ?? 8)) patch.active = 0;

    updateItem(item.id, patch);

    return { ok: false, snapshot: null, alerts: [], error: err.message, disabled: patch.active === 0 };
  }
}

/**
 * One full pass over the watchlist.
 */
export async function runOnce({ notifyUser = true, onProgress = null } = {}) {
  if (state.running) return { skipped: true, reason: 'already running' };

  state.running = true;
  state.source = activeSource();
  const started = Date.now();
  const items = activeItems();
  const results = [];

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const res = await checkItem(item.id, { notifyUser });
      results.push({ id: item.id, title: item.title, ...res });
      onProgress?.({ index: i + 1, total: items.length, item, result: res });

      // No need to be polite after the very last item.
      if (i < items.length - 1) await sleep(randomDelay());
    }
  } finally {
    state.running = false;
    state.lastRunAt = now();
    state.lastRunMs = Date.now() - started;
    state.lastResult = {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      alerts: results.reduce((n, r) => n + r.alerts.length, 0),
    };
  }

  return { results, ...state.lastResult };
}

let timer = null;

export function scheduleNext() {
  const minutes = config.pollMinutes + Math.random() * (config.jitterMinutes ?? 0);
  state.nextRunAt = new Date(Date.now() + minutes * 60_000).toISOString();
  return minutes;
}

/**
 * Start the background loop.
 */
export function startScheduler({ onCycle = null } = {}) {
  stopScheduler();

  const tick = async () => {
    try {
      const res = await runOnce({ notifyUser: true });
      onCycle?.(res);
    } catch (err) {
      console.error(`[poll] cycle failed: ${err.message}`);
    }
    const minutes = scheduleNext();
    console.log(`[poll] next check in ${minutes.toFixed(0)} min (${state.nextRunAt})`);
    timer = setTimeout(tick, minutes * 60_000);
    timer.unref?.();
  };

  const minutes = scheduleNext();
  console.log(`[poll] first check in ${minutes.toFixed(0)} min (${state.nextRunAt})`);
  timer = setTimeout(tick, minutes * 60_000);
  timer.unref?.();
  return state;
}

export function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  state.nextRunAt = null;
}
