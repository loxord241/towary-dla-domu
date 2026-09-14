/**
 * Wallpapers storefront separation (owner task 2026-09-10).
 *
 * The wc-* sku domain lives on /oboi and is hidden from every GENERAL
 * storefront listing: fetchCatalogProducts (count + data), the home shelves
 * (fetchProducts/featured, fetchSelectedProducts, fetchPopularProducts),
 * brand counts and the related-products stages of non-wallpaper PDPs.
 * A category view scoped to the wallpaper subtree (shpaleri-*) KEEPS its
 * wc-* products — /oboi's chips deep-link there — and the Task #14
 * non-empty counts mirror the same decision so the «indexable set =
 * sitemap set» invariant survives.
 *
 * Pins: static source invariants per function slice (the established
 * pattern) + runtime proof over a fake PostgREST (the sku filter must
 * actually reach the wire on BOTH the count and the data query).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string =>
  readFileSync(path.join(root, rel), 'utf8');

function sliceBetween(
  src: string,
  startMarker: string,
  endMarker: string
): string {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, `marker missing: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  return src.slice(start, end === -1 ? undefined : end);
}

const EXCLUSION = `.not('sku', 'like', WALLPAPER_SKU_LIKE)`;
// 2026-09 refactor: the catalog god-module was split into app/lib/catalog/* —
// the pins below read every fragment (original file order).
const CATALOG_LIB_FILES = [
  'app/lib/catalog/shared.ts',
  'app/lib/catalog/filters.ts',
  'app/lib/catalog/slug-lookup.ts',
  'app/lib/catalog/product-feed.ts',
  'app/lib/catalog/counts.ts',
  'app/lib/catalog/listing.ts',
  'app/lib/catalog/wallpaper-listing.ts',
  'app/lib/catalog/reviews.ts',
  'app/lib/catalog/shelves.ts',
  'app/lib/catalog/categories.ts',
  'app/lib/catalog/search.ts',
  'app/lib/catalog/product-card.ts',
  'app/lib/catalog/related.ts',
];
const catalogSrc = () =>
  CATALOG_LIB_FILES.map((rel) => read(rel)).join('\n');

// ---- static: general listings exclude wc-* ----

test('WALLPAPER: fetchProducts (home featured/selected legs) excludes wc-*', () => {
  const body = sliceBetween(
    catalogSrc(),
    'async function fetchProducts',
    '/** Sanitize a user-supplied search term'
  );
  assert.match(body, new RegExp(EXCLUSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('WALLPAPER: fetchSelectedProducts excludes wc-*', () => {
  const body = sliceBetween(
    catalogSrc(),
    'export async function fetchSelectedProducts',
    'export const POPULAR_LIMIT'
  );
  assert.ok(body.includes(EXCLUSION));
});

test('WALLPAPER: fetchPopularProducts excludes wc-* (before the bounded window)', () => {
  const body = sliceBetween(
    catalogSrc(),
    'async function fetchPopularProducts',
    'export async function fetchActiveCategories'
  );
  assert.ok(body.includes(EXCLUSION));
  const notIdx = body.indexOf(".not('sku', 'like'");
  const rangeIdx = body.indexOf('.range(');
  assert.ok(notIdx !== -1 && rangeIdx !== -1 && notIdx < rangeIdx,
    'sku exclusion must precede the bounded window so backfill stays honest');
});

test('WALLPAPER: fetchCatalogProducts count + data queries exclude wc-*', () => {
  const src = catalogSrc();
  const countPart = sliceBetween(
    src,
    '-- total count with identical filters',
    'const total = count ?? 0;'
  );
  assert.ok(countPart.includes(EXCLUSION), 'count query must exclude wc-*');
  assert.match(
    countPart,
    /if \(hideWallpapers\)/,
    'exclusion is conditional: an active search keeps wallpapers (2026-09-11)'
  );
  const dataPart = sliceBetween(src, '// ---- paged data query ----', '// Every sort gets');
  assert.ok(dataPart.includes(EXCLUSION), 'data query must exclude wc-*');
  assert.match(dataPart, /if \(hideWallpapers\)/, 'data guard mirrors the count guard');
  assert.ok(dataPart.includes(`.in('pc.category_id', subtreeIds)`));
});

test('WALLPAPER: view counts mirror the catalog decision (noindex contract)', () => {
  const src = catalogSrc();
  const categoryCount = sliceBetween(
    src,
    'async function countCategoryProductsUncached',
    'const countCategoryProductsStore'
  );
  assert.match(
    categoryCount,
    /isWallpaperView[\s\S]*?if \(!isWallpaperView\) \{[\s\S]*?not\('sku', 'like', WALLPAPER_SKU_LIKE\)/,
    'category counts: wallpaper-scoped views count wc-*, the rest exclude'
  );
  const brandCount = sliceBetween(
    src,
    'async function countBrandProductsUncached',
    'export const fetchBrandProductCount'
  );
  assert.ok(brandCount.includes(EXCLUSION), 'brand views are general listings');
});

test('WALLPAPER: shpaleri-* category views keep the wallpaper domain (chips target)', () => {
  const src = catalogSrc();
  const head = sliceBetween(
    src,
    'export async function fetchCatalogProducts',
    '-- total count with identical filters'
  );
  assert.match(head, /WALLPAPER_CATEGORY_SLUGS/, 'wallpaper slugs come from the importer map');
  assert.match(
    head,
    /isWallpaperView =[\s\S]*?subtreeIds\.includes\(category\.id\)/,
    'the escape is scoped to the wallpaper subtree only'
  );
});

test('WALLPAPER: related stages stay inside the current product sku domain', () => {
  const stage = sliceBetween(
    catalogSrc(),
    'async function fetchRelatedStage',
    'export async function fetchRelatedProducts'
  );
  assert.match(stage, /skuDomain === 'wallpaper'/, 'wallpaper PDP → wc-* candidates');
  assert.ok(stage.includes(EXCLUSION), 'non-wallpaper PDP → no wc-* candidates');
  const store = sliceBetween(
    catalogSrc(),
    'const fetchRelatedProductsStore',
    'export interface WallpaperPage'
  );
  assert.match(store, /startsWith\(WALLPAPER_SKU_PREFIX\)/, 'domain derived from sku');
  assert.match(
    catalogSrc(),
    /Pick<Product, 'id' \| 'category_id' \| 'brand_id' \| 'sku'>/,
    'identity carries sku'
  );
});

test('WALLPAPER: fetchWallpaperProducts queries ONLY the wc- domain', () => {
  const body = sliceBetween(
    catalogSrc(),
    'export async function fetchWallpaperProducts',
    'Product reviews'
  );
  // Perf 2026-09-13: ONE merged count+data request — the sku like filter
  // appears exactly once, and the total comes from count:'exact' on the
  // same request (no separate head-count).
  const likes = body.match(/\.like\('sku', WALLPAPER_SKU_LIKE\)/g) ?? [];
  assert.equal(likes.length, 1, 'the merged count+data query carries sku like');
  assert.match(body, /\.select\(CATALOG_CARD_SELECT, \{ count: 'exact' \}\)/,
    'total travels with the page rows (Content-Range), no head-count');
  assert.doesNotMatch(body, /head:\s*true/, 'no separate head-count request');
  // The eligibility join lives inside CATALOG_CARD_SELECT (product_images!inner).
  assert.match(body, /CATALOG_CARD_SELECT/, 'slim card projection for the grid');
  assert.match(body, /\.order\('id'/, 'deterministic tiebreaker kept');
  assert.match(body, /\.range\(\(page - 1\) \* size, page \* size - 1\)/, 'paged window');
  assert.match(body, /throw new Error/, 'count/data errors must rethrow');
});

// ---- static: /oboi page, sitemap, home ----

test('OBOI: page exists with exactly one h1, chips, grid and pagination', () => {
  // ISR split (2026-09-14): the markup lives on the shared OboiStorefront
  // both /oboi routes render through; the ISR page owns metadata + data.
  const shelf = read('app/oboi/OboiStorefront.tsx');
  assert.equal((shelf.match(/<h1/g) ?? []).length, 1, 'exactly one h1');
  assert.match(shelf, /<h1 className="text-2xl font-bold">Шпалери<\/h1>/);
  assert.match(shelf, /WALLPAPER_CATEGORY_MAP/, 'chips come from the importer map');
  assert.match(shelf, /\/catalog\/\$\{encodeURIComponent\(subcategory\.slug\)\}/,
    'chips deep-link into the wallpaper-scoped /catalog views (path form)');
  assert.match(shelf, /<ProductCard/, 'reuses ProductCard');
  assert.match(shelf, /buildPageWindow/, 'catalog-style page window');
  assert.equal((shelf.match(/<span aria-disabled="true"/g) ?? []).length, 2,
    'prev+next inactive sides pinned (P3-R2 contract)');
  assert.match(shelf, /<Announcements\s*\/>/);
  assert.doesNotMatch(shelf, /SearchViewTracker|<form/, 'v1: no search on /oboi');
  assert.equal((shelf.match(/<main/g) ?? []).length, 1, 'exactly one main landmark');

  const page = read('app/oboi/page.tsx');
  assert.match(page, /buildWallpapersMetadata/, 'metadata from the seo policy');
  assert.match(page, /fetchWallpaperProducts/, 'wc-* domain data source');
});

test('OBOI: sitemap lists /oboi in the static set (indexable set = sitemap set)', () => {
  const src = read('app/sitemap.ts');
  assert.match(src, /'\/oboi'/, '/oboi must be a static sitemap entry');
  assert.match(src, /DU_REDIRECT_SLUGS\.has/, 'product filter unchanged');
});

// ---- static: home page buttons ----

test('HOME: two catalog buttons live in the blue hero (owner, 2026-09-11)', () => {
  const home = read('app/(home)/page.tsx');
  const heroStart = home.indexOf('bg-gradient-to-br from-blue-700');
  assert.ok(heroStart !== -1, 'blue hero section present');
  const heroEnd = home.indexOf('</section>', heroStart);
  const hero = home.slice(heroStart, heroEnd);
  const tech = hero.indexOf('Каталог техніки');
  const shp = hero.indexOf('Каталог шпалер');
  assert.ok(tech !== -1 && shp > tech, 'both buttons present inside the hero');
  assert.match(hero, /href="\/catalog"/);
  assert.match(hero, /href="\/oboi"/);
  // showcase cards block below the hero must stay removed
  assert.ok(!home.includes('Дві вітрини'), 'showcase cards block removed');
});

// ---- pure seo policy ----

const { buildWallpapersMetadata, OBOI_CANONICAL_PATH } = await import(
  '../app/lib/seo.ts'
);

test('OBOI SEO: page 1 is indexable with canonical /oboi', () => {
  assert.equal(OBOI_CANONICAL_PATH, '/oboi');
  const meta = buildWallpapersMetadata();
  assert.match(String(meta.title), /Шпалери/);
  assert.ok(meta.description && meta.description.length > 0);
  assert.equal(meta.robots, undefined, 'page 1 must stay indexable (no robots tag)');
  assert.deepEqual(meta.alternates, { canonical: '/oboi' });
});

test('OBOI SEO: page 1 carries og:title/og:description with the full og fields (audit 2026-09-13)', () => {
  const meta = buildWallpapersMetadata();
  assert.ok(meta.openGraph, '/oboi must set its own og — the layout default won the repost before');
  assert.equal(meta.openGraph!.title, 'Шпалери — купити в Товари для дому');
  assert.equal(meta.openGraph!.description, meta.description);
  // Page-level og REPLACES the layout object (shallow merge) — locale/
  // type/siteName and the default image must be repeated here.
  assert.equal(meta.openGraph!.locale, 'uk_UA');
  // `.type` sits on one member of Next's OpenGraph union — structural cast.
  assert.equal((meta.openGraph as unknown as { type: string }).type, 'website');
  assert.equal(meta.openGraph!.siteName, 'Товари для дому');
  assert.deepEqual(meta.openGraph!.images, ['/og-image.png']);
  assert.equal(meta.openGraph!.url, undefined, 'canonical lives in alternates');
});

test('OBOI SEO: noindex filtered views carry og too (harmless, previews stay meaningful)', () => {
  const meta = buildWallpapersMetadata(2);
  assert.ok(meta.openGraph);
  assert.equal(meta.openGraph!.title, 'Шпалери — купити в Товари для дому');
  assert.equal(meta.openGraph!.description, meta.description);
});

test('OBOI SEO: deep pagination is noindex,follow WITHOUT a canonical', () => {
  const meta = buildWallpapersMetadata(2);
  assert.deepEqual(meta.robots, { index: false, follow: true });
  assert.equal(meta.alternates, undefined, 'no canonical on noindex pages');
});

// ---- runtime: the sku filter must reach the wire ----

test('RUNTIME: general catalog count+data carry sku=not.like.wc-; /oboi carries sku=like.wc-', async () => {
  const TOTAL = 42;
  const mkRow = (i: number) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `Товар ${i}`,
    slug: `s${i}`,
    price: 100 + i,
    old_price: null,
    currency: 'UAH',
    availability_status: 'in_stock',
    brand: null,
    images: [],
  });
  const rows = [1, 2, 3].map(mkRow);

  const http = await import('node:http');
  const requests: { method: string; sku: string | null; params: URLSearchParams }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({
      method: req.method ?? 'GET',
      sku: url.searchParams.get('sku'),
      params: url.searchParams,
    });
    if (req.method === 'HEAD') {
      // head-count request: supabase-js parses count from Content-Range
      res.writeHead(200, { 'Content-Range': `*/${TOTAL}` });
      res.end();
      return;
    }
    const from = Number(url.searchParams.get('offset') ?? 0);
    const lim = Number(url.searchParams.get('limit') ?? 12);
    const slice = rows.slice(from, from + lim);
    const last = from + slice.length - 1;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Range': `${slice.length > 0 ? `${from}-${last}` : '*/0'}/${TOTAL}`,
    });
    res.end(JSON.stringify(slice));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';
    const { fetchCatalogProducts, fetchWallpaperProducts, fetchPopularProducts } =
      await import('../app/lib/catalog.ts');

    // General catalog: the merged count+data request excludes wc-*
    // (perf 2026-09-13: no-search views fetch total + page in ONE request).
    const catalog = await fetchCatalogProducts({ page: 1, size: 12 });
    const catalogRequests = requests.splice(0);
    assert.equal(catalogRequests.length, 1, 'one merged count+data window');
    assert.equal(catalogRequests[0]?.sku, 'not.like.wc-%', 'general listing must exclude wc-*');
    assert.equal(catalog.total, TOTAL, 'total parsed from Content-Range');
    assert.equal(catalog.products.length, rows.length);

    // Search view (owner bug report 2026-09-11 «шукають "шпалери" — немає
    // результатів»): with an active search term NEITHER request may carry
    // the wc-% exclusion — wallpapers are a live storefront domain. The
    // search path keeps the two-query flow (fallbacks need the count first).
    await fetchCatalogProducts({ page: 1, size: 12, search: 'шпалери' });
    const searchRequests = requests.splice(0);
    assert.equal(searchRequests.length, 2, 'one head-count + one data window');
    for (const r of searchRequests) {
      assert.equal(r.sku, null, `search view must keep wc-* (${r.method})`);
    }

    // /oboi: the merged count+data request restricts to wc-*.
    const wallpaper = await fetchWallpaperProducts({ page: 1, size: 12 });
    const wallpaperRequests = requests.splice(0);
    assert.equal(wallpaperRequests.length, 1, 'one merged count+data window');
    assert.equal(wallpaperRequests[0]?.sku, 'like.wc-%', '/oboi must restrict to wc-*');
    assert.equal(wallpaper.total, TOTAL);

    // Home popular shelf: single bounded window with the exclusion.
    await fetchPopularProducts();
    const popularRequests = requests.splice(0);
    assert.equal(popularRequests.length, 1);
    assert.equal(popularRequests[0]?.sku, 'not.like.wc-%');
  } finally {
    server.close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).closeAllConnections?.();
  }
});
