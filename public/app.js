/* ------------------------------------------------------------------ *
 * MercadoTrack client.
 * No framework, no build step: one module, direct DOM updates.
 * ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  items: [],
  selectedId: null,
  detail: null,
  rangeDays: 30,
  status: null,
  pollTimer: null,
};

const brl = (v) =>
  v == null
    ? '—'
    : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

const compactBrl = (v) => {
  if (v == null) return '—';
  if (v >= 1000) return `R$ ${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',')}k`;
  return `R$ ${v.toFixed(0)}`;
};

const dtShort = (iso) =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

const dtFull = (iso) =>
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const ago = (iso) => {
  if (!iso) return 'nunca';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins} min atrás`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h atrás`;
  return `${Math.round(h / 24)}d atrás`;
};

/* ------------------------------- api helper ----------------------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

/* --------------------------------- toasts ------------------------------- */

function toast(message, kind = 'ok', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* -------------------------------- status -------------------------------- */

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    state.status = s;
    const dot = $('#status-dot');
    const text = $('#status-text');
    dot.className = 'dot';

    if (s.scheduler.running) {
      dot.classList.add('live');
      const next = s.scheduler.nextRunAt ? new Date(s.scheduler.nextRunAt) : null;
      const mins = next ? Math.max(0, Math.round((next - Date.now()) / 60000)) : null;
      text.textContent =
        mins == null ? 'ativo' : `próxima checagem em ${mins} min`;
    } else {
      text.textContent = 'manual';
    }
    text.title = `fonte: ${s.source} · ${s.itemCount} itens · intervalo ${s.pollMinutes} min`;

    const badge = $('#alert-badge');
    if (s.unseenAlerts > 0) {
      badge.textContent = s.unseenAlerts;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch {
    $('#status-dot').className = 'dot error';
    $('#status-text').textContent = 'servidor offline';
  }
}

/* ------------------------------- watchlist ------------------------------ */

function deltaFor(item) {
  const h = item.stats;
  if (!item.currentPrice || !h.median) return null;
  return ((item.currentPrice - h.median) / h.median) * 100;
}

function renderWatchlist() {
  const ul = $('#watchlist');
  ul.innerHTML = '';
  $('#item-count').textContent = state.items.length;

  if (!state.items.length) {
    ul.innerHTML = `<li class="empty-note">Nada monitorado ainda.<br />Cole um link acima para começar.</li>`;
    return;
  }

  for (const item of state.items) {
    const li = document.createElement('li');
    li.className = 'watch-item' + (item.id === state.selectedId ? ' selected' : '');
    if (!item.active) li.classList.add('inactive');
    li.dataset.id = item.id;

    const delta = deltaFor(item);
    const deltaClass =
      delta == null ? 'delta-flat' : delta < -0.5 ? 'delta-down' : delta > 0.5 ? 'delta-up' : 'delta-flat';
    const deltaText =
      delta == null ? '' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}% vs mediana`;

    li.innerHTML = `
      <img class="watch-thumb" src="${item.image || ''}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'" />
      <div class="watch-main">
        <p class="watch-title">${escapeHtml(item.title)}</p>
        <div class="watch-sub">
          <span>${item.stats.n} ponto${item.stats.n === 1 ? '' : 's'}</span>
          ${item.last_error ? `<span class="err-flag" title="${escapeHtml(item.last_error)}">⚠</span>` : ''}
        </div>
      </div>
      <div class="watch-right">
        <div class="watch-price">${compactBrl(item.currentPrice)}</div>
        <div class="watch-delta ${deltaClass}">${deltaText}</div>
      </div>
    `;
    li.addEventListener('click', () => selectItem(item.id));
    ul.append(li);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/* -------------------------------- detail -------------------------------- */

async function selectItem(id) {
  state.selectedId = id;
  renderWatchlist();
  $('#empty-state').classList.add('hidden');
  $('#detail-body').classList.remove('hidden');

  try {
    const data = await api(`/api/items/${id}`);
    state.detail = data;
    renderDetail(data.item, data.history);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderDetail(item, history) {
  $('#d-image').src = item.image || '';
  $('#d-image').style.visibility = item.image ? 'visible' : 'hidden';
  $('#d-title').textContent = item.title;
  $('#d-seller').textContent = item.seller ? `vendedor ${item.seller}` : '';
  $('#d-sep').style.display = item.seller ? '' : 'none';
  $('#d-link').href = item.url || '#';
  $('#d-price').textContent = brl(item.currentPrice);

  const delta = deltaFor(item);
  const deal = $('#d-deal');
  if (delta == null) {
    deal.textContent = 'sem histórico suficiente';
    deal.style.color = 'var(--text-faint)';
  } else if (delta < -1) {
    deal.textContent = `${Math.abs(delta).toFixed(1)}% abaixo da mediana — bom momento`;
    deal.style.color = 'var(--accent)';
  } else if (delta > 1) {
    deal.textContent = `${delta.toFixed(1)}% acima da mediana`;
    deal.style.color = 'var(--red)';
  } else {
    deal.textContent = 'na faixa habitual';
    deal.style.color = 'var(--text-faint)';
  }

  // Stats cards
  const s = item.stats;
  const cards = [
    { label: 'mínima', value: brl(s.min), cls: 'accent', sub: s.min ? 'menor já visto' : '' },
    { label: 'máxima', value: brl(s.max), cls: 'red', sub: s.max ? 'maior já visto' : '' },
    { label: 'mediana', value: brl(s.median), cls: '', sub: 'referência de preço justo' },
    { label: 'média', value: brl(s.avg), cls: '', sub: '' },
    {
      label: 'registros',
      value: String(s.n ?? 0),
      cls: '',
      sub: s.firstTs ? `desde ${dtShort(s.firstTs)}` : '',
    },
    {
      label: 'última checagem',
      value: ago(item.lastChecked),
      cls: '',
      sub: item.lastChecked ? dtFull(item.lastChecked) : '',
    },
  ];

  $('#stats-grid').innerHTML = cards
    .map(
      (c) => `
      <div class="stat">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value ${c.cls}">${c.value ?? '—'}</div>
        ${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ''}
      </div>`
    )
    .join('');

  $('#d-target').value = item.target_price ?? '';
  $('#d-drop').value = item.drop_pct ?? '';
  $('#d-active').checked = Boolean(item.active);

  renderChart(history, item);
}

/* --------------------------------- chart -------------------------------- */

const chartState = { data: [], min: null, max: null };

function renderChart(history, item) {
  const wrap = $('#chart-wrap');
  const svg = $('#chart');
  const W = wrap.clientWidth || 800;
  const H = wrap.clientHeight || 300;
  const pad = { top: 16, right: 56, bottom: 26, left: 8 };

  // Filter by selected range.
  const days = state.rangeDays;
  let data = history.filter((h) => h.price != null && h.price > 0);
  if (days > 0) {
    const cutoff = Date.now() - days * 86400000;
    data = data.filter((h) => new Date(h.ts).getTime() >= cutoff);
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = '';
  chartState.data = data;

  if (!data.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#63707f" font-size="12"
      text-anchor="middle" font-family="system-ui">Sem registros neste período</text>`;
    return;
  }

  const prices = data.map((d) => d.price);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (lo === hi) {
    // A flat line needs headroom or it renders as a single pixel row.
    const padPct = lo * 0.05 || 1;
    lo -= padPct;
    hi += padPct;
  } else {
    const padPct = (hi - lo) * 0.12;
    lo -= padPct;
    hi += padPct;
  }

  const times = data.map((d) => new Date(d.ts).getTime());
  let t0 = Math.min(...times);
  let t1 = Math.max(...times);
  if (t0 === t1) {
    t0 -= 3600000;
    t1 += 3600000;
  }

  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const x = (t) => pad.left + ((t - t0) / (t1 - t0)) * plotW;
  const y = (p) => pad.top + (1 - (p - lo) / (hi - lo)) * plotH;

  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // --- horizontal grid + y labels
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const p = lo + ((hi - lo) * i) / ticks;
    const yy = y(p);
    svg.append(
      el('line', {
        x1: pad.left, y1: yy, x2: W - pad.right, y2: yy,
        stroke: '#1f2833', 'stroke-width': 1,
      })
    );
    const label = el('text', {
      x: W - pad.right + 8, y: yy + 3.5,
      fill: '#63707f', 'font-size': 10, 'font-family': 'ui-monospace, monospace',
    });
    label.textContent = compactBrl(p).replace('R$ ', '');
    svg.append(label);
  }

  // --- min / max reference lines
  const realMin = Math.min(...prices);
  const realMax = Math.max(...prices);
  if (realMax !== realMin) {
    svg.append(el('line', {
      x1: pad.left, y1: y(realMin), x2: W - pad.right, y2: y(realMin),
      stroke: 'rgba(47,208,127,0.45)', 'stroke-width': 1, 'stroke-dasharray': '4 4',
    }));
    svg.append(el('line', {
      x1: pad.left, y1: y(realMax), x2: W - pad.right, y2: y(realMax),
      stroke: 'rgba(239,95,107,0.5)', 'stroke-width': 1, 'stroke-dasharray': '4 4',
    }));
  }

  // --- x labels (first, middle, last)
  const xLabels = [t0, t0 + (t1 - t0) / 2, t1];
  xLabels.forEach((t, i) => {
    const txt = el('text', {
      x: x(t), y: H - 8,
      fill: '#63707f', 'font-size': 10,
      'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle',
      'font-family': 'ui-monospace, monospace',
    });
    txt.textContent = dtShort(new Date(t).toISOString());
    svg.append(txt);
  });

  // --- area + line
  const pts = data.map((d) => [x(new Date(d.ts).getTime()), y(d.price)]);
  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');

  const gradId = 'areaGrad';
  const defs = el('defs');
  const grad = el('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(el('stop', { offset: '0%', 'stop-color': '#2fd07f', 'stop-opacity': 0.28 }));
  grad.append(el('stop', { offset: '100%', 'stop-color': '#2fd07f', 'stop-opacity': 0 }));
  defs.append(grad);
  svg.append(defs);

  if (pts.length > 1) {
    const areaPath = `${linePath}L${pts.at(-1)[0].toFixed(1)},${(pad.top + plotH).toFixed(
      1
    )}L${pts[0][0].toFixed(1)},${(pad.top + plotH).toFixed(1)}Z`;
    svg.append(el('path', { d: areaPath, fill: `url(#${gradId})`, stroke: 'none' }));

    svg.append(
      el('path', {
        d: linePath, fill: 'none', stroke: '#2fd07f',
        'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      })
    );
  }

  // --- dots: always show last; show all when sparse
  const showAll = pts.length <= 40;
  pts.forEach((p, i) => {
    const isLast = i === pts.length - 1;
    if (!showAll && !isLast) return;
    svg.append(
      el('circle', {
        cx: p[0], cy: p[1], r: isLast ? 4 : 2.6,
        fill: '#0e1116', stroke: '#2fd07f', 'stroke-width': isLast ? 2 : 1.6,
      })
    );
  });

  // --- hover layer
  const hoverLine = el('line', {
    y1: pad.top, y2: pad.top + plotH,
    stroke: '#3a4757', 'stroke-width': 1, opacity: 0,
  });
  svg.append(hoverLine);
  const hoverDot = el('circle', {
    r: 4.5, fill: '#2fd07f', stroke: '#0e1116', 'stroke-width': 2, opacity: 0,
  });
  svg.append(hoverDot);

  const overlay = el('rect', {
    x: pad.left, y: pad.top, width: plotW, height: plotH, fill: 'transparent',
  });
  svg.append(overlay);

  const tooltip = $('#tooltip');

  const onMove = (evt) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((evt.clientX - rect.left) / rect.width) * W;

    // Nearest point by x.
    let best = 0;
    let bestDist = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(p[0] - mx);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });

    const p = pts[best];
    const d = data[best];
    hoverLine.setAttribute('x1', p[0]);
    hoverLine.setAttribute('x2', p[0]);
    hoverLine.setAttribute('opacity', 1);
    hoverDot.setAttribute('cx', p[0]);
    hoverDot.setAttribute('cy', p[1]);
    hoverDot.setAttribute('opacity', 1);

    tooltip.classList.remove('hidden');
    tooltip.innerHTML = `
      <div class="tt-price">${brl(d.price)}</div>
      <div class="tt-date">${dtFull(d.ts)}</div>
      ${d.available === false ? '<div class="tt-date" style="color:var(--amber)">indisponível</div>' : ''}
    `;
    const px = (p[0] / W) * rect.width;
    const py = (p[1] / H) * rect.height;
    const tw = tooltip.offsetWidth;
    tooltip.style.left = `${Math.min(Math.max(px - tw / 2, 4), rect.width - tw - 4)}px`;
    tooltip.style.top = `${Math.max(py - tooltip.offsetHeight - 12, 4)}px`;
  };

  overlay.addEventListener('mousemove', onMove);
  overlay.addEventListener('mouseleave', () => {
    hoverLine.setAttribute('opacity', 0);
    hoverDot.setAttribute('opacity', 0);
    tooltip.classList.add('hidden');
  });
}

/* --------------------------------- alerts ------------------------------- */

async function openDrawer() {
  $('#drawer').classList.remove('hidden');
  $('#drawer-scrim').classList.remove('hidden');
  try {
    const { alerts } = await api('/api/alerts');
    const ul = $('#alert-list');
    if (!alerts.length) {
      ul.innerHTML = `<li class="empty-note">Nenhum alerta ainda.<br />Eles aparecem quando um preço cai.</li>`;
    } else {
      ul.innerHTML = alerts
        .map(
          (a) => `
        <li class="alert-item ${a.seen ? '' : 'unseen'}">
          <div class="alert-top">
            <span class="alert-kind ${a.kind}">${labelForKind(a.kind)}</span>
            <span>${dtFull(a.ts)}</span>
          </div>
          <div class="alert-msg">${escapeHtml(a.message)}</div>
        </li>`
        )
        .join('');
    }
    await api('/api/alerts/seen', { method: 'POST' });
    refreshStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function labelForKind(kind) {
  return (
    {
      new_low: 'mínima',
      target: 'alvo',
      drop: 'queda',
      back_in: 'voltou',
    }[kind] || kind
  );
}

function closeDrawer() {
  $('#drawer').classList.add('hidden');
  $('#drawer-scrim').classList.add('hidden');
}

/* ---------------------------------- init -------------------------------- */

async function loadItems() {
  const { items } = await api('/api/items');
  state.items = items;
  renderWatchlist();
  if (state.selectedId) {
    const still = items.find((i) => i.id === state.selectedId);
    if (still) renderDetail(still, state.detail?.history ?? []);
  }
}

async function bootstrap() {
  await refreshStatus();
  await loadItems();

  // Re-poll status every 30s so the countdown stays honest.
  setInterval(refreshStatus, 30000);

  // Auto-select the first item for a friendlier first run.
  if (state.items.length && !state.selectedId) selectItem(state.items[0].id);
}

/* ------------------------------- listeners ------------------------------ */

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#add-input').value.trim();
  const hint = $('#add-hint');
  const btn = $('#add-submit');
  if (!url) return;

  btn.disabled = true;
  btn.textContent = 'Buscando…';
  hint.className = 'hint';
  hint.textContent = 'Abrindo o anúncio no Mercado Livre… (pode levar alguns segundos)';

  try {
    const res = await api('/api/items', {
      method: 'POST',
      body: {
        url,
        targetPrice: $('#add-target').value || null,
        dropPct: $('#add-drop').value || null,
      },
    });

    $('#add-input').value = '';
    $('#add-target').value = '';
    $('#add-drop').value = '';

    if (res.lookupError) {
      hint.className = 'hint error';
      hint.textContent = `Adicionado, mas não consegui ler o preço agora: ${res.lookupError}`;
    } else {
      hint.className = 'hint ok';
      hint.textContent = res.created ? 'Adicionado ao rastreio.' : 'Esse anúncio já estava sendo rastreado.';
    }

    await loadItems();
    selectItem(res.item.id);
    toast(res.created ? 'Anúncio adicionado' : 'Anúncio já monitorado', 'ok');
  } catch (err) {
    hint.className = 'hint error';
    hint.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Rastrear';
  }
});

$('#btn-check-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Verificando…';
  $('#status-dot').className = 'dot busy';
  $('#status-text').textContent = 'verificando todos…';

  try {
    const res = await api('/api/check-all', { method: 'POST' });
    toast(
      `${res.ok}/${res.total} atualizados${res.alerts ? ` · ${res.alerts} alerta(s)` : ''}`,
      res.failed ? 'warn' : 'ok'
    );
    await loadItems();
    if (state.selectedId) selectItem(state.selectedId);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    refreshStatus();
  }
});

$('#btn-alerts').addEventListener('click', openDrawer);
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

$('#range-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $$('#range-picker button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.rangeDays = Number(btn.dataset.days);
  if (state.detail) renderChart(state.detail.history, state.detail.item);
});

/* --- per-item settings (debounced save) --- */

let saveTimer = null;
function saveSettings() {
  if (!state.selectedId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const { item } = await api(`/api/items/${state.selectedId}`, {
        method: 'PATCH',
        body: {
          targetPrice: $('#d-target').value,
          dropPct: $('#d-drop').value,
          active: $('#d-active').checked,
        },
      });
      const idx = state.items.findIndex((i) => i.id === item.id);
      if (idx >= 0) state.items[idx] = item;
      renderWatchlist();
      toast('Configurações salvas', 'ok', 1600);
    } catch (err) {
      toast(err.message, 'error');
    }
  }, 550);
}

['#d-target', '#d-drop'].forEach((sel) =>
  $(sel).addEventListener('input', saveSettings)
);
$('#d-active').addEventListener('change', async () => {
  await saveSettings();
  await loadItems();
});

$('#d-check').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checando…';
  try {
    const res = await api(`/api/items/${state.selectedId}/check`, { method: 'POST' });
    if (res.ok) {
      toast(`Preço atualizado: ${brl(res.snapshot.price)}`, 'ok');
      await loadItems();
      await selectItem(state.selectedId);
    } else {
      toast(res.error, 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verificar agora';
  }
});

$('#d-delete').addEventListener('click', async () => {
  if (!state.selectedId) return;
  if (!confirm('Remover este anúncio e todo o histórico dele?')) return;
  try {
    await api(`/api/items/${state.selectedId}`, { method: 'DELETE' });
    state.selectedId = null;
    state.detail = null;
    $('#detail-body').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    await loadItems();
    toast('Removido', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* --- resize: re-render the chart so it never stretches --- */
let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.detail) renderChart(state.detail.history, state.detail.item);
  }, 120);
}).observe($('#chart-wrap'));

bootstrap().catch((err) => {
  console.error(err);
  toast(`Falha ao iniciar: ${err.message}`, 'error', 8000);
});
