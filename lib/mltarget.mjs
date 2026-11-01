/**
 * Turn whatever the user pasted into something we can track.
 *
 * Mercado Livre has two id flavours and they are NOT interchangeable:
 *   MLB1234567890  - an item (a specific seller's listing)
 *   MLB12345678    - a catalog product (the "same thing, many sellers" page, /p/MLB...)
 *
 * Both are 3 letters + digits, so the prefix tells you the type, not the length.
 */

const SITE_PREFIXES = {
  MLB: 'BR', MLM: 'MX', MLA: 'AR', MLC: 'CL', MCO: 'CO', MPE: 'PE', MLU: 'UY',
};

export function parseTarget(input) {
  if (!input) return null;
  const raw = String(input).trim();

  // Bare id, e.g. "MLB1234567890"
  const bare = raw.match(/^(ML[A-Z])\s*-?\s*(\d{6,})$/i);
  if (bare) {
    return {
      kind: 'item',
      id: `${bare[1].toUpperCase()}${bare[2]}`,
      site: SITE_PREFIXES[bare[1].toUpperCase()] ?? 'BR',
      url: `https://produto.mercadolivre.com.br/${bare[1].toUpperCase()}-${bare[2]}`,
    };
  }

  if (!/^https?:\/\//i.test(raw)) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // Catalog product page: /p/MLB12345678
  const catalog = url.pathname.match(/\/p\/(ML[A-Z]\d{6,})/i);
  if (catalog) {
    const id = catalog[1].toUpperCase();
    return { kind: 'product', id, site: SITE_PREFIXES[id.slice(0, 3)] ?? 'BR', url: raw };
  }

  // Item page: MLB-1234567890-anything
  const item = url.pathname.match(/(ML[A-Z])-?(\d{6,})/i);
  if (item) {
    const id = `${item[1].toUpperCase()}${item[2]}`;
    return { kind: 'item', id, site: SITE_PREFIXES[item[1].toUpperCase()] ?? 'BR', url: raw };
  }

  return null;
}

/** Canonical key so /p/MLB123 and MLB123 don't get tracked twice. */
export const targetKey = (t) => (t ? t.id : null);

/**
 * Human-readable fallback title from the URL slug, used when the listing can't
 * be fetched yet. "MLB-1234567890-fone-bluetooth-preto" -> "Fone bluetooth preto".
 */
export function titleFromUrl(url) {
  if (!url) return null;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);

    // Two URL shapes to handle:
    //   /MLB-123-fone-bluetooth-preto/p   -> slug after the id
    //   /apple-iphone-15/p/MLB123         -> slug before the id
    // So strip the id prefix from every segment and keep the most descriptive
    // remainder.
    const candidates = segments
      .map((s) => s.replace(/^ML[A-Z]-?\d+-?/i, '').replace(/[-_]+/g, ' ').trim())
      .filter((s) => s.length >= 3 && !/^p$/i.test(s));

    if (!candidates.length) return null;
    const best = candidates.reduce((a, b) => (b.length > a.length ? b : a));
    return best.charAt(0).toUpperCase() + best.slice(1);
  } catch {
    return null;
  }
}
