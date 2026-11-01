/**
 * Browser source: reads Mercado Livre's public pages with a real Chromium.
 *
 * Why a browser and not plain HTTP: mercadolivre.com.br serves a proof-of-work
 * bot challenge to non-browser clients, so a fetch() gets a challenge page
 * instead of products. A real browser clears it.
 *
 * Extraction is deliberately layered, most-stable first:
 *   1. JSON-LD  (<script type="application/ld+json">, schema.org/Product)
 *   2. __PRELOADED_STATE__ embedded JSON blob
 *   3. DOM selectors (.andes-money-amount etc.)
 * If ML reshuffles their markup, one layer usually still survives.
 */

import { config } from '../config.mjs';

let browserPromise = null;

/** Launch once, reuse. Falls back through the browser binaries we can find. */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      let chromium;
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        throw new Error(
          'Playwright is not installed. Run: npm install && npx playwright install chromium'
        );
      }

      const attempts = [
        // Prefer the user's installed Chrome: no download, most "normal" fingerprint.
        { headless: true, channel: 'chrome', args: ['--no-sandbox'] },
        // Then Playwright's own Chromium.
        { headless: true, args: ['--no-sandbox'] },
      ];

      const errors = [];
      for (const opts of attempts) {
        try {
          const b = await chromium.launch(opts);
          b.on('disconnected', () => {
            browserPromise = null;
          });
          return b;
        } catch (err) {
          errors.push(err.message.split('\n')[0]);
        }
      }
      throw new Error(
        `Could not launch a browser.\n  ${errors.join('\n  ')}\n` +
          'Fix: install Google Chrome, or run: npx playwright install chromium'
      );
    })();
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    await b?.close().catch(() => {});
  }
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function withPage(fn) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(config.timeoutSeconds * 1000);
  // Kill heavy assets we never read; makes polling much faster.
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });
  try {
    return await fn(page);
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ------------------------------ helpers --------------------------------- */

/** "R$ 1.234,56" / "1234,56" / 1234.56 -> 1234.56 */
export function parsePrice(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : null;

  let s = String(input).replace(/[^\d.,-]/g, '').trim();
  if (!s) return null;

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    // Both present: whichever comes last is the decimal mark.
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (hasComma) {
    // pt-BR uses comma as the decimal mark, so "12,50" is 12.50.
    // A comma followed by exactly 3 digits is almost certainly thousands.
    s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (hasDot) {
    // Dots only. In BRL a dot is a thousands separator, so "1.234" and
    // "1.234.567" are whole numbers; "1.23" is a decimal.
    s = /\.\d{3}(?:\.|$)/.test(s) ? s.replace(/\./g, '') : s;
  }

  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pull every balanced {...} JSON blob out of a raw HTML string. */
function* jsonCandidates(html) {
  const marker = /<script[^>]+type=["']application\/ld\+json["'][^>]*>/gi;
  let m;
  while ((m = marker.exec(html))) {
    const start = html.indexOf('>', m.index) + 1;
    const end = html.indexOf('</script>', start);
    if (end > start) {
      const raw = html.slice(start, end).trim();
      try {
        yield JSON.parse(raw);
      } catch {
        /* ignore malformed blocks */
      }
    }
  }
}

function flattenLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((n) => flattenLd(n, out));
  } else if (typeof node === 'object') {
    out.push(node);
    if (node['@graph']) flattenLd(node['@graph'], out);
  }
  return out;
}

function availabilityToBool(av) {
  if (av == null) return true;
  const s = String(av).toLowerCase();
  return !(s.includes('outofstock') || s.includes('soldout') || s.includes('discontinued'));
}

/* --------------------------- page extraction ---------------------------- */

/**
 * Parse a product page. Returns a normalised product object or throws when the
 * page clearly isn't a product (e.g. we got bounced to a challenge).
 */
async function extractProduct(page) {
  const html = await page.content();

  // --- layer 1: JSON-LD
  for (const block of jsonCandidates(html)) {
    const nodes = flattenLd(block);
    const product = nodes.find(
      (n) =>
        n &&
        (n['@type'] === 'Product' ||
          (Array.isArray(n['@type']) && n['@type'].includes('Product')))
    );
    if (product) {
      const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      const price = parsePrice(offer?.price ?? offer?.lowPrice);
      if (price) {
        return {
          title: product.name?.trim() || null,
          price,
          listPrice: parsePrice(offer?.highPrice) ?? null,
          currency: offer?.priceCurrency || 'BRL',
          available: availabilityToBool(offer?.availability),
          rating: product.aggregateRating?.ratingValue
            ? Number(product.aggregateRating.ratingValue)
            : null,
          reviews: product.aggregateRating?.reviewCount
            ? Number(product.aggregateRating.reviewCount)
            : null,
          image: Array.isArray(product.image) ? product.image[0] : product.image || null,
          seller: offer?.seller?.name || null,
          source: 'browser:ld+json',
        };
      }
    }
  }

  // --- layers 2 + 3: DOM, evaluated in the page
  const dom = await page.evaluate(() => {
    const text = (el) => el?.textContent?.trim() || null;
    const num = (el) => {
      if (!el) return null;
      const frac = el.querySelector?.('.andes-money-amount__fraction');
      const cents = el.querySelector?.('.andes-money-amount__cents');
      if (frac) return text(frac) + (cents ? '.' + text(cents) : '');
      return text(el);
    };

    const title =
      text(document.querySelector('h1.ui-pdp-title')) ||
      text(document.querySelector('h1')) ||
      null;

    // Current price: the "primary" block, else the first visible money amount.
    const priceEl =
      document.querySelector('.ui-pdp-price__second-line .andes-money-amount') ||
      document.querySelector('[data-testid="price-part"] .andes-money-amount') ||
      document.querySelector('.andes-money-amount--previous ~ .andes-money-amount') ||
      document.querySelector('.ui-pdp-price .andes-money-amount');
    const listEl = document.querySelector(
      '.ui-pdp-price__original-value .andes-money-amount, .andes-money-amount--previous'
    );

    const availText = text(document.querySelector('.ui-pdp-stock-information, .ui-pdp-buybox'));
    const ratingEl = document.querySelector('.ui-pdp-review__rating, [data-testid="rating"]');
    const reviewsEl = document.querySelector('.ui-pdp-review__amount');
    const sellerEl = document.querySelector(
      '.ui-pdp-seller__link-trigger, .ui-box-component__title, [data-testid="seller-name"]'
    );
    const imgEl = document.querySelector('.ui-pdp-image, figure img');

    const shipping = /chegar[áa]? gr[áa]tis|frete gr[áa]tis/i.test(document.body.innerText || '');

    return {
      title,
      price: num(priceEl),
      listPrice: num(listEl),
      available: availText ? !/sem estoque|indispon/i.test(availText) : true,
      rating: ratingEl ? Number(text(ratingEl)?.replace(',', '.')) || null : null,
      reviews: reviewsEl ? Number(text(reviewsEl)?.replace(/\D/g, '')) || null : null,
      seller: text(sellerEl),
      image: imgEl?.getAttribute('src') || imgEl?.getAttribute('data-src') || null,
      freeShipping: shipping,
    };
  });

  const price = parsePrice(dom.price);
  if (!price) {
    const title = await page.title();
    throw new Error(
      `Could not read a price (page title: "${title}"). ` +
        'The listing may be paused, or Mercado Livre served a verification page.'
    );
  }

  return {
    title: dom.title,
    price,
    listPrice: parsePrice(dom.listPrice),
    currency: 'BRL',
    available: dom.available,
    rating: dom.rating,
    reviews: dom.reviews,
    image: dom.image,
    seller: dom.seller,
    freeShipping: dom.freeShipping,
    source: 'browser:dom',
  };
}

/* ------------------------------- public API ----------------------------- */

export async function fetchProduct(url) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Let the challenge script run and the price render.
    await page.waitForTimeout(2500);
    return extractProduct(page);
  });
}

/**
 * Keyword search. Returns lightweight candidates so the user can add one to
 * the watchlist.
 */
export async function searchProducts(query, limit = 24) {
  const url = `https://lista.mercadolivre.com.br/${encodeURIComponent(
    query.trim().replace(/\s+/g, '-')
  )}`;

  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const items = await page.evaluate((max) => {
      const out = [];
      const cards = document.querySelectorAll(
        'li.ui-search-layout__item, .poly-card, .ui-search-result__wrapper'
      );
      for (const card of cards) {
        if (out.length >= max) break;
        const titleEl = card.querySelector(
          '.poly-component__title, .ui-search-item__title, h2'
        );
        const linkEl = card.querySelector('a.poly-component__title, a.ui-search-link, a');
        const amountEl = card.querySelector('.andes-money-amount');
        const frac = amountEl?.querySelector('.andes-money-amount__fraction');
        const cents = amountEl?.querySelector('.andes-money-amount__cents');
        const prevFrac = card.querySelector(
          '.andes-money-amount--previous .andes-money-amount__fraction'
        );
        const img = card.querySelector('img');
        if (!titleEl || !frac) continue;
        out.push({
          title: titleEl.textContent.trim(),
          price: frac.textContent.trim() + (cents ? '.' + cents.textContent.trim() : ''),
          listPrice: prevFrac ? prevFrac.textContent.trim() : null,
          href: linkEl?.href || null,
          image: img?.getAttribute('data-src') || img?.getAttribute('src') || null,
          freeShipping: /gr[áa]tis/i.test(card.textContent || ''),
        });
      }
      return out;
    }, limit);

    return items
      .map((i) => ({
        title: i.title,
        price: parsePrice(i.price),
        listPrice: parsePrice(i.listPrice),
        url: i.href ? i.href.split('#')[0] : null,
        image: i.image,
        freeShipping: i.freeShipping,
      }))
      .filter((i) => i.price && i.url);
  });
}
