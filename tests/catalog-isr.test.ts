/**
 * ISR split (perf/SEO audit 2026-09-14): /catalog/<slug> and /oboi render
 * ONLY their pure view inside ISR (revalidate 60); every query-carrying
 * request is rewritten by proxy.ts to a force-dynamic twin route BEFORE
 * routing. Ground truth this file pins:
 *
 *  1. An ISR cache key is the PATHNAME alone — a cached page must never be
 *     served for ?sort/?page/?base views, so the twins carry ALL query
 *     handling and the ISR routes must not read searchParams AT ALL (any
 *     await would also flip the whole route to dynamic rendering and
 *     silently disable the cache).
 *  2. Filtered/paginated/search views keep today's per-request rendering
 *     and their noindex,follow metadata (lib/seo.ts decides; unchanged).
 *  3. /oboi gains the missing structured data on the indexable view:
 *     BreadcrumbList JSON-LD (Головна → Шпалери) + visible trail, and the
 *     FAQ block + FAQPage JSON-LD ONLY where buildWallpapersMetadata is
 *     index,follow (page 1, no ?base=, no explicit ?sort=).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildOboiBreadcrumbJsonLd } from '../app/lib/schema-org.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- 1. /catalog/[category] — the ISR route ----

test('ISR: [category] page prerenders active slugs and revalidates every 60s', () => {
  const route = src('app/catalog/[category]/page.tsx');
  assert.match(route, /export const revalidate = 60;/);
  assert.match(route, /generateStaticParams/);
  // Active slugs come from the SAME dictionary loader the sitemap uses.
  assert.match(route, /fetchActiveCategories\(\)/);
  // On-demand degradation: a dictionary failure must not fail the build.
  assert.match(route, /catch\s*\{[\s\S]*?return \[\];/);
});

test('ISR: [category] metadata chain runs with empty query params (pure view)', () => {
  const route = src('app/catalog/[category]/page.tsx');
  // Same shared chain as /catalog and the twin — the decision stays in
  // lib/seo.ts; the ISR route just always feeds it the pure view.
  assert.match(route, /catalogViewMetadata\(\{[\s\S]*?categorySlug: slug \?\? undefined,[\s\S]*?rawParams:\s*\{\},[\s\S]*?\}\);/);
  // generateMetadata reads ONLY params (the ISR contract).
  assert.doesNotMatch(route, /await searchParams/);
});

test('ISR: [category] twin is force-dynamic and renders the query view', () => {
  const twin = src('app/catalog/[category]/filtered/page.tsx');
  assert.match(twin, /export const dynamic = 'force-dynamic';/);
  assert.match(twin, /await searchParams/);
  assert.match(twin, /notFound\(\)/);
  assert.match(twin, /<CatalogView\s+categorySlug=\{slug\}\s+rawParams=\{await searchParams\}\s*\/>/);
});

// ---- 2. /oboi — the ISR route, its twin, and the FAQ gate ----

test('ISR: /oboi page is ISR and reads no searchParams', () => {
  const page = src('app/oboi/page.tsx');
  assert.match(page, /export const revalidate = 60;/);
  assert.doesNotMatch(page, /await searchParams/);
  assert.doesNotMatch(page, /rawParams=\{await searchParams\}/);
  // The pure view IS the indexable view: metadata without params.
  assert.match(page, /return buildWallpapersMetadata\(\);/);
  // Pure-view data defaults: page 1, no base, default alphabetical sort.
  assert.match(page, /page: 1,/);
  assert.match(page, /base: undefined,/);
  assert.match(page, /sort: 'name_asc' as CatalogSort/);
});

test('ISR: /oboi twin is force-dynamic and mirrors the noindex conditions for the FAQ gate', () => {
  const twin = src('app/oboi/filtered/page.tsx');
  assert.match(twin, /export const dynamic = 'force-dynamic';/);
  assert.match(twin, /await searchParams/);
  // The FAQ gate must be the EXACT mirror of buildWallpapersMetadata's
  // noindex branch (page > 1 || base !== undefined || sort !== ''):
  // showFaq = page 1 AND no raw ?base= (junk included) AND no explicit ?sort=.
  assert.match(
    twin,
    /showFaq=\{page === 1 && rawBase === undefined && sortParam === ''\}/
  );
});

test('ISR: /oboi storefront carries breadcrumb JSON-LD and the gated FAQ on every view', () => {
  const shelf = src('app/oboi/OboiStorefront.tsx');
  // BreadcrumbList (Головна → Шпалери) through the sanctioned ProductJsonLd
  // sink, built by the schema-org builder (no hand-rolled JSON).
  assert.match(shelf, /buildOboiBreadcrumbJsonLd\(siteUrl\)/);
  assert.match(shelf, /<ProductJsonLd data=\{breadcrumbJsonLd\} \/>/);
  // Visible trail mirrors the JSON-LD (PDP nav style), current level plain.
  assert.match(shelf, /aria-label="Навігація"/);
  assert.match(shelf, /<span className="text-gray-900">Шпалери<\/span>/);
  // FAQ: visible section AND its JSON-LD behind the same showFaq gate.
  assert.match(shelf, /\{showFaq && <FaqJsonLd questions=\{WALLPAPER_FAQ\} \/>\}/);
  assert.match(shelf, /\{showFaq && <FaqSection \/\>/);
});

test('ISR: /oboi page passes the FAQ gate OPEN; the twin computes it', () => {
  const page = src('app/oboi/page.tsx');
  assert.match(page, /showFaq=\{true\}/);
  const twin = src('app/oboi/filtered/page.tsx');
  assert.match(twin, /showFaq=\{page === 1/);
});

// ---- 3. the breadcrumb builder (pure) ----

test('ISR: buildOboiBreadcrumbJsonLd — Головна → Шпалери on the canonical shapes', () => {
  const data = buildOboiBreadcrumbJsonLd('https://towary-dla-domu.com') as {
    '@context': string;
    '@type': string;
    itemListElement: { position: number; name: string; item: string }[];
  };
  assert.equal(data['@context'], 'https://schema.org');
  assert.equal(data['@type'], 'BreadcrumbList');
  assert.equal(data.itemListElement.length, 2);
  assert.deepEqual(data.itemListElement[0], {
    '@type': 'ListItem',
    position: 1,
    name: 'Головна',
    item: 'https://towary-dla-domu.com/',
  });
  assert.deepEqual(data.itemListElement[1], {
    '@type': 'ListItem',
    position: 2,
    name: 'Шпалери',
    item: 'https://towary-dla-domu.com/oboi',
  });
  // Trailing slash in the site URL is normalized away (same as the
  // product/catalog builders).
  const slashed = buildOboiBreadcrumbJsonLd('https://towary-dla-domu.com/') as {
    itemListElement: { item: string }[];
  };
  assert.equal(slashed.itemListElement[1]?.item, 'https://towary-dla-domu.com/oboi');
});
