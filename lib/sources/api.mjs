/**
 * Official API source (optional).
 *
 * Mercado Livre now requires OAuth for product data. Register a free app at
 * https://developers.mercadolivre.com.br/ and either paste an access token or
 * let us refresh one automatically.
 *
 * This path is faster and far more stable than scraping, but it is optional:
 * the browser source needs no credentials at all.
 */

import { config, saveConfig } from '../config.mjs';

const API = 'https://api.mercadolibre.com';

export const hasCredentials = () =>
  Boolean(config.ml.accessToken || (config.ml.clientId && config.ml.clientSecret));

async function refreshAccessToken() {
  const { clientId, clientSecret, refreshToken } = config.ml;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  if (!res.ok) {
    console.error(`[api] token refresh failed: ${res.status} ${await res.text()}`);
    return null;
  }

  const json = await res.json();
  config.ml.accessToken = json.access_token;
  config.ml.refreshToken = json.refresh_token ?? refreshToken;
  config.ml.tokenExpiresAt = Date.now() + (json.expires_in ?? 21600) * 1000;
  saveConfig({ ml: config.ml });
  return config.ml.accessToken;
}

async function getToken() {
  const { accessToken, tokenExpiresAt } = config.ml;
  // Refresh a little early to avoid racing the expiry.
  if (tokenExpiresAt && Date.now() > tokenExpiresAt - 60_000) {
    const fresh = await refreshAccessToken();
    if (fresh) return fresh;
  }
  return accessToken || (await refreshAccessToken());
}

async function apiGet(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401) throw new Error('API token rejected (401). Refresh or re-authorise.');
  if (res.status === 403) throw new Error('API returned 403 (insufficient scope or policy block).');
  if (res.status === 404) throw new Error('Not found (404).');
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

/**
 * @param {string} targetId  MLB... id (item or catalog product)
 * @param {'item'|'product'} kind
 */
export async function fetchProduct(targetId, kind = 'item') {
  const token = await getToken();
  if (!token) throw new Error('No API credentials configured.');

  let data;
  if (kind === 'product') {
    data = await apiGet(`/products/${targetId}`, token);
    const buyBox = await apiGet(`/products/${targetId}/items`, token).catch(() => null);
    const winner = buyBox?.results?.[0];
    const item = winner ? await apiGet(`/items/${winner.item_id}`, token).catch(() => null) : null;

    return {
      title: data.name ?? item?.title ?? null,
      price: item?.price ?? null,
      listPrice: item?.original_price ?? null,
      currency: item?.currency_id ?? 'BRL',
      available: item ? item.status === 'active' : true,
      rating: null,
      reviews: null,
      image: data.pictures?.[0]?.url ?? null,
      seller: null,
      freeShipping: Boolean(item?.shipping?.free_shipping),
      source: 'api',
    };
  }

  data = await apiGet(`/items/${targetId}`, token);
  return {
    title: data.title ?? null,
    price: data.price ?? null,
    listPrice: data.original_price ?? null,
    currency: data.currency_id ?? 'BRL',
    available: data.status === 'active',
    rating: null,
    reviews: null,
    image: data.thumbnail ?? null,
    seller: data.seller_id ? String(data.seller_id) : null,
    freeShipping: Boolean(data.shipping?.free_shipping),
    source: 'api',
  };
}

export async function searchProducts(query, limit = 24) {
  const token = await getToken();
  if (!token) throw new Error('No API credentials configured.');
  const data = await apiGet(
    `/sites/MLB/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    token
  );
  return (data.results ?? []).map((r) => ({
    title: r.title,
    price: r.price ?? null,
    listPrice: r.original_price ?? null,
    url: r.permalink,
    image: r.thumbnail,
    freeShipping: Boolean(r.shipping?.free_shipping),
  }));
}
