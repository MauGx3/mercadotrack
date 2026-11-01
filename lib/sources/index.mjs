/**
 * Source router. Picks the official API when credentials exist, otherwise the
 * browser scraper. Both expose the same shape, so the rest of the app doesn't
 * care which one answered.
 */

import { config } from '../config.mjs';
import { parseTarget } from '../mltarget.mjs';
import * as browserSource from './browser.mjs';
import * as apiSource from './api.mjs';

export function activeSource() {
  const configured = config.source;
  if (configured === 'browser') return 'browser';
  if (configured === 'api') return apiSource.hasCredentials() ? 'api' : 'browser';
  return apiSource.hasCredentials() ? 'api' : 'browser';
}

/**
 * @param {object} item  a row from the items table
 * @returns {Promise<object>} normalised product snapshot
 */
export async function fetchForItem(item) {
  const target = item.ml_id ? parseTarget(item.ml_id) : null;
  const kind = target?.kind ?? 'item';
  const id = target?.id ?? item.ml_id;
  const source = activeSource();

  if (source === 'api' && id) {
    try {
      return await apiSource.fetchProduct(id, kind);
    } catch (err) {
      // A bad token shouldn't leave you with no data at all.
      if (config.source === 'api') throw err;
      console.warn(`[source] API failed for ${id} (${err.message}); falling back to browser.`);
    }
  }

  if (!item.url) throw new Error('No URL stored for this item, and no API id to query.');
  return browserSource.fetchProduct(item.url);
}

export async function search(query, limit) {
  if (activeSource() === 'api') {
    try {
      return await apiSource.searchProducts(query, limit);
    } catch (err) {
      if (config.source === 'api') throw err;
      console.warn(`[source] API search failed (${err.message}); falling back to browser.`);
    }
  }
  return browserSource.searchProducts(query, limit);
}

export { closeBrowser } from './browser.mjs';
