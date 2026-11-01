# Data Sources

MercadoTrack never invents a price. Every number in the database came from one of
two adapters, and each snapshot records which one produced it in
`snapshots.source`.

```
lib/sources/index.mjs   router: activeSource(), fetchForItem(), search(), closeBrowser()
        ├── browser.mjs  Playwright + real Chromium  (source: "browser:ld+json" / "browser:dom")
        └── api.mjs      api.mercadolibre.com        (source: "api")
```

Both adapters return the same normalised shape, which is the only contract the
poller knows about:

```js
{
  title, price, listPrice, currency, available,
  freeShipping, rating, reviews, image, seller, source
}
```

`price` is the one field that must be a positive number. If an adapter cannot
produce it, it **throws** — it never returns `price: null`. That single rule is
what stops a failed scrape from being stored as "the price is nothing".

---

## Why there is no price history to import

This is the constraint that shapes the entire product.

Mercado Livre exposes **no historical price endpoint**. There is no equivalent of
Keepa's backfill, no public "price over time" API, no archive to scrape. The
history in this app is *self-accumulated*: it starts the day an item is added and
grows one snapshot per poll.

Consequences you must design around:

- A newly added item has no median, so `stats.score` is `null` until there are
  observations to compare against. The UI says "coletando histórico" rather than
  showing a meaningless 0%.
- The "all-time low" alert requires at least **two** snapshots before it can
  fire, because "low" is a comparison.
- Deleting the database deletes the only copy of that history. Back it up.

---

## The bot challenge (why `browser` is the default)

Every unauthenticated Mercado Livre endpoint was probed during development. The
results, which are the reason the browser path exists at all:

| Endpoint | Result |
|---|---|
| `GET /sites` | `403 {"message":"forbidden"}` |
| `GET /sites/MLB` | `403` |
| `GET /sites/MLB/search` | `403` |
| `GET /sites/MLB/categories` | `403` |
| `GET /trends/MLB` | `403` |
| `GET /items/MLB1234` | `403 {"blocked_by":"PolicyAgent","code":"PA_UNAUTHORIZED_RESULT_FROM_POLICIES"}` |
| `GET /products/MLB1234` | `401 {"code":"unauthorized","message":"authorization value not present"}` |
| `GET /items?ids=...` | `401` |

`/products/*` returning `401` instead of `403` is the important detail: it is
**not** IP-blocked, it simply wants a token. That is the whole basis of the
optional API path.

Browser-ish headers (`Origin`, `Referer`, `Accept-Language`) changed none of the
above.

On the HTML side:

| Request | Result |
|---|---|
| `lista.mercadolivre.com.br/...` | `302` → `/gz/account-verification` |
| `www.mercadolivre.com.br/p/MLB1234` | `200`, but the body is a `suspicious-traffic-frontend` proof-of-work challenge shell |
| Googlebot UA | `200`, 11.5 KB, `<title>` present, **zero prices** |

Only a real browser that executes the challenge script clears it. Hence
Playwright, `waitForTimeout(2500)` after `domcontentloaded`, and the 2500/3000 ms
waits you will see in the code.

> **Rule for contributors:** do not "optimise" those waits away. They are not
> sloppiness, they are the challenge-solving window. Removing them turns every
> fetch into `Could not read a price`.

---

## `browser.mjs`

### Launch strategy

```js
const attempts = [
  { headless: true, channel: 'chrome', args: ['--no-sandbox'] }, // user's Chrome
  { headless: true, args: ['--no-sandbox'] },                    // Playwright's Chromium
];
```

Preferring `channel: 'chrome'` means no 150 MB download for most users and the
most ordinary fingerprint available. If Chrome is missing it falls through to
Playwright's own binary. If both fail, the thrown message names both causes and
tells you the exact fix command.

The browser is launched **once** and reused (`browserPromise` is a memoised
promise, so concurrent callers share one launch). A `disconnected` listener nulls
the cache so a crashed browser is relaunched on the next poll instead of being
handed out broken.

### Per-page context

| Setting | Value | Why |
|---|---|---|
| `locale` | `pt-BR` | Prices and "frete grátis" render in the expected language |
| `timezoneId` | `America/Sao_Paulo` | Consistent with a Brazilian visitor |
| `userAgent` | Chrome 131 / macOS | Recent and unremarkable |
| `viewport` | 1366×900 | Lazy-loaded price blocks require a real viewport |
| `Accept-Language` | `pt-BR,pt;q=0.9,en;q=0.8` | |
| blocked resources | `image`, `media`, `font` | Never read; aborted for speed |

Images are blocked **for fetching** but the `src`/`data-src` attributes remain in
the DOM, which is all we need for thumbnails. This cuts page weight dramatically
and is the cheapest performance win in the codebase.

A fresh context is created per page and closed in a `finally`, so cookies and
storage never leak between items — a stale session cookie is a classic cause of
"worked yesterday, challenge page today".

### Extraction layers

The header comment describes three layers; **two are implemented today**, most
stable first:

**Layer 1 — JSON-LD (`browser:ld+json`).** Every `<script type="application/ld+json">`
block is collected by `jsonCandidates()`, parsed (malformed blocks are skipped
individually), flattened with `flattenLd()` — which recurses through arrays and
`@graph` — and the first node whose `@type` is `Product` wins. Price comes from
`offers.price ?? offers.lowPrice`, with `offers.highPrice` treated as the
crossed-out list price. This is the most stable path because it is schema.org,
not their CSS class names.

**Layer 2 — DOM (`browser:dom`).** Evaluated inside the page via
`page.evaluate()`, so it reads the rendered DOM rather than the raw HTML:

| Field | Selectors, in priority order |
|---|---|
| title | `h1.ui-pdp-title` → `h1` |
| price | `.ui-pdp-price__second-line .andes-money-amount` → `[data-testid="price-part"] .andes-money-amount` → `.andes-money-amount--previous ~ .andes-money-amount` → `.ui-pdp-price .andes-money-amount` |
| list price | `.ui-pdp-price__original-value .andes-money-amount`, `.andes-money-amount--previous` |
| availability | `.ui-pdp-stock-information`, `.ui-pdp-buybox` (negated on `sem estoque`/`indispon`) |
| rating | `.ui-pdp-review__rating`, `[data-testid="rating"]` |
| reviews | `.ui-pdp-review__amount` |
| seller | `.ui-pdp-seller__link-trigger`, `.ui-box-component__title`, `[data-testid="seller-name"]` |
| image | `.ui-pdp-image`, `figure img` |
| free shipping | regex on `document.body.innerText` |

Prices are assembled from the split `.andes-money-amount__fraction` +
`__cents` spans (`"1.234" + "." + "56"`) rather than read as one string, because
that is how the component actually renders and the raw text concatenates
unpredictably.

**Layer 3 — `__PRELOADED_STATE__`.** Referenced in the file header but **not
implemented**. It is the natural next fallback: the page ships a large JSON blob
with the product model. Adding it is a well-scoped first contribution — see
[`ROADMAP.md`](ROADMAP.md).

If no layer yields a price, the thrown error includes the page `<title>`, which
is the single most useful diagnostic: `"Just a moment..."` means challenge,
`"Página não encontrada"` means delisted, a normal title means the selectors
drifted.

### `parsePrice()` — the subtle one

This function is exported and unit-tested because Brazilian number formatting is
genuinely ambiguous. Rules, in order:

| Input | Output | Reason |
|---|---|---|
| `"R$ 1.234,56"` | `1234.56` | Both marks: the **last** one is the decimal |
| `"1.299"` | `1299` | Dot + exactly 3 digits ⇒ thousands |
| `"1.23"` | `1.23` | Dot + 2 digits ⇒ decimal |
| `"12,50"` | `12.5` | Comma + 2 digits ⇒ decimal (pt-BR) |
| `"1,234"` | `1234` | Comma + exactly 3 digits ⇒ thousands |
| `"1.234.567"` | `1234567` | Repeated dots ⇒ thousands |
| `0`, `-5`, `""`, `null` | `null` | A price must be **positive** |

Two bugs found during the build are encoded here: `"R$ 1.234"` was originally
read as `1.234` (a 1000× error, and the exact case that a real listing produces),
and `0` was accepted as a valid price.

### `searchProducts(query, limit = 24)`

Scrapes `lista.mercadolivre.com.br/<query-with-dashes>` for
`li.ui-search-layout__item`, `.poly-card`, `.ui-search-result__wrapper` cards,
extracting title, price, previous price, link, image and free shipping. Results
are filtered with `.filter(i => i.price && i.url)` — a card without a readable
price is dropped rather than shown as "R$ —".

The list page is the most challenge-prone surface. A `502` from `/api/search` is
normal and expected; typing a direct product URL always works.

---

## `api.mjs`

The official path. Requires a free developer application.

1. Register at [developers.mercadolivre.com.br](https://developers.mercadolivre.com.br)
   and create an app. The redirect URI can be `https://localhost` for a local app.
2. Authorise once in a browser to get `code`, then exchange it for tokens:

```bash
curl -X POST https://api.mercadolibre.com/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=authorization_code \
  -d client_id=$ML_CLIENT_ID \
  -d client_secret=$ML_CLIENT_SECRET \
  -d code=$CODE \
  -d redirect_uri=https://localhost
```

3. Put `clientId`, `clientSecret`, `accessToken`, `refreshToken` into
   `config.json` (or the matching `ML_*` env vars) and set `"source": "api"`.

### Endpoints used

- `GET https://api.mercadolibre.com/products/{id}` — the multi-item product
  endpoint. This is the one that returns `401` (needs a token) rather than `403`
  (blocked), which is what makes it usable.
- `POST https://api.mercadolibre.com/oauth/token` with
  `grant_type=refresh_token` when the access token is within 60 s of expiry.
  The new tokens are written back to `config.json` immediately so a restart does
  not force a re-auth.

### When to prefer it

- You poll many items and want to be a good citizen.
- You want structured data instead of CSS selectors.
- You need the app to survive a markup redesign.

### When not to

- You want zero setup. The browser path needs no account at all.
- The product id is not resolvable (some listings are item-only, not product).

If `source: "api"` is set without credentials, `activeSource()` throws a clear
configuration error rather than silently degrading — silent fallback is how you
end up debugging the wrong adapter.

---

## Router: `sources/index.mjs`

```js
activeSource()   // 'api' when configured and requested, else 'browser'
fetchForItem(it) // dispatch + translate to the normalised shape
search(q)        // dispatch; only the browser adapter implements it today
closeBrowser()   // shutdown hook, called on SIGINT/SIGTERM
```

`auto` resolves to `api` only when `ml.clientId` **and** an access/refresh token
exist. Anything else is `browser`.

---

## Adding a third source

The contract is two functions. Copy `browser.mjs` as a template:

```js
// lib/sources/foo.mjs
export async function fetchProduct(url) { /* → normalised shape */ }
export async function searchProducts(query, limit) { /* → [{title, price, url, image}] */ }
```

Then register it in `sources/index.mjs`'s resolver and document it in
[`CONFIGURATION.md`](CONFIGURATION.md) under `source`. Nothing else in the app
needs to change — the poller only knows `fetchForItem()`.

Requirements for a new adapter:

- **Throw** when you cannot read a price. Never return a guess.
- Set `source` to a value that identifies the adapter *and* the code path
  (`browser:ld+json`, `api`), because it is the first thing you will look at when
  a snapshot looks wrong.
- Respect `config.timeoutSeconds`; the poller will kill you at
  `timeoutSeconds + 30 s` and record a failure.
