/**
 * Linoleum storefront separation (owner plan 2026-09-17, vertical batch 1).
 *
 * The `ln-` sku domain (roll goods, card = design × width, products.price =
 * грн/погонный метр) is the THIRD product domain and MIRRORS the wallpaper
 * separation (owner task 2026-09-10): it is excluded from every GENERAL
 * storefront listing (bare /catalog, brand views, home feed) and stays
 * visible on (a) active-search views — the header search box is a
 * cross-domain surface, same rationale as wc-* (owner bug report
 * 2026-09-11) — and (b) category views scoped to the linoleum subtree
 * (root slug `linoleum`; subcategory slugs arrive with the batch-2
 * importer). Related products stay domain-scoped: ln-* PDP → ln-*
 * candidates, every other PDP sees neither wc-* nor ln-*. The staging
 * migration contract is pinned in linoleum-staging-migration.test.ts.
 *
 * Pins: the domains.ts vocabulary, static source invariants per function
 * slice (established pattern), and a runtime proof over a fake PostgREST
 * that BOTH sku exclusions reach the wire on general views and NEITHER
 * does on a search view.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

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

const WALLPAPER_NOT = `.not('sku', 'like', WALLPAPER_SKU_LIKE)`;
const LINOLEUM_NOT = `.not('sku', 'like', LINOLEUM_SKU_LIKE)`;

// ---- domain vocabulary (app/lib/domains.ts) ----

const domains = await import(
  pathToFileURL(path.join(root, 'app/lib/domains.ts')).href
) as typeof import('../app/lib/domains.ts');

test('LINOLEUM DOMAIN: prefix, like-pattern, slug classification', () => {
  assert.equal(domains.LINOLEUM_SKU_PREFIX, 'ln-');
  assert.equal(domains.LINOLEUM_SKU_LIKE, 'ln-%');
  assert.equal(domains.isLinoleumSlug('ln-12345-2m'), true);
  assert.equal(domains.isLinoleumSlug('wc-37589'), false);
  assert.equal(domains.isLinoleumSlug('UC-68682222'), false);
  assert.equal(domains.isLinoleumSlug(''), false);
  assert.equal(domains.isLinoleumSlug(null), false);
  assert.equal(domains.isLinoleumSlug(undefined), false);
  // domainOfSlug: the wallpaper branch keeps priority, linoleum is its own
  // domain, everything else stays tech (backward compatible with the
  // two-domain contract pinned in domains.test.ts).
  assert.equal(domains.domainOfSlug('ln-1'), 'linoleum');
  assert.equal(domains.domainOfSlug('wc-1'), 'wallpaper');
  assert.equal(domains.domainOfSlug('anything'), 'tech');
});

// ---- static: shared substrate ----

test('LINOLEUM: shared.ts re-exports the sku constants and carries the root slug set', () => {
  const shared = read('app/lib/catalog/shared.ts');
  assert.match(
    shared,
    /export \{[\s\S]*?LINOLEUM_SKU_PREFIX,[\s\S]*?LINOLEUM_SKU_LIKE,[\s\S]*?\} from '\.\.\/domains.ts'/,
    'sku constants must come from the domains module, not be redefined'
  );
  assert.match(
    shared,
    /LINOLEUM_CATEGORY_SLUGS:\s*ReadonlySet<string>/,
    'the linoleum category set must be a ReadonlySet like the wallpaper one'
  );
});

test('LINOLEUM: category set holds the root slug (subcategories arrive in batch 2)', () => {
  // Static pin on purpose: evaluating shared.ts at module scope would run
  // its supabase client creation before the runtime test below sets the
  // env vars (same import-order constraint the wallpaper suite respects).
  const shared = read('app/lib/catalog/shared.ts');
  assert.match(shared, /export const LINOLEUM_ROOT_SLUG = 'linoleum';/);
  assert.match(
    shared,
    /export const LINOLEUM_CATEGORY_SLUGS: ReadonlySet<string> = new Set\(\[\s*LINOLEUM_ROOT_SLUG,\s*\]\);/,
    'batch 1: the root slug is the whole set'
  );
});

// ---- static: general listings exclude ln-* ----

test('LINOLEUM: fetchCatalogProducts decision mirrors isWallpaperView (subtree-scoped escape)', () => {
  const listing = read('app/lib/catalog/listing.ts');
  const head = sliceBetween(
    listing,
    'const hasSearch =',
    '// ---- paged data query ----'
  );
  assert.match(
    head,
    /isLinoleumView =[\s\S]*?LINOLEUM_CATEGORY_SLUGS\.has[\s\S]*?subtreeIds\.includes\(category\.id\)/,
    'the linoleum escape must be scoped to the linoleum subtree only'
  );
  assert.match(
    head,
    /hideLinoleum = !isLinoleumView && !hasSearch/,
    'search keeps ln-* (cross-domain surface), the linoleum subtree keeps its rows'
  );
});

test('LINOLEUM: fetchCatalogProducts count + data queries exclude ln-*', () => {
  const listing = read('app/lib/catalog/listing.ts');
  const dataPart = sliceBetween(listing, '// ---- paged data query ----', '// Every sort gets');
  assert.match(dataPart, /if \(hideLinoleum\)/, 'data guard mirrors the wallpaper guard');
  assert.ok(dataPart.includes(LINOLEUM_NOT), 'data query must exclude ln-*');
  const countPart = sliceBetween(
    listing,
    '-- total count with identical filters',
    'const total = count ?? 0;'
  );
  assert.match(countPart, /if \(hideLinoleum\)/, 'count guard mirrors the data guard');
  assert.ok(countPart.includes(LINOLEUM_NOT), 'count query must exclude ln-*');
});

test('LINOLEUM: the wc-* exclusion stays FIRST in both listing queries', () => {
  // Stability pin: runtime readers of the wire (tests, debugging) see the
  // wallpaper param first; the linoleum one is appended after it.
  const listing = read('app/lib/catalog/listing.ts');
  const dataPart = sliceBetween(listing, '// ---- paged data query ----', '// Every sort gets');
  assert.ok(
    dataPart.indexOf(`if (hideWallpapers)`) !== -1 &&
      dataPart.indexOf(`if (hideWallpapers)`) < dataPart.indexOf(`if (hideLinoleum)`),
    'wallpaper guard must precede the linoleum guard in the data query'
  );
});

test('LINOLEUM: view counts mirror the listing decision (noindex contract)', () => {
  const counts = read('app/lib/catalog/counts.ts');
  const categoryCount = sliceBetween(
    counts,
    'async function countCategoryProductsUncached',
    'const countCategoryProductsStore'
  );
  assert.match(
    categoryCount,
    /isLinoleumView[\s\S]*?if \(!isLinoleumView\) \{[\s\S]*?not\('sku', 'like', LINOLEUM_SKU_LIKE\)/,
    'category counts: linoleum-scoped views count ln-*, the rest exclude'
  );
  const brandCount = sliceBetween(
    counts,
    'async function countBrandProductsUncached',
    'export const fetchBrandProductCount'
  );
  assert.ok(brandCount.includes(LINOLEUM_NOT), 'brand views are general listings');
  const comboCount = sliceBetween(
    counts,
    'async function countCategoryBrandProductsUncached',
    'const countCategoryBrandProductsStore'
  );
  assert.match(
    comboCount,
    /isLinoleumView[\s\S]*?if \(!isLinoleumView\) \{[\s\S]*?not\('sku', 'like', LINOLEUM_SKU_LIKE\)/,
    'combo counts mirror the same category-scoped decision'
  );
});

test('LINOLEUM: home product feed excludes ln-* (after the wc-* line)', () => {
  const feed = read('app/lib/catalog/product-feed.ts');
  const wcIdx = feed.indexOf(WALLPAPER_NOT);
  const lnIdx = feed.indexOf(LINOLEUM_NOT);
  assert.ok(lnIdx !== -1, 'home feed must exclude ln-*');
  assert.ok(wcIdx !== -1 && wcIdx < lnIdx, 'wallpaper exclusion stays first');
});

// ---- static: related stays inside the current product's sku domain ----

test('LINOLEUM: related stages — ln-* PDP sees ln-*, general PDP sees neither domain', () => {
  const related = read('app/lib/catalog/related.ts');
  const stage = sliceBetween(
    related,
    'async function fetchRelatedStage',
    'export async function fetchRelatedProducts'
  );
  assert.match(stage, /skuDomain === 'wallpaper'/, 'wallpaper branch (existing pin)');
  assert.match(stage, /skuDomain === 'linoleum'/, 'linoleum PDP → ln-* candidates');
  assert.match(stage, /\.like\('sku', LINOLEUM_SKU_LIKE\)/, 'ln-* stage restricts to its domain');
  assert.ok(stage.includes(WALLPAPER_NOT), 'general branch keeps the wc-* exclusion');
  assert.ok(stage.includes(LINOLEUM_NOT), 'general branch adds the ln-* exclusion');
  const store = related.slice(related.indexOf('const fetchRelatedProductsStore'));
  assert.match(
    store,
    /startsWith\(LINOLEUM_SKU_PREFIX\)/,
    'domain derived from sku via the shared prefix'
  );
});

// ---- runtime: the sku filters must reach the wire ----

test('RUNTIME: general catalog + home feed carry sku=not.like.wc-% AND not.like.ln-%; search carries neither', async () => {
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
  const requests: { method: string; sku: string[]; params: URLSearchParams }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({
      method: req.method ?? 'GET',
      sku: url.searchParams.getAll('sku'),
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
    const { fetchCatalogProducts, fetchFeaturedProducts } = await import(
      '../app/lib/catalog.ts'
    );

    // General catalog: the merged count+data request excludes BOTH domains.
    await fetchCatalogProducts({ page: 1, size: 12 });
    const catalogRequests = requests.splice(0);
    assert.equal(catalogRequests.length, 1, 'one merged count+data window');
    assert.deepEqual(
      catalogRequests[0]?.sku,
      ['not.like.wc-%', 'not.like.ln-%'],
      'general listing must exclude wc-* AND ln-* (wallpaper param first)'
    );

    // Search view: with an active search term NEITHER exclusion may reach
    // the wire — the header search box is a cross-domain surface
    // (owner bug report 2026-09-11 for wc-*, same contract for ln-*).
    await fetchCatalogProducts({ page: 1, size: 12, search: 'лінолеум' });
    const searchRequests = requests.splice(0);
    assert.equal(searchRequests.length, 2, 'one head-count + one data window');
    for (const r of searchRequests) {
      assert.deepEqual(r.sku, [], `search view must keep ln-* (${r.method})`);
    }

    // Home feed (fetchProducts via fetchFeaturedProducts): both exclusions.
    await fetchFeaturedProducts();
    const feedRequests = requests.splice(0);
    assert.equal(feedRequests.length, 1);
    assert.deepEqual(
      feedRequests[0]?.sku,
      ['not.like.wc-%', 'not.like.ln-%'],
      'home shelves must exclude wc-* AND ln-*'
    );
  } finally {
    server.close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).closeAllConnections?.();
  }
});
