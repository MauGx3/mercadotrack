#!/usr/bin/env node
/** List what's being tracked, with the numbers that matter. */

import { listItems, statsFor, lastSnapshot, medianPrice } from '../lib/db.mjs';

const brl = (v) =>
  v == null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

const items = listItems();
if (!items.length) {
  console.log('Nada monitorado. Adicione com: node bin/add.mjs <url>');
  process.exit(0);
}

const rows = items.map((i) => {
  const last = lastSnapshot(i.id);
  const stats = statsFor(i.id);
  const median = medianPrice(i.id);
  const delta = last?.price && median ? ((last.price - median) / median) * 100 : null;
  return {
    id: i.id,
    ativo: i.active ? 'sim' : 'não',
    preço: brl(last?.price),
    mínima: brl(stats.min),
    mediana: brl(median),
    vsMed: delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`,
    pts: stats.n ?? 0,
    título: (i.title || '').slice(0, 44),
  };
});

const cols = ['id', 'ativo', 'preço', 'mínima', 'mediana', 'vsMed', 'pts', 'título'];
const widths = cols.map((c) =>
  Math.max(c.length, ...rows.map((r) => String(r[c]).length))
);
const line = (vals) =>
  vals.map((v, i) => String(v).padEnd(widths[i])).join('  ');

console.log(line(cols));
console.log(widths.map((w) => '─'.repeat(w)).join('  '));
for (const r of rows) console.log(line(cols.map((c) => r[c])));
