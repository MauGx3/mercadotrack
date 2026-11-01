/**
 * Alert engine: decides whether a fresh snapshot deserves a notification.
 *
 * Rules, cheapest-to-explain first:
 *   new_low    - the lowest price we have ever recorded for this item
 *   target     - at or below the user's target price
 *   drop       - fell by at least `drop_pct` versus the previous snapshot
 *   back_in    - was out of stock, is available again
 *
 * Every rule is rate-limited per item (config.alertCooldownHours) so a price
 * that hovers around a threshold doesn't spam you.
 */

import { config } from './config.mjs';
import { addAlert, alertedSince, lastSnapshot, statsFor } from './db.mjs';

const COOLDOWN_HOURS = () => config.alertCooldownHours ?? 12;

const money = (v, currency = 'BRL') =>
  v == null
    ? '-'
    : new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(v);

export function evaluate(item, snapshot, prev) {
  const fired = [];
  const cooldownSince = new Date(
    Date.now() - COOLDOWN_HOURS() * 3600 * 1000
  ).toISOString();
  const cooled = (kind) => !alertedSince(item.id, kind, cooldownSince);

  const price = snapshot.price;
  if (price == null || price <= 0) return fired;

  const cur = snapshot.currency || item.currency || 'BRL';
  const stats = statsFor(item.id);

  // --- back in stock
  if (prev && prev.available === 0 && snapshot.available !== false) {
    if (cooled('back_in')) {
      fired.push({
        kind: 'back_in',
        message: `${item.title} está disponível de novo — ${money(price, cur)}`,
        price,
      });
    }
  }

  // --- all-time low (needs at least a little history to be meaningful)
  if (stats.min != null && stats.n >= 2 && price <= stats.min) {
    if (cooled('new_low')) {
      fired.push({
        kind: 'new_low',
        message: `Menor preço já registrado: ${item.title} — ${money(price, cur)}`,
        price,
      });
    }
  }

  // --- target price
  if (item.target_price && price <= item.target_price) {
    if (cooled('target')) {
      fired.push({
        kind: 'target',
        message: `${item.title} atingiu seu alvo: ${money(price, cur)} (alvo ${money(
          item.target_price,
          cur
        )})`,
        price,
      });
    }
  }

  // --- percentage drop vs previous snapshot
  if (prev?.price && item.drop_pct) {
    const pct = ((prev.price - price) / prev.price) * 100;
    if (pct >= item.drop_pct && cooled('drop')) {
      fired.push({
        kind: 'drop',
        message: `${item.title} caiu ${pct.toFixed(1)}% — ${money(price, cur)} (era ${money(
          prev.price,
          cur
        )})`,
        price,
      });
    }
  }

  return fired;
}

export function recordAlerts(item, alerts) {
  for (const a of alerts) {
    addAlert({ itemId: item.id, kind: a.kind, message: a.message, price: a.price });
  }
  return alerts;
}

export function previousSnapshot(itemId) {
  return lastSnapshot(itemId);
}
