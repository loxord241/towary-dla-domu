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
const catalogSrc = () => read('app/lib/catalog.ts');

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
  const dataPart = sliceBetween(src, '// ---- paged data query ----', '// Every sort gets');
  assert.ok(dataPart.includes(EXCLUSION), 'data query must exclude wc-*');
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
  const likes = body.match(/\.like\('sku', WALLPAPER_SKU_LIKE\)/g) ?? [];
  assert.equal(likes.length, 2, 'both the count and the data query carry sku like');
  assert.match(body, /ELIGIBLE_COUNT_SELECT/, 'same eligibility join for the count');
  assert.match(body, /CATALOG_CARD_SELECT/, 'slim card projection for the grid');
  assert.match(body, /\.order\('id'/, 'deterministic tiebreaker kept');
  assert.match(body, /\.range\(\(page - 1\) \* size, page \* size - 1\)/, 'paged window');
  assert.match(body, /throw new Error/, 'count/data errors must rethrow');
});

// ---- static: /oboi page, sitemap, home ----

test('OBOI: page exists with exactly one h1, chips, grid and pagination', () => {
  const page = read('app/oboi/page.tsx');
  assert.equal((page.match(/<h1/g) ?? []).length, 1, 'exactly one h1');
  assert.match(page, /<h1 className="text-2xl font-bold">Шпалери<\/h1>/);
  assert.match(page, /buildWallpapersMetadata/, 'metadata from the seo policy');
  assert.match(page, /WALLPAPER_CATEGORY_MAP/, 'chips come from the importer map');
  assert.match(page, /\/catalog\?category=\$\{encodeURIComponent\(subcategory\.slug\)\}/,
    'chips deep-link into the wallpaper-scoped /catalog views');
  assert.match(page, /fetchWallpaperProducts/, 'wc-* domain data source');
  assert.match(page, /<ProductCard/, 'reuses ProductCard');
  assert.match(page, /buildPageWindow/, 'catalog-style page window');
  assert.equal((page.match(/<span aria-disabled="true"/g) ?? []).length, 2,
    'prev+next inactive sides pinned (P3-R2 contract)');
  assert.match(page, /<Announcements\s*\/>/);
  assert.doesNotMatch(page, /SearchViewTracker|<form/, 'v1: no search on /oboi');
  assert.equal((page.match(/<main/g) ?? []).length, 1, 'exactly one main landmark');
});

test('OBOI: sitemap lists /oboi in the static set (indexable set = sitemap set)', () => {
  const src = read('app/sitemap.ts');
  assert.match(src, /'\/oboi'/, '/oboi must be a static sitemap entry');
  assert.match(src, /DU_REDIRECT_SLUGS\.has/, 'product filter unchanged');
});

// ---- static: home page buttons ----

test('HOME: two catalog entry cards with correct hrefs', () => {
  const home = read('app/(home)/page.tsx');
  const blockStart = home.indexOf('Каталог техніки');
  const blockEnd = home.indexOf('Каталог шпалер');
  assert.ok(blockStart !== -1 && blockEnd > blockStart, 'both cards present');
  const block = home.slice(
    home.lastIndexOf('<section', blockStart),
    home.indexOf('</section>', blockEnd)
  );
  assert.match(block, /href="\/catalog"/);
  assert.match(block, /href="\/oboi"/);
  assert.match(block, /motion-reduce:transition-none/, 'hover transitions respect motion-reduce');
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

    // General catalog: BOTH the count and the data request exclude wc-*.
    const catalog = await fetchCatalogProducts({ page: 1, size: 12 });
    const catalogRequests = requests.splice(0);
    assert.equal(catalogRequests.length, 2, 'one head-count + one data window');
    for (const r of catalogRequests) {
      assert.equal(r.sku, 'not.like.wc-%', `general listing must exclude wc-* (${r.method})`);
    }
    assert.equal(catalog.total, TOTAL);
    assert.equal(catalog.products.length, rows.length);

    // /oboi: BOTH requests restrict to wc-*.
    const wallpaper = await fetchWallpaperProducts({ page: 1, size: 12 });
    const wallpaperRequests = requests.splice(0);
    assert.equal(wallpaperRequests.length, 2, 'one head-count + one data window');
    for (const r of wallpaperRequests) {
      assert.equal(r.sku, 'like.wc-%', `/oboi must restrict to wc-* (${r.method})`);
    }
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
