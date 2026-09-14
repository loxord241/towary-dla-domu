/**
 * /oboi spec-filters + PDP photo lightbox (owner task 2026-09-11).
 *
 * Pins:
 *  1. ?base= reaches fetchWallpaperProducts as a PostgREST jsonb contains
 *     on products.specifications with the exact whitelisted element. Since
 *     the perf package (2026-09-13) the count and the data page travel in
 *     ONE request (select with count:'exact', total parsed from
 *     Content-Range), so the pagination total matches the visible grid by
 *     construction (runtime fake-PostgREST proof below).
 *  2. Filtered /oboi views (?base=…, junk included) are noindex,follow
 *     WITHOUT a canonical (buildWallpapersMetadata — catalog policy).
 *  3. /oboi renders the «Основа» chips (Усі + dictionary from
 *     wallpapers/filters.ts) and preserves the filter across pagination.
 *  4. Lightbox.tsx: 'use client' dialog with Escape/backdrop close, ‹/›
 *     arrows, body scroll lock, keyframe entry + motion-reduce opt-out,
 *     inherited alt text.
 *  5. ProductGallery opens the lightbox from the MAIN image only;
 *     thumbnails keep switching (they never open the overlay) and the
 *     LCP preload contract stays intact.
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

// ---------------------------------------------------------------------------
// 1. Data layer: the filter reaches the ONE merged count+data request
// ---------------------------------------------------------------------------

test('FILTER DICT: wallpapers/filters.ts pins the Основа dictionary with the expandable-vocabulary note', () => {
  const src = read('app/lib/wallpapers/filters.ts');
  assert.match(src, /WALLPAPER_BASE_SPEC_NAME = 'Основа'/);
  assert.match(src, /WALLPAPER_BASE_VALUES/);
  assert.match(src, /'Паперова'/, 'the only live-verified value (slav fragment)');
  assert.match(src, /СЛОВАРЬ МОЖЕТ РАСШИРЯТЬСЯ/,
    'docblock must mark the dictionary as expandable (no DB access to verify)');
  assert.match(src, /DEFERRED/, 'room filter must be documented as deferred');
});

test('FILTER QUERY: fetchWallpaperProducts applies the jsonb contains to the merged count+data request', () => {
  // 2026-09 refactor: the /oboi read lives in app/lib/catalog/wallpaper-listing.ts.
  // 2026-09 perf: count and data page travel in ONE request — select(...,
  // { count: 'exact' }) makes PostgREST return the total in Content-Range
  // next to the rows, so the head-count round-trip is gone and the total
  // matches the grid by construction.
  const src = read('app/lib/catalog/wallpaper-listing.ts');
  const body = sliceBetween(
    src,
    'export async function fetchWallpaperProducts',
    'Product reviews'
  );

  assert.match(
    body,
    /\.select\(CATALOG_CARD_SELECT, \{ count: 'exact' \}\)/,
    'one merged request must carry the exact total alongside the page rows'
  );
  assert.doesNotMatch(body, /head:\s*true/, 'no separate head-count request');

  // The filter travels as an exact {name, value} element, stringified to the
  // jsonb array-containment wire form cs.[{"name":…,"value":…}] (a JS array
  // of objects passed directly would serialize as cs.{[object Object]}).
  const contains = body.match(
    /JSON\.stringify\(\[\{ name: WALLPAPER_BASE_SPEC_NAME, value: base \}\]\)/g
  ) ?? [];
  assert.equal(contains.length, 1,
    'the merged count+data query must carry the jsonb contains exactly once');

  // Merged query section: the like-sku domain filter + contains must precede
  // the paged window so pagination slices the filtered set.
  const queryPart = sliceBetween(
    body,
    'const buildPagedQuery',
    '.range('
  );
  assert.match(queryPart, /\.like\('sku', WALLPAPER_SKU_LIKE\)/);
  assert.match(queryPart, /\.contains\(\s*'specifications'/);

  assert.match(body, /base\?: string/, 'filters accept the raw ?base= value');
  assert.match(body, /filters\.base\?\.trim\(\)/,
    'whitespace-only values degrade to no filter');
});

// ---------------------------------------------------------------------------
// 2. SEO: filtered views are noindex,follow without a canonical
// ---------------------------------------------------------------------------

const { buildWallpapersMetadata } = await import('../app/lib/seo.ts');

test('OBOI SEO: ?base= views are noindex,follow WITHOUT a canonical (junk included)', () => {
  for (const base of ['Паперова', 'Невідома основа', '']) {
    const meta = buildWallpapersMetadata(1, base);
    assert.deepEqual(
      meta.robots,
      { index: false, follow: true },
      `base=${JSON.stringify(base)} must be noindex,follow`
    );
    assert.equal(meta.alternates, undefined,
      'no canonical on noindex pages (contradictory signals)');
  }
});

test('OBOI SEO: unfiltered contracts survive the filter extension', () => {
  const page1 = buildWallpapersMetadata();
  assert.equal(page1.robots, undefined, 'page 1 stays indexable');
  assert.deepEqual(page1.alternates, { canonical: '/oboi' });

  const page2 = buildWallpapersMetadata(2);
  assert.deepEqual(page2.robots, { index: false, follow: true });
  assert.equal(page2.alternates, undefined);
});

// ---------------------------------------------------------------------------
// 3. /oboi page: chips UI + filter-aware pagination
// ---------------------------------------------------------------------------

test('OBOI PAGE: base param reaches fetch + metadata; chips render Усі + dictionary', () => {
  // ISR split (2026-09-14): param reading lives on the dynamic twin
  // (app/oboi/filtered/page.tsx), the chips markup on the shared
  // OboiStorefront both /oboi routes render through.
  const page = read('app/oboi/filtered/page.tsx');
  assert.match(page, /baseParamOf/,
    'base param is read for BOTH metadata and the query');
  assert.match(
    page,
    /fetchWallpaperProducts\(\{[\s\S]*?base,[\s\S]*?\}\)/,
    'the query receives the base filter'
  );
  assert.match(page, /buildWallpapersMetadata\(\s*parsePageParam\(rawParams\.page\),\s*baseParamOf\(rawParams\),\s*sortParamOf\(rawParams\)/,
    'metadata sees the raw params (junk → noindex)');
  const shelf = read('app/oboi/OboiStorefront.tsx');
  assert.match(shelf, /WALLPAPER_BASE_VALUES/,
    'chips come from the wallpapers dictionary');
  assert.match(shelf, /Усі/, 'reset chip present');
  assert.match(shelf, /aria-current=\{base === value \? 'true' : undefined\}/,
    'active chip state is exposed to AT');
  assert.match(shelf, /motion-reduce:transition-none/,
    'chips carry the motion-reduce opt-out');
  // filtered empty state must not reuse the "coming soon" copy
  assert.match(shelf, /За фільтром нічого не знайдено/);
});

test('OBOI PAGE: pagination and filter links preserve ?base= and ?sort=', () => {
  const shelf = read('app/oboi/OboiStorefront.tsx');
  const pageUrl = sliceBetween(shelf, 'function oboiPageUrl', 'export interface');
  assert.match(pageUrl, /params\.set\('base', base\)/,
    'pagination must keep the active filter');
  assert.match(pageUrl, /params\.set\('sort', sort\)/,
    'pagination must keep the active ordering');
  const filterUrl = sliceBetween(shelf, 'function oboiFilterUrl', 'function oboiPageUrl');
  // URLSearchParams.set percent-encodes the uk values on toString().
  assert.match(filterUrl, /params\.set\('base', base\)/,
    'filter chips keep the active ordering (URLSearchParams encodes)');
  // every prev/next/page link passes the filter + sort through
  assert.equal(
    (shelf.match(/oboiPageUrl\((?:currentPage - 1|item|currentPage \+ 1), base, sortParam\)/g) ?? []).length,
    3
  );
});

test('OBOI PAGE: default sort is alphabetical; explicit sorts are whitelisted', () => {
  const page = read('app/oboi/filtered/page.tsx');
  // absent ?sort= IS name_asc (owner 2026-09-12) — the canonical /oboi is
  // the sorted view; junk values fall back to the default.
  assert.match(page, /sortParam === '' \? 'name_asc' : sortParam/);
  assert.match(page, /SORT_VALUES\.includes\(raw as CatalogSort\)/);
  const shelf = read('app/oboi/OboiStorefront.tsx');
  // sort control is rendered (client select, mobile contract).
  assert.match(shelf, /Сортування:/);
  assert.match(shelf, /<OboiSortSelect \/>/);
  const select = read('app/oboi/SortSelect.tsx');
  assert.match(select, /^'use client';/m);
  assert.match(select, /Назва А–Я/);
  // default option posts NO param (canonical /oboi stays indexable) and
  // the base filter survives a sort change.
  assert.match(select, /if \(e\.target\.value !== ''\) params\.set\('sort', e\.target\.value\)/);
  assert.match(select, /if \(base\) params\.set\('base', base\)/);
  assert.match(select, /min-h-\[44px\]/, 'tap target ≥44px');
});

// ---------------------------------------------------------------------------
// 4. Lightbox component
// ---------------------------------------------------------------------------

test('LIGHTBOX: client dialog with Escape/arrows, scroll lock and inherited alt', () => {
  const src = read('app/components/Lightbox.tsx');
  assert.match(src, /^'use client';/m);
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal="true"/);
  assert.match(src, /aria-label="Перегляд фото товару"/);
  assert.match(src, /'Escape'/, 'Escape-to-close');
  assert.match(src, /'ArrowLeft'/);
  assert.match(src, /'ArrowRight'/);
  assert.match(src, /event\.target === event\.currentTarget/,
    'backdrop click closes (image clicks must not)');
  assert.match(src, /document\.body\.style\.overflow = 'hidden'/,
    'body scroll lock while open');
  assert.match(src, /document\.body\.style\.overflow = previous/,
    'scroll lock restored on unmount');
  assert.match(src, /alt=\{current\.alt\}/, 'alt inherited from the gallery');
  assert.match(src, /closeBtnRef\.current\?\.focus\(\)/,
    'initial focus lands on the close button');
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/, 'no HTML sinks');
  assert.doesNotMatch(src, /setTimeout\(/, 'exit stays instant (unmount)');
});

test('LIGHTBOX MOTION: keyframe entry with motion-reduce:animate-none opt-out', () => {
  const src = read('app/components/Lightbox.tsx');
  assert.equal(
    (src.match(/lightbox-fade/g) ?? []).length, 1,
    'overlay entry class'
  );
  assert.equal(
    (src.match(/lightbox-zoom/g) ?? []).length, 1,
    'image zoom-settle class'
  );
  assert.equal(
    (src.match(/className="[^"]*motion-reduce:animate-none/g) ?? []).length, 2,
    'both animated elements disable motion explicitly (className-scoped)'
  );

  const css = read('app/globals.css');
  for (const name of ['lightbox-fade', 'lightbox-zoom']) {
    assert.match(css, new RegExp(`@keyframes ${name}`),
      `${name} keyframe defined in globals.css`);
  }
  // transform/opacity-only motion (no layout properties animate)
  assert.doesNotMatch(css, /@keyframes lightbox-[\s\S]*?(width|height|top|left):/);
});

// ---------------------------------------------------------------------------
// 5. ProductGallery integration
// ---------------------------------------------------------------------------

test('GALLERY: main image opens the Lightbox; thumbnails only switch', () => {
  const src = read('app/components/ProductGallery.tsx');
  assert.match(src, /import Lightbox from '\.\/Lightbox';/);
  assert.match(src, /lightboxOpen, setLightboxOpen\] = useState\(false\)/);
  assert.match(
    src,
    /onClick=\{\(\) => setLightboxOpen\(true\)\}/,
    'exactly the main-image wrapper opens the overlay'
  );
  assert.equal(
    (src.match(/setLightboxOpen\(true\)/g) ?? []).length, 1,
    'only ONE open path: the main image button'
  );
  assert.match(src, /aria-label="Відкрити фото на весь екран"/);
  // overlay mounts with the clamped selection and closes via callback
  assert.match(src, /\{lightboxOpen && \(/);
  assert.match(src, /initialIndex=\{Math\.min\(selected, images\.length - 1\)\}/);
  assert.match(src, /onClose=\{\(\) => setLightboxOpen\(false\)\}/);
  // thumbnails must not open the overlay (selection contract unchanged)
  const thumbsStart = src.indexOf('images.map((img, idx)');
  const overlayStart = src.indexOf('{lightboxOpen && (');
  assert.ok(thumbsStart !== -1 && overlayStart > thumbsStart);
  const thumbs = src.slice(thumbsStart, overlayStart);
  assert.doesNotMatch(thumbs, /setLightboxOpen/);
  // LCP contract intact: preload prop still on the main image
  assert.match(src, /^\s+preload\s*$/m);
});

// ---------------------------------------------------------------------------
// 6. Runtime: the contains filter must reach the wire on the single request
// ---------------------------------------------------------------------------

test('RUNTIME: base=Паперова → specifications=cs.[{"name":"Основа",…}] on the merged count+data request; absent → no param', async () => {
  const mkRow = (i: number) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `Шпалери ${i}`,
    slug: `wc-s${i}`,
    price: 100 + i,
    old_price: null,
    currency: 'UAH',
    availability_status: 'in_stock',
    brand: null,
    images: [],
  });
  const rows = [1].map(mkRow);

  const http = await import('node:http');
  const requests: URL[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url);
    const from = Number(url.searchParams.get('offset') ?? 0);
    const lim = Number(url.searchParams.get('limit') ?? 12);
    const slice = rows.slice(from, from + lim);
    // The merged request's total is parsed from Content-Range — no
    // separate head-count request exists anymore.
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Range': `${slice.length > 0 ? `${from}-${from + slice.length - 1}` : '*/0'}/7`,
    });
    res.end(JSON.stringify(slice));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';
    const { fetchWallpaperProducts } = await import('../app/lib/catalog.ts');

    // Filtered call: the ONE merged count+data request carries the exact
    // jsonb contains element.
    const filteredPage = await fetchWallpaperProducts({ page: 1, size: 12, base: 'Паперова' });
    const filtered = requests.splice(0);
    assert.equal(filtered.length, 1, 'one merged count+data request');
    const raw = filtered[0]?.searchParams.get('specifications');
    assert.ok(raw, 'specifications filter must reach the wire');
    assert.ok(raw.startsWith('cs.'), 'contains operator on the wire');
    assert.deepEqual(
      JSON.parse(raw.slice('cs.'.length)),
      [{ name: 'Основа', value: 'Паперова' }],
      'exact {name, value} element'
    );
    assert.equal(filteredPage.total, 7, 'total parsed from Content-Range of the data response');

    // Unfiltered call: no specifications param at all.
    const unfiltered = await fetchWallpaperProducts({ page: 1, size: 12 });
    const plain = requests.splice(0);
    assert.equal(plain.length, 1);
    assert.equal(plain[0]?.searchParams.get('specifications'), null);
    assert.equal(unfiltered.total, 7);

    // Whitespace-only value degrades to no filter (same as absent).
    await fetchWallpaperProducts({ page: 1, size: 12, base: '   ' });
    const blank = requests.splice(0);
    assert.equal(blank.length, 1);
    assert.equal(blank[0]?.searchParams.get('specifications'), null);
  } finally {
    server.close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).closeAllConnections?.();
  }
});
