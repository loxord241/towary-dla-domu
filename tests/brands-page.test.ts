/**
 * /brands hub (SEO batch 2026-09-17, task S3): a single indexable landing
 * listing every NON-EMPTY active brand — the crawlable entrance to the
 * /catalog?brand=<slug> views that until now were reachable only through
 * the client-side filter. Source-level pins in the project style
 * (node:test + readFileSync), modeled on samovyviz-page.test.ts and
 * catalog-isr.test.ts:
 *  1. Route + metadata — ISR revalidate 300, indexable, self-canonical,
 *     витринний openGraph (shallow-merge lesson: a page-level og object
 *     REPLACES the layout default, so locale/type/siteName/image repeat).
 *  2. Brand list — fetchActiveBrands gated by fetchBrandProductCount with
 *     the EXACT filterNonEmptyChildren semantics (0 → dropped, null →
 *     kept); each link uses the canonical query form /catalog?brand=<slug>
 *     and carries the «N товарів» counter from the same count.
 *  3. BreadcrumbList Головна → Бренди via buildBrandsBreadcrumbJsonLd
 *     (pure, constant-input), rendered through the sanctioned ProductJsonLd
 *     sink (no fifth dangerouslySetInnerHTML).
 *  4. Entrances — sitemap static entry ('/brands', weekly, 0.6) and the
 *     footer INFO_LINKS item; robots.ts keeps /brands crawlable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildBrandsBreadcrumbJsonLd } from '../app/lib/schema-org.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const PAGE = src('app/brands/page.tsx');
const FOOTER = src('app/components/SiteFooter.tsx');
const SITEMAP = src('app/sitemap.ts');
const ROBOTS = src('app/robots.ts');

// ---------------------------------------------------------------------------
// 1. Route + metadata: ISR 300, indexable, self-canonical, витринний og
// ---------------------------------------------------------------------------

test('BRANDS: page exists, ISR 300, indexable, self-canonical, unique title', () => {
  assert.match(PAGE, /export const revalidate = 300;/);
  // Indexable: the page must NOT opt out of indexing (lib/seo.ts policy —
  // «indexable set = sitemap set», and /brands IS in the sitemap).
  assert.ok(!PAGE.includes('noindex'), 'page must stay indexable');
  assert.match(PAGE, /alternates:\s*\{\s*canonical:\s*'\/brands'\s*\}/);
  assert.match(PAGE, /Бренди — Товари для дому/);
});

test('BRANDS: openGraph repeats the витринний fields (shallow-merge lesson)', () => {
  // A page-level openGraph object REPLACES the root layout default, so the
  // hub must repeat locale/type/siteName AND the default image — same as
  // buildViewOpenGraph (lib/seo.ts) and the root layout (og-metadata pins).
  assert.match(PAGE, /locale:\s*'uk_UA'/);
  assert.match(PAGE, /type:\s*'website'/);
  assert.match(PAGE, /siteName:\s*SITE_NAME/);
  assert.match(PAGE, /images:\s*\['\/og-image\.png'\]/);
});

test('BRANDS: exactly one h1 «Бренди»', () => {
  assert.equal((PAGE.match(/<h1/g) ?? []).length, 1, 'exactly one h1 literal');
  assert.match(PAGE, />\s*Бренди\s*<\/h1>/);
});

// ---------------------------------------------------------------------------
// 2. The brand list: count-gated with filterNonEmptyChildren semantics
// ---------------------------------------------------------------------------

test('BRANDS: list is count-gated with filterNonEmptyChildren semantics', () => {
  // Data sources: the active dictionary + the SAME eligible-product counter
  // the noindex/sitemap emptiness contract uses (no new counter).
  assert.match(PAGE, /fetchActiveBrands\(\)/);
  assert.match(PAGE, /fetchBrandProductCount\(/);
  // Parallel counts, then the EXACT filterNonEmptyChildren predicate
  // (app/lib/category-seo.ts): count !== 0 — 0 is dropped, null (unknown/
  // inactive slug) degrades to non-empty, a DB read error propagates.
  assert.match(PAGE, /Promise\.all\(/);
  assert.match(PAGE, /!== 0/);
  // The page documents the copied semantics in a comment.
  assert.match(PAGE, /filterNonEmptyChildren/);
});

test('BRANDS: every brand links the canonical /catalog?brand= form with a counter', () => {
  // Canonical form of a brand view (lib/seo.ts decideCatalogIndexing):
  // the query form — brands have no path route.
  assert.match(
    PAGE,
    /href=\{`\/catalog\?brand=\$\{encodeURIComponent\(brand\.slug\)\}`\}/
  );
  // Counter «N товарів» next to the link (same count that gated the entry).
  assert.match(PAGE, /товарів/);
  assert.match(PAGE, /min-h-\[44px\]/, 'brand links are ≥44px tap targets');
});

// ---------------------------------------------------------------------------
// 3. BreadcrumbList Головна → Бренди through the sanctioned sink
// ---------------------------------------------------------------------------

test('BRANDS: breadcrumb JSON-LD via buildBrandsBreadcrumbJsonLd + ProductJsonLd', () => {
  assert.match(PAGE, /buildBrandsBreadcrumbJsonLd\(siteUrl\)/);
  // The sanctioned JSON-LD sink — no new dangerouslySetInnerHTML on the page.
  assert.match(PAGE, /<ProductJsonLd data=\{breadcrumbJsonLd\} \/>/);
  assert.ok(!PAGE.includes('dangerouslySetInnerHTML'));
  // Same siteUrl basis as the oboi storefront and app/sitemap.ts.
  assert.match(
    PAGE,
    /process\.env\.NEXT_PUBLIC_SITE_URL \?\? 'http:\/\/localhost:3000'/
  );
});

test('BRANDS: buildBrandsBreadcrumbJsonLd — Головна → Бренди on the canonical shapes', () => {
  const data = buildBrandsBreadcrumbJsonLd('https://towary-dla-domu.com') as {
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
    name: 'Бренди',
    item: 'https://towary-dla-domu.com/brands',
  });
  // Trailing slash in the site URL is normalized away (same as the
  // oboi/product/catalog builders).
  const slashed = buildBrandsBreadcrumbJsonLd('https://towary-dla-domu.com/') as {
    itemListElement: { item: string }[];
  };
  assert.equal(slashed.itemListElement[1]?.item, 'https://towary-dla-domu.com/brands');
});

// ---------------------------------------------------------------------------
// 4. Entrances: sitemap static entry, footer link, robots stays open
// ---------------------------------------------------------------------------

test('BRANDS: static sitemap entry (indexable set = sitemap set)', () => {
  // Listed among staticEntries with the neighbor comment in place…
  assert.match(SITEMAP, /'\/brands',/);
  assert.match(
    SITEMAP,
    /static indexable route with self-canonical[\s\S]{0,200}'\/brands',/,
    'the entry keeps the «static indexable route with self-canonical» comment'
  );
  // …and the hub cadence: weekly, priority 0.6 (brand-level URLs cadence —
  // same as brandEntries/comboEntries).
  assert.match(SITEMAP, /path === '\/brands'\s*\?\s*'weekly'/);
  assert.match(SITEMAP, /path === '\/brands'\s*\?\s*0\.6/);
});

test('BRANDS: footer info link present', () => {
  assert.match(FOOTER, /\{ href: '\/brands', label: 'Бренди' \}/);
});

test('BRANDS: robots.ts keeps /brands crawlable (read-only pin)', () => {
  assert.match(ROBOTS, /allow: '\/'/);
  assert.ok(
    !ROBOTS.includes('/brands'),
    '/brands must not appear in the disallow list'
  );
});
