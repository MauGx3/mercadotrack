#!/usr/bin/env node
/**
 * Add an item from the terminal.
 *
 *   node bin/add.mjs "https://produto.mercadolivre.com.br/MLB-1234567890-..."
 *   node bin/add.mjs MLB1234567890 --target 3500 --drop 12
 */

import { addItem, addSnapshot, updateItem, getItem } from '../lib/db.mjs';
import { parseTarget } from '../lib/mltarget.mjs';
import { fetchForItem, closeBrowser, activeSource } from '../lib/sources/index.mjs';

const args = process.argv.slice(2);

/** Value following `--name`, if present. */
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

/**
 * The positional argument is the first token that is neither a flag nor a flag's
 * value. Scanning (rather than filtering by index) keeps this correct regardless
 * of where the flags appear.
 */
function positional() {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i++; // skip this flag's value
      continue;
    }
    return args[i];
  }
  return null;
}

const raw = positional();
if (!raw) {
  console.error('uso: node bin/add.mjs <url-ou-id> [--target 1234] [--drop 10]');
  process.exit(1);
}

const target = parseTarget(raw);
if (!target) {
  console.error(`Não reconheci "${raw}". Use a URL de um anúncio ou um ID MLB...`);
  process.exit(1);
}

console.log(`buscando ${target.id} (${target.kind}) via ${activeSource()}…`);

let snap = null;
try {
  snap = await fetchForItem({ ml_id: target.id, url: target.url });
} catch (err) {
  console.error(`aviso: não consegui ler o preço agora (${err.message})`);
}

const { item, created } = addItem({
  mlId: target.id,
  url: target.url,
  title: snap?.title || target.id,
  image: snap?.image ?? null,
  seller: snap?.seller ?? null,
  currency: snap?.currency ?? 'BRL',
  targetPrice: flag('target') ? Number(flag('target')) : null,
  dropPct: flag('drop') ? Number(flag('drop')) : null,
});

if (snap?.price) {
  addSnapshot(item.id, snap);
  updateItem(item.id, { last_checked: new Date().toISOString() });
}

const fresh = getItem(item.id);
const brl = (v) =>
  v == null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

console.log(
  `${created ? 'adicionado' : 'já existia'}: #${fresh.id} ${fresh.title} — ${
    snap?.price ? brl(snap.price) : 'sem preço'
  }`
);

await closeBrowser();
