/**
 * Linoleum hub storefront /linoleum (linoleum vertical, batch 2, task L4,
 * 2026-09-17). Mirror of /oboi for the ln-* sku domain:
 *
 *  1. app/lib/catalog/linoleum-listing.ts — fetchLinoleumProducts: the SAME
 *     single merged count+data read shape as fetchWallpaperProducts, but
 *     over sku like 'ln-%'. The width filter MUST build its jsonb contains
 *     literal THROUGH formatWidthM (uk comma format, '1,5'/'2'/'2,5'/'3'/'4')
 *     — the importer writes {name:'Ширина', value: formatWidthM(w)} into
 *     products.specifications, so any other literal form misses every row.
 *  2. app/linoleum/page.tsx (ISR 60, pure view, no searchParams) +
 *     app/linoleum/filtered/page.tsx (force-dynamic twin: ?page/?width/?sort,
 *     noindex metadata) + Storefront/SortSelect — clones of the /oboi split.
 *  3. proxy.ts + catalog-paths.ts — query-carrying /linoleum rewrites to the
 *     twin BEFORE the admin gate (the matcher invariant).
 *  4. lib/seo.ts — buildLinoleumMetadata: canonical /linoleum on the pure
 *     view; ANY ?width/?page/?sort (junk included) → noindex,follow WITHOUT
 *     a canonical.
 *  5. app/sitemap.ts — static '/linoleum' entry («indexable set = sitemap
 *     set»).
 *  6. shelves.ts — the home shelves stop surfacing ln-* (wallpaper exclusion
 *     pattern; the wall goes up BEFORE the importer fills the domain).
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

// ---------------------------------------------------------------------------
// 1. listing: fetchLinoleumProducts
// ---------------------------------------------------------------------------

test('LINOLEUM LISTING: single merged count+data read restricted to ln-*', () => {
  const body = sliceBetween(
    read('app/lib/catalog/linoleum-listing.ts'),
    'export async function fetchLinoleumProducts',
    // end of file slice — the function is the module's last export
    'END-OF-FILE-MARKER-THAT-NEVER-MATCHES'
  );
  // ONE merged count+data request — the sku like filter appears exactly once,
  // the total travels with the page rows (same shape as fetchWallpaperProducts).
  const likes = body.match(/\.like\('sku', LINOLEUM_SKU_LIKE\)/g) ?? [];
  assert.equal(likes.length, 1, 'the merged count+data query carries sku like ln-%%');
  assert.match(
    body,
    /\.select\(CATALOG_CARD_SELECT, \{ count: 'exact' \}\)/,
    'total travels with the page rows (Content-Range), no head-count'
  );
  assert.doesNotMatch(body, /head:\s*true/, 'no separate head-count request');
  assert.match(body, /\.eq\('is_active', true\)/, 'active only');
  assert.match(body, /CATALOG_CARD_SELECT/, 'slim card projection + images!inner join');
  assert.match(body, /\.order\('id'/, 'deterministic tiebreaker kept');
  assert.match(body, /\.range\(\(page - 1\) \* size, page \* size - 1\)/, 'paged window');
  assert.match(body, /throw new Error/, 'count/data errors must rethrow');
});

test('LINOLEUM LISTING: width filter literal is built THROUGH formatWidthM', () => {
  const src = read('app/lib/catalog/linoleum-listing.ts');
  // The contains literal MUST be JSON.stringify([{name: WIDTH_SPEC_NAME,
  // value: formatWidthM(width)}]) — the importer canon (import-plan.ts).
  // Any hand-rolled '1.5'/dot-form literal would miss every stored row.
  assert.match(
    src,
    /JSON\.stringify\(\[\{ name: WIDTH_SPEC_NAME, value: formatWidthM\(width\) \}\]\)/,
    'wire literal = cs.[{"name":"Ширина","value":"<uk comma width>"}]'
  );
  assert.match(src, /from '\.\.\/linoleum\/import-plan\.ts'/,
    'WIDTH_SPEC_NAME/formatWidthM come from the importer canon, not duplicated');
});

// ---------------------------------------------------------------------------
// 2. /linoleum routes — the ISR split mirror
// ---------------------------------------------------------------------------

test('LINOLEUM HUB: page is ISR, reads no searchParams, renders the pure view', () => {
  const page = read('app/linoleum/page.tsx');
  assert.match(page, /export const revalidate = 60;/);
  assert.doesNotMatch(page, /await searchParams/,
    'a searchParams read would opt the ISR route into dynamic rendering');
  assert.match(page, /return buildLinoleumMetadata\(\);/,
    'the pure view IS the indexable view');
  assert.match(page, /fetchLinoleumProducts/, 'ln-* domain data source');
  assert.match(page, /fetchActiveCategories/, 'footer dictionary');
  assert.match(page, /page: 1,/);
  assert.match(page, /sort: 'name_asc' as CatalogSort/,
    'default alphabetical order, same as /oboi');
});

test('LINOLEUM HUB: twin is force-dynamic with the whitelisted query params', () => {
  const twin = read('app/linoleum/filtered/page.tsx');
  assert.match(twin, /export const dynamic = 'force-dynamic';/);
  assert.match(twin, /await searchParams/);
  assert.match(twin, /buildLinoleumMetadata\(/,
    'noindex metadata from the seo policy');
  // ?width whitelist = LINOLEUM_WIDTHS_M; junk width cannot reach the query
  // (the contains literal must be a formatWidthM canon value) but still
  // noindexes the view (filter VALUE on an existing resource).
  assert.match(twin, /LINOLEUM_WIDTHS_M/);
  assert.match(twin, /SORT_VALUES/);
});

test('LINOLEUM HUB: storefront — one h1 «Лінолеум», width chips, grid, pagination', () => {
  const shelf = read('app/linoleum/Storefront.tsx');
  assert.equal((shelf.match(/<h1/g) ?? []).length, 1, 'exactly one h1');
  assert.match(shelf, /<h1 className="text-2xl font-bold">Лінолеум<\/h1>/);
  assert.match(shelf, /LINOLEUM_WIDTHS_M/, 'chips come from the parser width grid');
  assert.match(shelf, /formatWidthM/, 'chip labels use the uk comma format canon');
  assert.match(shelf, /<ProductCard/, 'reuses ProductCard unchanged');
  assert.match(shelf, /buildPageWindow/, 'catalog-style page window');
  assert.match(shelf, /getMainPublicImageUrl/, 'image resolver pattern');
  assert.equal((shelf.match(/<main/g) ?? []).length, 1, 'exactly one main landmark');
  assert.doesNotMatch(shelf, /dangerouslySetInnerHTML/, 'no new HTML sinks');
  assert.match(shelf, /EmptyState/, 'empty state like /oboi');
});

test('LINOLEUM HUB: BreadcrumbList JSON-LD on the ISR page (Головна → Лінолеум)', () => {
  // Owner review fix 2026-09-17: the hub had NO BreadcrumbList while /oboi
  // and /brands carry one. Rendered on the indexable pure view through the
  // sanctioned ProductJsonLd sink (same pattern as app/brands/page.tsx);
  // the noindex filtered twin stays free of it (scope: pure view only).
  const page = read('app/linoleum/page.tsx');
  assert.match(
    page,
    /import ProductJsonLd from '@\/app\/components\/ProductJsonLd'/
  );
  assert.match(
    page,
    /import \{ buildLinoleumBreadcrumbJsonLd \} from '@\/app\/lib\/schema-org'/
  );
  assert.match(page, /buildLinoleumBreadcrumbJsonLd\(siteUrl\)/);
  assert.match(
    page,
    /<ProductJsonLd data=\{breadcrumbJsonLd\} \/>/,
    'рендеринг через санкціонований JSON-LD sink, без нових HTML-сінків'
  );
  // The builder unit lives with the other breadcrumb builders
  // (tests/seo-jsonld.test.ts) — here only the mount pin.
});

test('LINOLEUM HUB: sort select rides the document-navigation fix', () => {
  const sel = read('app/linoleum/SortSelect.tsx');
  assert.match(sel, /isSortDocumentNavigation\('\/linoleum'\)/,
    'ISR route: sort changes must be document navigations (owner bug 2026-09-15)');
  assert.match(sel, /window\.location\.assign\(href\)/);
  assert.match(sel, /searchParams\.get\('width'\)/,
    'the width filter is preserved across sort changes');
});

// ---------------------------------------------------------------------------
// 3. proxy + paths — the rewrite chain and the matcher invariant
// ---------------------------------------------------------------------------

test('LINOLEUM PATHS: linoleumFilteredRewrite — bare /linoleum with a query only', async () => {
  const { linoleumFilteredRewrite } = await import(
    pathToFileURL(path.join(root, 'app/lib/catalog-paths.ts')).href
  ) as typeof import('../app/lib/catalog-paths.ts');
  assert.equal(linoleumFilteredRewrite('/linoleum', '?page=2'), '/linoleum/filtered');
  assert.equal(linoleumFilteredRewrite('/linoleum', '?width=1.5&sort=price_asc'), '/linoleum/filtered');
  assert.equal(linoleumFilteredRewrite('/linoleum', '?width=мусор'), '/linoleum/filtered');
  // The ISR view itself is never rewritten; neither are other paths.
  assert.equal(linoleumFilteredRewrite('/linoleum', ''), null);
  assert.equal(linoleumFilteredRewrite('/linoleum/filtered', '?page=2'), null);
  assert.equal(linoleumFilteredRewrite('/oboi', '?page=2'), null);
});

test('LINOLEUM PATHS: proxy chains the rewrite BEFORE the admin gate and matches /linoleum', () => {
  const proxySrc = read('proxy.ts');
  assert.match(proxySrc, /linoleumFilteredRewrite\(/,
    'the decision is imported (single source), not duplicated inline');
  assert.match(
    proxySrc,
    /matcher:[\s\S]*'\/linoleum'[\s\S]*\]/,
    'the matcher must cover bare /linoleum'
  );
  // Rewrites stay in the non-admin early-return block: EVERY non-admin path
  // must answer before the admin session gate.
  const earlyBlock = sliceBetween(proxySrc, "if (!pathname.startsWith('/admin'))", '----- admin gate');
  assert.match(earlyBlock, /linoleumFilteredRewrite\(/);
});

// ---------------------------------------------------------------------------
// 4. seo: buildLinoleumMetadata canonical/noindex matrix
// ---------------------------------------------------------------------------

const seo = await import(
  pathToFileURL(path.join(root, 'app/lib/seo.ts')).href
) as typeof import('../app/lib/seo.ts');

test('LINOLEUM SEO: pure view is indexable with canonical /linoleum', () => {
  assert.equal(seo.LINOLEUM_CANONICAL_PATH, '/linoleum');
  const meta = seo.buildLinoleumMetadata();
  assert.match(String(meta.title), /Лінолеум — купити в Товари для дому/);
  assert.ok(meta.description && meta.description.length > 0);
  // Geo tail in the description only (audit 2026-09-14 policy).
  assert.ok(String(meta.description).includes('доставкою по Україні'));
  assert.ok(String(meta.description).includes('самовивозом у Кривому Розі'));
  assert.equal(meta.robots, undefined, 'page 1 must stay indexable (no robots tag)');
  assert.deepEqual(meta.alternates, { canonical: '/linoleum' });
});

test('LINOLEUM SEO: deep page, width filter and explicit sort are noindex,follow WITHOUT canonical', () => {
  for (const [label, meta] of [
    ['page 2', seo.buildLinoleumMetadata(2)],
    ['width', seo.buildLinoleumMetadata(1, '1.5')],
    ['junk width', seo.buildLinoleumMetadata(1, 'мусор')],
    ['empty width param', seo.buildLinoleumMetadata(1, '')],
    ['sort', seo.buildLinoleumMetadata(1, undefined, 'price_asc')],
    ['all combined', seo.buildLinoleumMetadata(3, '2.5', 'newest')],
  ] as const) {
    assert.deepEqual(meta.robots, { index: false, follow: true }, label);
    assert.equal(meta.alternates, undefined, `no canonical on noindex pages (${label})`);
    assert.ok(meta.openGraph, `og keeps messenger previews meaningful (${label})`);
  }
});

// ---------------------------------------------------------------------------
// 5. sitemap: the static entry
// ---------------------------------------------------------------------------

test('LINOLEUM: sitemap lists /linoleum in the static set (indexable set = sitemap set)', () => {
  const sitemapSrc = read('app/sitemap.ts');
  assert.match(sitemapSrc, /'\/linoleum'/, '/linoleum must be a static sitemap entry');
  // Same cadence as /oboi (the two roll-goods storefronts are indexed equally).
  assert.match(
    sitemapSrc,
    /path === '' \|\| path === '\/catalog' \|\| path === '\/oboi' \|\| path === '\/linoleum'\s*\?\s*'daily'/,
    'daily changeFrequency covers both storefronts'
  );
  assert.match(
    sitemapSrc,
    /path === '\/catalog' \|\| path === '\/oboi' \|\| path === '\/linoleum'\s*\?\s*0\.9/,
    'priority 0.9 covers both storefronts'
  );
});

// ---------------------------------------------------------------------------
// 6. shelves: home shelves stop surfacing ln-*
// ---------------------------------------------------------------------------

test('LINOLEUM: home shelves exclude ln-* next to the wc-* exclusion', () => {
  const shelvesSrc = read('app/lib/catalog/shelves.ts');
  const WALLPAPER_NOT = `.not('sku', 'like', WALLPAPER_SKU_LIKE)`;
  const LINOLEUM_NOT = `.not('sku', 'like', LINOLEUM_SKU_LIKE)`;
  const selected = sliceBetween(
    shelvesSrc,
    'export async function fetchSelectedProducts',
    'export const POPULAR_LIMIT'
  );
  // fetchPopularProducts is the file's last export — slice to EOF.
  const popular = sliceBetween(
    shelvesSrc,
    'export async function fetchPopularProducts',
    'END-OF-FILE-MARKER-THAT-NEVER-MATCHES'
  );
  for (const [name, body] of [['selected', selected], ['popular', popular]] as const) {
    const wcIdx = body.indexOf(WALLPAPER_NOT);
    const lnIdx = body.indexOf(LINOLEUM_NOT);
    assert.ok(lnIdx !== -1, `${name} shelf must exclude ln-*`);
    assert.ok(wcIdx !== -1 && wcIdx < lnIdx, `${name}: wallpaper exclusion stays first`);
    assert.ok(lnIdx < body.indexOf('.range('), `${name}: exclusions precede the window`);
  }
});

// ---------------------------------------------------------------------------
// 7. runtime: the wire over fake-PostgREST
// ---------------------------------------------------------------------------

test('RUNTIME: fetchLinoleumProducts carries sku=like.ln-% and the formatWidthM contains literal; sorts keep the id tiebreaker; out-of-range page replays clamped', async () => {
  const TOTAL = 25;
  const mkRow = (i: number) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `Лінолеум ${i}`,
    slug: `ln-x${i}`,
    price: 100 + i,
    old_price: null,
    currency: 'UAH',
    availability_status: 'in_stock',
    brand: null,
    images: [],
  });
  const rows = Array.from({ length: 12 }, (_, i) => mkRow(i + 1));

  const http = await import('node:http');
  const requests: {
    sku: string[];
    specifications: string[];
    order: string[];
    offset: string | null;
  }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({
      sku: url.searchParams.getAll('sku'),
      specifications: url.searchParams.getAll('specifications'),
      order: url.searchParams.getAll('order'),
      offset: url.searchParams.get('offset'),
    });
    const from = Number(url.searchParams.get('offset') ?? 0);
    const lim = Number(url.searchParams.get('limit') ?? 12);
    const slice = rows.slice(from, from + lim);
    const last = from + slice.length - 1;
    // PostgREST Content-Range forms: "from-last/total" for a non-empty
    // window, "*/total" for an empty one (supabase-js parses count as the
    // segment after the FIRST slash).
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Range':
        slice.length > 0 ? `${from}-${last}/${TOTAL}` : `*/${TOTAL}`,
    });
    res.end(JSON.stringify(slice));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';
    const { fetchLinoleumProducts } = await import('../app/lib/catalog.ts');
    const { formatWidthM } = await import(
      pathToFileURL(path.join(root, 'app/lib/linoleum/import-plan.ts')).href
    ) as typeof import('../app/lib/linoleum/import-plan.ts');

    // 1) Width filter: the contains literal on the wire is EXACTLY the
    //    formatWidthM canon (uk comma: '1,5'), built via JSON.stringify.
    const widthPage = await fetchLinoleumProducts({
      page: 1,
      size: 12,
      width: 1.5,
      sort: 'name_asc',
    });
    const widthRequests = requests.splice(0);
    assert.equal(widthRequests.length, 1, 'one merged count+data window');
    assert.deepEqual(
      widthRequests[0]?.sku,
      ['like.ln-%'],
      'the listing restricts to the ln-* domain'
    );
    const expectedLiteral = `cs.${JSON.stringify([
      { name: 'Ширина', value: formatWidthM(1.5) },
    ])}`;
    assert.deepEqual(
      widthRequests[0]?.specifications,
      [expectedLiteral],
      `specifications contains must equal ${expectedLiteral}`
    );
    assert.ok(expectedLiteral.includes('"1,5"'), 'uk comma width format on the wire');
    assert.equal(widthPage.total, TOTAL, 'total parsed from Content-Range');
    assert.equal(widthPage.page, 1);

    // 2) Sorts: explicit sorts keep the id tiebreaker; default is the
    //    in-stock-first contract (availability_status asc).
    await fetchLinoleumProducts({ page: 1, size: 12, sort: 'price_asc' });
    assert.deepEqual(requests.splice(0)[0]?.order, ['price.asc,id.asc']);
    await fetchLinoleumProducts({ page: 1, size: 12, sort: 'price_desc' });
    assert.deepEqual(requests.splice(0)[0]?.order, ['price.desc,id.desc']);
    await fetchLinoleumProducts({ page: 1, size: 12, sort: 'name_asc' });
    assert.deepEqual(requests.splice(0)[0]?.order, ['name.asc,id.asc']);
    await fetchLinoleumProducts({ page: 1, size: 12 });
    assert.deepEqual(
      requests.splice(0)[0]?.order,
      ['availability_status.asc,created_at.desc,id.desc'],
      'default = in-stock-first (same as the wallpaper listing)'
    );

    // 3) Clamp: ?page=99 with 25 rows (maxPage 3) — the requested window
    //    comes back empty, so the SAME query replays once on page 3.
    const clamped = await fetchLinoleumProducts({
      page: 99,
      size: 12,
      sort: 'name_asc',
    });
    const clampRequests = requests.splice(0);
    assert.equal(clampRequests.length, 2, 'one replay for the clamped page');
    assert.equal(clampRequests[0]?.offset, '1176', 'requested window sent as-is');
    assert.equal(clampRequests[1]?.offset, '24', 'replay lands on the clamped page 3');
    assert.equal(clamped.page, 3, 'the clamped page is reported');
    assert.equal(clamped.total, TOTAL);
  } finally {
    server.close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).closeAllConnections?.();
  }
});
