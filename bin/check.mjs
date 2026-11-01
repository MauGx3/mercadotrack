#!/usr/bin/env node
/**
 * One-shot check of every tracked item. Meant for cron:
 *
 *   0 * * * * cd /path/to/mercadotrack && /usr/bin/env node bin/check.mjs >> data/check.log 2>&1
 */

import { runOnce, state } from '../lib/poller.mjs';
import { closeBrowser } from '../lib/sources/index.mjs';
import { config } from '../lib/config.mjs';

const brl = (v) =>
  v == null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

const stamp = () => new Date().toLocaleString('pt-BR');

console.log(`[${stamp()}] checando itens (fonte: ${config.source})…`);

const res = await runOnce({ notifyUser: true });

if (res.skipped) {
  console.log(`[${stamp()}] pulado: ${res.reason}`);
} else {
  for (const r of res.results ?? []) {
    if (r.ok) {
      const alerts = r.alerts.length ? `  ⚡ ${r.alerts.map((a) => a.kind).join(', ')}` : '';
      console.log(`  ✓ ${r.title} — ${brl(r.snapshot.price)}${alerts}`);
    } else {
      console.log(`  ✗ ${r.title} — ${r.error}${r.disabled ? ' (desativado)' : ''}`);
    }
  }
  console.log(
    `[${stamp()}] ${res.ok}/${res.total} ok, ${res.failed} falhas, ${res.alerts} alertas, ` +
      `${(state.lastRunMs / 1000).toFixed(1)}s`
  );
}

await closeBrowser();
process.exit(res.failed > 0 && res.ok === 0 ? 1 : 0);
