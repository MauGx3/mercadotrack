import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './lib/config.mjs';
import {
  addItem,
  deleteItem,
  getItem,
  history,
  listAlerts,
  listItems,
  markAlertsSeen,
  medianPrice,
  statsFor,
  updateItem,
  unseenAlertCount,
} from './lib/db.mjs';
import { parseTarget, titleFromUrl } from './lib/mltarget.mjs';
import { checkItem, runOnce, startScheduler, stopScheduler, state } from './lib/poller.mjs';
import { activeSource, closeBrowser, search } from './lib/sources/index.mjs';
import { withTimeout } from './lib/util.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ------------------------------ utilities ------------------------------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('Body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
}

/** Decorate a stored item with the numbers the UI needs. */
function withStats(item) {
  const stats = statsFor(item.id);
  const last = history(item.id).at(-1) ?? null;
  const median = medianPrice(item.id);
  const current = last?.price ?? null;

  // Deal score: how far below the observed median today's price sits.
  const score =
    current && median ? Math.max(-100, Math.min(100, ((median - current) / median) * 100)) : null;

  return {
    ...item,
    currentPrice: current,
    listPrice: last?.list_price ?? null,
    available: last ? last.available === 1 : null,
    freeShipping: last?.free_shipping === 1,
    lastChecked: last?.ts ?? item.last_checked,
    stats: {
      n: stats.n ?? 0,
      min: stats.min ?? null,
      max: stats.max ?? null,
      avg: stats.avg ?? null,
      median,
      firstTs: stats.first_ts ?? null,
      lastTs: stats.last_ts ?? null,
      score,
    },
  };
}

/* -------------------------------- routes -------------------------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/status$/, async (_req, res) => {
  json(res, 200, {
    source: activeSource(),
    configuredSource: config.source,
    pollMinutes: config.pollMinutes,
    itemCount: listItems().length,
    unseenAlerts: unseenAlertCount(),
    scheduler: {
      running: Boolean(state.nextRunAt),
      nextRunAt: state.nextRunAt,
      lastRunAt: state.lastRunAt,
      lastRunMs: state.lastRunMs,
      lastResult: state.lastResult,
    },
    telegram: Boolean(config.notify.telegram.enabled && config.notify.telegram.chatId),
  });
});

route('GET', /^\/api\/items$/, async (_req, res) => {
  json(res, 200, { items: listItems().map(withStats) });
});

route('POST', /^\/api\/items$/, async (req, res) => {
  const body = await readBody(req);
  const raw = String(body.url ?? body.query ?? '').trim();
  if (!raw) return json(res, 400, { error: 'Informe a URL ou o ID do anúncio.' });

  const target = parseTarget(raw);
  if (!target) {
    return json(res, 400, {
      error:
        'Não reconheci esse link. Cole a URL de um anúncio (mercadolivre.com.br/.../MLB-...) ou de um catálogo (/p/MLB...).',
    });
  }

  // Look the item up first so we store a real title and price, not a bare id.
  // Bounded: a slow or blocked lookup must not leave the UI spinning.
  let snap = null;
  let lookupError = null;
  try {
    const { fetchForItem } = await import('./lib/sources/index.mjs');
    snap = await withTimeout(
      fetchForItem({ ml_id: target.id, url: target.url }),
      (config.timeoutSeconds ?? 60) * 1000 + 20_000,
      'busca do anúncio'
    );
  } catch (err) {
    lookupError = err.message;
  }

  const { item, created } = addItem({
    mlId: target.id,
    url: target.url,
    title: snap?.title || body.title || titleFromUrl(target.url) || target.id,
    image: snap?.image ?? null,
    seller: snap?.seller ?? null,
    currency: snap?.currency ?? 'BRL',
    targetPrice: body.targetPrice != null && body.targetPrice !== '' ? Number(body.targetPrice) : null,
    dropPct: body.dropPct != null && body.dropPct !== '' ? Number(body.dropPct) : null,
  });

  if (snap?.price) {
    const { addSnapshot } = await import('./lib/db.mjs');
    addSnapshot(item.id, { ...snap });
    updateItem(item.id, { last_checked: new Date().toISOString() });
  }

  json(res, created ? 201 : 200, {
    item: withStats(getItem(item.id)),
    created,
    lookupError,
  });
});

route('GET', /^\/api\/items\/(\d+)$/, async (_req, res, [id]) => {
  const item = getItem(Number(id));
  if (!item) return json(res, 404, { error: 'Item não encontrado.' });
  json(res, 200, {
    item: withStats(item),
    history: history(item.id).map((h) => ({
      ts: h.ts,
      price: h.price,
      listPrice: h.list_price,
      available: h.available === 1,
    })),
  });
});

route('PATCH', /^\/api\/items\/(\d+)$/, async (req, res, [id]) => {
  const item = getItem(Number(id));
  if (!item) return json(res, 404, { error: 'Item não encontrado.' });

  const body = await readBody(req);
  const patch = {};
  if ('targetPrice' in body)
    patch.target_price = body.targetPrice === '' || body.targetPrice == null ? null : Number(body.targetPrice);
  if ('dropPct' in body)
    patch.drop_pct = body.dropPct === '' || body.dropPct == null ? null : Number(body.dropPct);
  if ('alertLow' in body) patch.alert_low = body.alertLow ? 1 : 0;
  if ('active' in body) patch.active = body.active ? 1 : 0;
  if ('title' in body && body.title) patch.title = String(body.title);

  json(res, 200, { item: withStats(updateItem(item.id, patch)) });
});

route('DELETE', /^\/api\/items\/(\d+)$/, async (_req, res, [id]) => {
  deleteItem(Number(id));
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/items\/(\d+)\/check$/, async (_req, res, [id]) => {
  const result = await checkItem(Number(id), { notifyUser: false });
  const item = getItem(Number(id));
  json(res, result.ok ? 200 : 502, {
    ...result,
    item: item ? withStats(item) : null,
  });
});

route('POST', /^\/api\/check-all$/, async (_req, res) => {
  const result = await runOnce({ notifyUser: false });
  json(res, 200, { ...result, items: listItems().map(withStats) });
});

route('GET', /^\/api\/alerts$/, async (_req, res) => {
  json(res, 200, { alerts: listAlerts(100) });
});

route('POST', /^\/api\/alerts\/seen$/, async (_req, res) => {
  markAlertsSeen();
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/search$/, async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams.get('q');
  if (!q) return json(res, 400, { error: 'Informe um termo de busca.' });
  try {
    const results = await search(q, 24);
    json(res, 200, { results, source: activeSource() });
  } catch (err) {
    json(res, 502, { error: err.message });
  }
});

route('POST', /^\/api\/scheduler$/, async (req, res) => {
  const body = await readBody(req);
  if (body.action === 'stop') {
    stopScheduler();
    return json(res, 200, { running: false });
  }
  startScheduler();
  json(res, 200, { running: true, nextRunAt: state.nextRunAt });
});

/* ------------------------------ static files ---------------------------- */

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  // Resolve then verify containment: blocks ../ traversal.
  const filePath = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

/* -------------------------------- server -------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.pattern);
      if (m) return await r.handler(req, res, m.slice(1));
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname);
    json(res, 404, { error: 'Rota não encontrada.' });
  } catch (err) {
    console.error(`[http] ${req.method} ${pathname}: ${err.message}`);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

const port = Number(process.env.MT_PORT || config.port || 4747);

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('  MercadoTrack — rastreio de preços do Mercado Livre');
  console.log(`  http://localhost:${port}`);
  console.log(`  fonte de dados: ${activeSource()}  |  intervalo: ${config.pollMinutes} min`);
  console.log('');
  if (config.pollMinutes > 0) startScheduler();
});

async function shutdown() {
  console.log('\n[server] encerrando...');
  stopScheduler();
  await closeBrowser().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
