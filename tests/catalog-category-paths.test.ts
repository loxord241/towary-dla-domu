/**
 * Category path URLs (owner task 2026-09-13): /catalog/<slug> becomes the
 * canonical, human-readable form of a category view.
 *
 * Pins all three sides of the same decision so they cannot drift apart:
 *  1. canonical/noindex policy (lib/seo.ts) — a valid category emits the
 *     PATH-form canonical; the legacy query form 308-redirects now;
 *  2. proxy.ts — GET /catalog?category=<slug> (brand absent) is
 *     308-redirected to /catalog/<slug> with the remaining params, while
 *     the /admin session gate keeps guarding ONLY /admin paths;
 *  3. the new route app/catalog/[category]/page.tsx renders the shared
 *     CatalogView and 404s unknown/inactive/garbage slugs instead of
 *     rendering an empty catalog on a crawlable path shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { catalogCategoryRedirect, catalogCategoryFilteredRewrite, oboiFilteredRewrite } from '../app/lib/catalog-paths.ts';
import {
  decideCatalogIndexing,
  buildCatalogViewMetadata,
} from '../app/lib/seo.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- 1. canonical side (lib/seo.ts)

test('PATHS: valid category canonical is the encoded path form', () => {
  const r = decideCatalogIndexing({
    categorySlug: 'blendery-1402',
    categoryFound: true,
  });
  assert.deepEqual(r, { indexable: true, canonicalPath: '/catalog/blendery-1402' });

  // The slug keeps its encoding through the decision (same as the query
  // form did): spaces and unicode are percent-encoded exactly once.
  const spaced = decideCatalogIndexing({
    categorySlug: 'kat z probilom',
    categoryFound: true,
  });
  assert.equal(spaced.canonicalPath, '/catalog/kat%20z%20probilom');

  const unicode = decideCatalogIndexing({
    categorySlug: 'категорія-1',
    categoryFound: true,
  });
  assert.equal(unicode.canonicalPath, `/catalog/${encodeURIComponent('категорія-1')}`);
});

test('PATHS: metadata builder emits the path canonical; brand stays query-form', () => {
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
  });
  assert.deepEqual(m.alternates, { canonical: '/catalog/blendery-1402' });

  const b = buildCatalogViewMetadata({
    input: { brandSlug: 'tefal', brandFound: true },
    brandName: 'TEFAL',
  });
  assert.deepEqual(b.alternates, { canonical: '/catalog?brand=tefal' });
});

// ---- 2. redirect side (pure decision + proxy wiring)

test('PATHS: redirect decision — happy paths', () => {
  assert.equal(
    catalogCategoryRedirect('/catalog', new URLSearchParams('category=blendery-1402'), 'GET'),
    '/catalog/blendery-1402'
  );
  // Remaining params preserved (order kept), category dropped, slug encoded.
  assert.equal(
    catalogCategoryRedirect(
      '/catalog',
      new URLSearchParams('category=kat z probilom&sort=price_asc&page=2&min=100'),
      'GET'
    ),
    '/catalog/kat%20z%20probilom?sort=price_asc&page=2&min=100'
  );
  // Padding whitespace around the slug is trimmed before encoding.
  assert.equal(
    catalogCategoryRedirect('/catalog', new URLSearchParams('category=%20blendery-1402%20'), 'GET'),
    '/catalog/blendery-1402'
  );
});

test('PATHS: redirect decision — fall-through cases', () => {
  // No category param at all (bare catalog keeps its 200).
  assert.equal(catalogCategoryRedirect('/catalog', new URLSearchParams('sort=price_asc'), 'GET'), null);
  assert.equal(catalogCategoryRedirect('/catalog', new URLSearchParams(), 'GET'), null);
  // Empty / whitespace-only slug: /catalog itself renders the same view.
  assert.equal(catalogCategoryRedirect('/catalog', new URLSearchParams('category='), 'GET'), null);
  assert.equal(catalogCategoryRedirect('/catalog', new URLSearchParams('category=%20%20'), 'GET'), null);
  // Brand present → combined filter view, not a category page.
  assert.equal(
    catalogCategoryRedirect('/catalog', new URLSearchParams('category=c&brand=b'), 'GET'),
    null
  );
  // Only GET redirects.
  assert.equal(catalogCategoryRedirect('/catalog', new URLSearchParams('category=c'), 'POST'), null);
  // Path-form URLs and unrelated paths are never touched.
  assert.equal(catalogCategoryRedirect('/catalog/blendery-1402', new URLSearchParams(), 'GET'), null);
  assert.equal(catalogCategoryRedirect('/product/abc', new URLSearchParams('category=c'), 'GET'), null);
});

test('PATHS: proxy wires the redirect with 308 and a non-admin early return', () => {
  const proxySrc = src('proxy.ts');
  // Matcher: the admin pattern unchanged; '/catalog/:path*' covers bare
  // /catalog (the 308 redirect) AND /catalog/<slug> (the ISR rewrite);
  // '/oboi' feeds the same rewrite.
  assert.match(
    proxySrc,
    /matcher:\s*\[\s*'\/admin\/:path\*',\s*'\/catalog\/:path\*',\s*'\/oboi'\s*\]/
  );
  // Permanent redirect (method-preserving), anchored to the request origin.
  assert.match(proxySrc, /NextResponse\.redirect\(\s*new URL\(redirectPath, request\.url\),\s*308\s*\)/);
  // EVERY non-admin path returns before the admin session gate — otherwise
  // anonymous storefront visitors would be bounced to /admin/login.
  assert.match(proxySrc, /if \(!pathname\.startsWith\('\/admin'\)\)/);
  // The decisions are imported (single source), not duplicated inline.
  assert.match(proxySrc, /catalogCategoryRedirect\(/);
  // ISR split wiring: query-carrying requests rewrite to the twin routes.
  assert.match(proxySrc, /catalogCategoryFilteredRewrite\(/);
  assert.match(proxySrc, /oboiFilteredRewrite\(/);
  assert.match(proxySrc, /NextResponse\.rewrite\(/);
});

test('PATHS: admin gate invariants survive the matcher change', () => {
  const proxySrc = src('proxy.ts');
  // Session validated with the auth server (never trusted cookies).
  assert.match(proxySrc, /supabase\.auth\.getUser\(\)/);
  // The login page stays always reachable (no auth requirement, no loop).
  assert.match(proxySrc, /pathname === '\/admin\/login' \|\| pathname\.startsWith\('\/admin\/login\/'\)/);
  // Unauthenticated admin path → clean /admin/login redirect.
  assert.match(proxySrc, /url\.pathname = '\/admin\/login';/);
  assert.match(proxySrc, /url\.search = '';/);
  // Refreshed session cookies survive the redirect response.
  assert.match(proxySrc, /redirectResponse\.cookies\.set\(cookie\)/);
});

// ---- 3. the routes

test('PATHS: /catalog/[category] route exists, 404s bad slugs, renders the shared view', () => {
  const routeSrc = src('app/catalog/[category]/page.tsx');
  // Same loader /catalog uses for its ?category= query value.
  assert.match(routeSrc, /fetchCategoryBySlug/);
  // Unknown/inactive slug → real 404, never an empty catalog on a path shape.
  assert.match(routeSrc, /notFound\(\)/);
  // Garbage percent-encoding is guarded, not a 500.
  assert.match(routeSrc, /decodeURIComponent/);
  assert.match(routeSrc, /catch/);
  // Renders the shared server component with the PATH slug.
  assert.match(routeSrc, /<CatalogView\s+categorySlug=\{slug\}/);
});

test('PATHS: ISR — [category] renders ONLY the pure view (no searchParams anywhere)', () => {
  const routeSrc = src('app/catalog/[category]/page.tsx');
  // On-demand ISR like the PDP: build-time prerender of the active slugs,
  // 60s revalidate of every entry (robots metadata included).
  assert.match(routeSrc, /export const revalidate = 60/);
  assert.match(routeSrc, /export async function generateStaticParams/);
  assert.match(routeSrc, /fetchActiveCategories/);
  // A dictionary read failure must not fail the build — degrade to
  // on-demand rendering of every slug.
  assert.match(routeSrc, /catch\s*\{[\s\S]*?return \[\];/);
  // THE invariant of the split: the ISR route never awaits/passes
  // searchParams — a dynamic access here would opt the whole route into
  // dynamic rendering and disable the ISR cache.
  assert.doesNotMatch(routeSrc, /await searchParams/);
  assert.doesNotMatch(routeSrc, /rawParams=\{await searchParams\}/);
  // Metadata reads ONLY params; the pure view's chain runs with {} params.
  assert.match(routeSrc, /rawParams:\s*\{\}/);
  assert.match(routeSrc, /rawParams=\{\{\}\}/);
});

test('PATHS: filtered twin renders query views dynamically with the full metadata chain', () => {
  const twinSrc = src('app/catalog/[category]/filtered/page.tsx');
  // Never cached: every filtered/sorted/paginated view renders per request
  // with its noindex,follow metadata (lib/seo.ts).
  assert.match(twinSrc, /export const dynamic = 'force-dynamic'/);
  assert.match(twinSrc, /await searchParams/);
  assert.match(twinSrc, /fetchCategoryBySlug/);
  assert.match(twinSrc, /notFound\(\)/);
  assert.match(twinSrc, /decodeURIComponent/);
  assert.match(twinSrc, /<CatalogView\s+categorySlug=\{slug\}\s+rawParams=\{await searchParams\}\s*\/>/);
});

// ---- 3b. the ISR rewrite decisions (pure, same file as the redirect)

test('PATHS: catalog filtered rewrite — query-carrying single-segment paths only', () => {
  assert.equal(
    catalogCategoryFilteredRewrite('/catalog/blendery-1402', '?sort=price_asc&page=2'),
    '/catalog/blendery-1402/filtered'
  );
  // The bare path (ISR view) is never rewritten.
  assert.equal(catalogCategoryFilteredRewrite('/catalog/blendery-1402', ''), null);
  // Deeper or shallower shapes keep today's routing (404 / bare catalog).
  assert.equal(catalogCategoryFilteredRewrite('/catalog', '?sort=price_asc'), null);
  assert.equal(catalogCategoryFilteredRewrite('/catalog/a/b', '?sort=price_asc'), null);
  // Unrelated paths untouched.
  assert.equal(catalogCategoryFilteredRewrite('/product/abc', '?x=1'), null);
  // Garbage percent-encoding falls through to the route's decode guard (404),
  // and a decoded slug is re-encoded exactly once for the twin route.
  assert.equal(catalogCategoryFilteredRewrite('/catalog/%zz', '?x=1'), null);
  assert.equal(
    catalogCategoryFilteredRewrite('/catalog/kat%20z%20probilom', '?page=2'),
    '/catalog/kat%20z%20probilom/filtered'
  );
});

test('PATHS: oboi filtered rewrite — bare /oboi with a query only', () => {
  assert.equal(oboiFilteredRewrite('/oboi', '?page=2'), '/oboi/filtered');
  assert.equal(oboiFilteredRewrite('/oboi', '?base=Флізелінова&sort=price_asc'), '/oboi/filtered');
  // The ISR view itself is never rewritten; neither are other paths.
  assert.equal(oboiFilteredRewrite('/oboi', ''), null);
  assert.equal(oboiFilteredRewrite('/oboi/filtered', '?page=2'), null);
  assert.equal(oboiFilteredRewrite('/', '?x=1'), null);
});

test('PATHS: /catalog delegates to CatalogView; the shared renderer keeps the metadata chain', () => {
  const pageSrc = src('app/catalog/page.tsx');
  assert.match(pageSrc, /<CatalogView\s+rawParams=\{await searchParams\}\s*\/>/);
  assert.match(pageSrc, /catalogViewMetadata/);

  const viewSrc = src('app/catalog/CatalogView.tsx');
  // The unchanged chain: applyCategorySeoMetadata(buildCatalogViewMetadata(...)).
  assert.match(viewSrc, /applyCategorySeoMetadata\(\s*buildCatalogViewMetadata\(/);
  // Child-category links moved to the path form.
  assert.match(viewSrc, /\/catalog\/\$\{encodeURIComponent\(child\.slug\)\}/);
});

test('PATHS: sitemap lists categories on the path form; brands stay query-form', () => {
  const sitemapSrc = src('app/sitemap.ts');
  assert.match(sitemapSrc, /\/catalog\/\$\{encodeURIComponent\(category\.slug\)\}/);
  assert.match(sitemapSrc, /\/catalog\?brand=\$\{encodeURIComponent\(brand\.slug\)\}/);
});

test('PATHS: catalog sort control stays on the category path page', () => {
  // Regression 2026-09-13 (owner report «в шпалерах сортируешь по цене —
  // появляются другие товары»): sorting on /catalog/<slug> navigated to
  // bare /catalog?sort=… — the category dropped out, and the general
  // catalog (wallpapers excluded there) rendered OTHER products.
  const sel = src('app/catalog/SortSelect.tsx');
  assert.match(sel, /basePath\?: string/);
  assert.match(sel, /router\.push\(qs \? `\$\{basePath\}\?\$\{qs\}` : basePath\)/);
  assert.doesNotMatch(sel, /`\/catalog\?\$\{qs\}`/, 'no hardcoded bare /catalog');
  const view = src('app/catalog/CatalogView.tsx');
  assert.match(view, /<SortSelect basePath=\{linkBase\} \/>/);
});
