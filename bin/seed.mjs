#!/usr/bin/env node
/**
 * Seed a demo item with realistic price history.
 *
 * Without history the app is a blank chart, which makes it hard to tell whether
 * it works. This generates a plausible 6-month series (slow drift, occasional
 * promo dips, a couple of out-of-stock gaps) so you can see the real UI.
 *
 *   node bin/seed.mjs            # add the demo item
 *   node bin/seed.mjs --clear    # remove it again
 */

import { addItem, addSnapshot, deleteItem, getItemByMlId, updateItem, listItems } from '../lib/db.mjs';

const DEMO_ID = 'MLB-DEMO-0001';
const clear = process.argv.includes('--clear');

const existing = getItemByMlId(DEMO_ID);
if (clear) {
  if (existing) {
    deleteItem(existing.id);
    console.log('demo removido.');
  } else {
    console.log('nada para remover.');
  }
  process.exit(0);
}

if (existing) {
  deleteItem(existing.id);
}

const { item } = addItem({
  mlId: DEMO_ID,
  url: 'https://www.mercadolivre.com.br/',
  title: '[DEMO] Fone Bluetooth Over-Ear — histórico de exemplo',
  seller: 'demo',
  currency: 'BRL',
  targetPrice: 349,
  dropPct: 8,
});

// --- build a believable series -------------------------------------------
const days = 180;
const pointsPerDay = 1;
const start = 549;
const now = Date.now();

let price = start;
const rows = [];

for (let d = days; d >= 0; d--) {
  const ts = new Date(now - d * 86400000);

  // Gentle downward drift over time, with noise.
  price -= 0.18;
  price += (Math.random() - 0.5) * 9;

  // Occasional promo dip lasting a couple of days.
  const isPromo = d % 37 === 0 || d % 53 === 0;
  let observed = price;
  if (isPromo) observed = price * 0.82;
  // A little recovery right after a promo.
  if (d % 37 === 1 || d % 53 === 1) observed = price * 0.95;

  // Two out-of-stock windows.
  const outOfStock = (d >= 120 && d <= 116) || (d >= 40 && d <= 37);

  observed = Math.max(289, Math.round(observed * 100) / 100);

  rows.push({
    ts: ts.toISOString(),
    price: Math.round(observed * 100) / 100,
    listPrice: Math.round(observed * 1.18 * 100) / 100,
    available: !outOfStock,
    freeShipping: true,
    rating: 4.6,
    reviews: 1840,
    source: 'seed',
  });
}

for (const r of rows) addSnapshot(item.id, r);
updateItem(item.id, { last_checked: rows.at(-1).ts });

const prices = rows.filter((r) => r.price).map((r) => r.price);
const min = Math.min(...prices);
const max = Math.max(...prices);
const brl = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

console.log(`demo criado: #${item.id} com ${rows.length} registros`);
console.log(`faixa de preço: ${brl(min)} – ${brl(max)}`);
console.log(`total de itens: ${listItems().length}`);
