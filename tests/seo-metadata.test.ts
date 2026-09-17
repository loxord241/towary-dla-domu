/**
 * Pure SEO decision layer: canonical/noindex policy for /catalog views,
 * query truncation, and per-view metadata builders (spec 2026-08-26 B/G +
 * owner SEO package 2026-09-16: non-empty category+brand combos open up).
 * Policy invariant (RESTORED to equality 2026-09-17): the sitemap set EQUALS
 * the indexable set — bare /catalog, single valid NON-EMPTY category/brand
 * views AND valid non-empty category+brand combos on page 1 with the
 * default sort and no other filters. The 2026-09-16 narrowing
 * («sitemap ⊆ indexable», combos absent from the sitemap pending an owner
 * decision) is lifted: owner approved sitemap inclusion on 2026-09-17 and
 * app/sitemap.ts now derives non-empty pairs via
 * seo-sitemap.collectNonEmptyComboPairs. Everything else: noindex,follow,
 * and canonical is emitted ONLY on indexable URLs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SITE_NAME,
  decideCatalogIndexing,
  truncateQuery,
  truncateMetaDescription,
  buildCatalogViewMetadata,
  buildWallpapersMetadata,
} from '../app/lib/seo.ts';

function dec(over: Partial<Parameters<typeof decideCatalogIndexing>[0]> = {}) {
  return decideCatalogIndexing(over);
}

test('SEO: bare /catalog is indexable with self canonical', () => {
  assert.deepEqual(dec(), { indexable: true, canonicalPath: '/catalog' });
});

test('SEO: single valid category view is indexable, canonical carries encoded slug', () => {
  const r = dec({ categorySlug: 'blendery-1402', categoryFound: true });
  assert.equal(r.indexable, true);
  // 2026-09-13: path form is THE canonical; the ?category= query form
  // 308-redirects to /catalog/<slug> (proxy.ts).
  assert.equal(r.canonicalPath, '/catalog/blendery-1402');
});

test('SEO: single valid brand view is indexable', () => {
  const r = dec({ brandSlug: 'tefal', brandFound: true });
  assert.deepEqual(r, { indexable: true, canonicalPath: '/catalog?brand=tefal' });
});

test('SEO: unknown/inactive category or brand slug → noindex without canonical', () => {
  for (const input of [
    { categorySlug: 'bogus', categoryFound: false },
    { brandSlug: 'bogus', brandFound: false },
    { categorySlug: 'bogus' }, // missing flag counts as not found
    { brandSlug: 'bogus' },
  ]) {
    const r = dec(input);
    assert.equal(r.indexable, false, JSON.stringify(input));
    assert.equal(r.canonicalPath, null);
  }
});

test('SEO: search views are never indexable', () => {
  const r = dec({ search: 'щітка', categorySlug: 'c', categoryFound: true });
  assert.equal(r.indexable, false);
  assert.equal(r.canonicalPath, null);
});

test('SEO: empty category (0 eligible products) → noindex without canonical', () => {
  const r = dec({ categorySlug: 'blendery-1402', categoryFound: true, categoryHasProducts: false });
  assert.equal(r.indexable, false, 'empty category must not be indexable');
  assert.equal(r.canonicalPath, null);
});

test('SEO: empty brand (0 eligible products) → noindex without canonical', () => {
  const r = dec({ brandSlug: 'tefal', brandFound: true, brandHasProducts: false });
  assert.equal(r.indexable, false, 'empty brand must not be indexable');
  assert.equal(r.canonicalPath, null);
});

test('SEO: non-empty category/brand stay indexable when the fact is present', () => {
  const c = dec({ categorySlug: 'blendery-1402', categoryFound: true, categoryHasProducts: true });
  assert.deepEqual(c, { indexable: true, canonicalPath: '/catalog/blendery-1402' });
  const b = dec({ brandSlug: 'tefal', brandFound: true, brandHasProducts: true });
  assert.deepEqual(b, { indexable: true, canonicalPath: '/catalog?brand=tefal' });
});

test('SEO: missing product-count fact keeps legacy behavior (undefined = treated non-empty)', () => {
  const c = dec({ categorySlug: 'blendery-1402', categoryFound: true });
  assert.equal(c.indexable, true);
  assert.equal(c.canonicalPath, '/catalog/blendery-1402');
});

test('SEO: metadata builder emits noindex for the empty-category fact', () => {
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true, categoryHasProducts: false },
    categoryName: 'Блендери',
  });
  assert.deepEqual(m.robots, { index: false, follow: true });
  assert.equal(m.alternates, undefined, 'noindex views never carry a canonical');
});

test('SEO: filter combinations break indexability', () => {
  // NOTE 2026-09-16: category+brand combos LEFT this list — a valid
  // non-empty combo is now indexable (owner SEO-audit P1), pinned by the
  // SEO-COMBO tests below. Price/stock/sort/pagination combinations stay
  // noindex for both single-axis and combo views.
  const combos: Parameters<typeof decideCatalogIndexing>[0][] = [
    { categorySlug: 'c', categoryFound: true, minPrice: 10 },
    { categorySlug: 'c', categoryFound: true, maxPrice: 10 },
    { categorySlug: 'c', categoryFound: true, inStockOnly: true },
    { categorySlug: 'c', categoryFound: true, sort: 'price_asc' },
    { categorySlug: 'c', categoryFound: true, page: 2 },
    { brandSlug: 'b', brandFound: true, sort: 'name_asc' },
  ];
  for (const input of combos) {
    assert.equal(dec(input).indexable, false, JSON.stringify(input));
    assert.equal(dec(input).canonicalPath, null);
  }
});

// ---- category+brand combo views (owner SEO package 2026-09-16, P1:
// previously a noindex blind spot) ----

test('SEO-COMBO: valid combo is indexable with the path+query canonical', () => {
  const r = dec({
    categorySlug: 'blendery-1402',
    categoryFound: true,
    brandSlug: 'tefal',
    brandFound: true,
  });
  assert.deepEqual(r, {
    indexable: true,
    canonicalPath: '/catalog/blendery-1402?brand=tefal',
  });
});

test('SEO-COMBO: canonical encodes BOTH slugs exactly once', () => {
  const r = dec({
    categorySlug: 'кат z probilom',
    categoryFound: true,
    brandSlug: 'бренд 1',
    brandFound: true,
  });
  assert.equal(
    r.canonicalPath,
    `/catalog/${encodeURIComponent('кат z probilom')}?brand=${encodeURIComponent('бренд 1')}`
  );
});

test('SEO-COMBO: explicit per-axis non-empty facts keep the combo indexable', () => {
  const r = dec({
    categorySlug: 'c',
    categoryFound: true,
    categoryHasProducts: true,
    brandSlug: 'b',
    brandFound: true,
    brandHasProducts: true,
  });
  assert.deepEqual(r, { indexable: true, canonicalPath: '/catalog/c?brand=b' });
});

test('SEO-COMBO: jointly-empty combo (comboHasProducts: false) → noindex without canonical', () => {
  const r = dec({
    categorySlug: 'c',
    categoryFound: true,
    brandSlug: 'b',
    brandFound: true,
    comboHasProducts: false,
  });
  assert.equal(r.indexable, false, 'jointly-empty combo must not be indexable');
  assert.equal(r.canonicalPath, null);
});

test('SEO-COMBO: missing combo fact (undefined) keeps legacy non-empty behavior', () => {
  const r = dec({
    categorySlug: 'c',
    categoryFound: true,
    brandSlug: 'b',
    brandFound: true,
    comboHasProducts: undefined,
  });
  assert.deepEqual(r, { indexable: true, canonicalPath: '/catalog/c?brand=b' });
});

test('SEO-COMBO: per-axis empty facts noindex a combo too', () => {
  for (const input of [
    {
      categorySlug: 'c',
      categoryFound: true,
      brandSlug: 'b',
      brandFound: true,
      categoryHasProducts: false,
    },
    {
      categorySlug: 'c',
      categoryFound: true,
      brandSlug: 'b',
      brandFound: true,
      brandHasProducts: false,
    },
  ]) {
    const r = dec(input);
    assert.equal(r.indexable, false, JSON.stringify(input));
    assert.equal(r.canonicalPath, null);
  }
});

test('SEO-COMBO: the combo fact is never read outside a valid combo', () => {
  // brand-only view: comboHasProducts must be ignored (same contract as
  // the per-axis facts: never read for the non-requested entity).
  const b = dec({ brandSlug: 'b', brandFound: true, comboHasProducts: false });
  assert.deepEqual(b, { indexable: true, canonicalPath: '/catalog?brand=b' });
});

test('SEO-COMBO: everything that noindexes single-axis views noindexes combos too', () => {
  const base = {
    categorySlug: 'c',
    categoryFound: true,
    brandSlug: 'b',
    brandFound: true,
  };
  const variants: Parameters<typeof decideCatalogIndexing>[0][] = [
    { ...base, search: 'чайник' },
    { ...base, sort: 'price_asc' },
    { ...base, sort: 'name_asc' },
    { ...base, page: 2 },
    { ...base, minPrice: 10 },
    { ...base, maxPrice: 500 },
    { ...base, inStockOnly: true },
    { ...base, categoryFound: false, comboHasProducts: undefined }, // invalid category slug
    { ...base, brandFound: false, comboHasProducts: undefined }, // invalid brand slug
  ];
  for (const input of variants) {
    assert.equal(dec(input).indexable, false, JSON.stringify(input));
    assert.equal(dec(input).canonicalPath, null);
  }
});

test('SEO-COMBO: metadata builder — combo title/description template, canonical, og mirrors', () => {
  const m = buildCatalogViewMetadata({
    input: {
      categorySlug: 'blendery-1402',
      categoryFound: true,
      brandSlug: 'tefal',
      brandFound: true,
    },
    categoryName: 'Блендери',
    brandName: 'TEFAL',
  });
  assert.equal(m.title, 'Блендери TEFAL — Товари для дому');
  assert.equal(
    m.description,
    'Товари у категорії «Блендери» бренду TEFAL — купити в інтернет-магазині Товари для дому з доставкою по Україні та самовивозом у Кривому Розі.'
  );
  assert.equal(m.robots, undefined, 'a valid combo emits no robots override');
  assert.deepEqual(m.alternates, {
    canonical: '/catalog/blendery-1402?brand=tefal',
  });
  assert.ok(m.openGraph, 'og object missing on a combo view');
  assert.equal(m.openGraph!.title, m.title);
  assert.equal(m.openGraph!.description, m.description);
});

test('SEO-COMBO: per-axis admin copy does NOT leak onto the combo meta', () => {
  const m = buildCatalogViewMetadata({
    input: {
      categorySlug: 'blendery-1402',
      categoryFound: true,
      brandSlug: 'tefal',
      brandFound: true,
    },
    categoryName: 'Блендери',
    brandName: 'TEFAL',
    categoryDescription: 'Унікальний текст про блендери, капнутий до 160 символів.',
    brandDescription: 'Унікальний текст бренду TEFAL.',
  });
  // Copy is per-axis on purpose: categories.description / brands.description
  // are written for the single-axis views, the combo keeps the template.
  assert.equal(
    m.description,
    'Товари у категорії «Блендери» бренду TEFAL — купити в інтернет-магазині Товари для дому з доставкою по Україні та самовивозом у Кривому Розі.'
  );
});

test('SEO-COMBO: unknown category on a combo stays noindex generic without canonical', () => {
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'zzz', brandSlug: 'tefal', brandFound: true },
    brandName: 'TEFAL',
  });
  assert.deepEqual(m.robots, { index: false, follow: true });
  assert.equal(m.alternates, undefined);
});

test('SEO: truncateQuery strips control chars, collapses whitespace, caps length', () => {
  assert.equal(truncateQuery('  a\t\nb  ', 10), 'a b');
  assert.equal(truncateQuery('x\u0000y', 10), 'xy');
  assert.equal(truncateQuery('ж'.repeat(80)), 'ж'.repeat(50));
  assert.equal(truncateQuery(''), '');
  assert.equal(truncateQuery('%,(")'), '', 'specials-only query collapses to nothing');
});

test('SEO: metadata builder — category title follows «X — Товари для дому» (audit R4 2026-09-15)', () => {
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
  });
  assert.equal(m.title, 'Блендери — Товари для дому');
  // The «купити в Товари для дому» tail (a) read ungrammatically without a
  // noun after «в» and (b) is already covered by the description template —
  // the short brand tail keeps the intent word budget for the name itself.
  assert.ok(!String(m.title).includes('купити'));
  assert.ok(String(m.description).includes('купити'));
  assert.ok(String(m.description).includes('Блендери'));
  assert.ok(!m.robots, 'indexable view emits no robots override');
  assert.deepEqual(m.alternates, { canonical: '/catalog/blendery-1402' });
});

test('SEO: metadata builder — brand title and search title', () => {
  const b = buildCatalogViewMetadata({
    input: { brandSlug: 'tefal', brandFound: true },
    brandName: 'TEFAL',
  });
  assert.equal(b.title, 'TEFAL — Товари для дому');

  const s = buildCatalogViewMetadata({ input: { search: 'мультипіч tefal' } });
  assert.equal(s.title, 'Пошук: «мультипіч tefal» | Товари для дому');
  assert.deepEqual(s.robots, { index: false, follow: true });
  assert.equal(s.alternates, undefined);
});

test('SEO-R8: admin brand description becomes the meta description, template stays the fallback', () => {
  const copy = 'Техніка TEFAL: розумні рішення для кухні та дому з офіційною гарантією.';
  const withCopy = buildCatalogViewMetadata({
    input: { brandSlug: 'tefal', brandFound: true },
    brandName: 'TEFAL',
    brandDescription: copy,
  });
  assert.equal(withCopy.description, copy);

  const fallback = buildCatalogViewMetadata({
    input: { brandSlug: 'tefal', brandFound: true },
    brandName: 'TEFAL',
    brandDescription: null,
  });
  assert.ok(String(fallback.description).includes('TEFAL'));
  assert.ok(String(fallback.description).includes('доставкою по Україні'));
});

test('SEO: long search query is truncated inside title, never throws', () => {
  const s = buildCatalogViewMetadata({ input: { search: 'ж'.repeat(200) } });
  const title = String(s.title);
  assert.ok(title.length <= 80, `title too long: ${title.length}`);
  assert.ok(title.startsWith('Пошук: «'));
});

test('SEO: unknown category falls back to generic catalog copy with noindex', () => {
  const m = buildCatalogViewMetadata({ input: { categorySlug: 'zzz' } });
  assert.deepEqual(m.robots, { index: false, follow: true });
  assert.equal(m.alternates, undefined);
});

test('SEO: SITE_NAME is the shop brand used across builders', () => {
  assert.equal(SITE_NAME, 'Товари для дому');
});

// ---- OG on catalog views (audit 2026-09-13: og:title/og:description were
// missing, so Viber/Telegram reposts showed the bare layout default) ----

test('SEO-OG: indexable category view carries og:title/og:description mirroring the SERP copy', () => {
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
  });
  assert.ok(m.openGraph, 'og object missing on an indexable view');
  assert.equal(m.openGraph!.title, m.title);
  assert.equal(m.openGraph!.description, m.description);
  // og:url is intentionally absent — the canonical lives in alternates.
  assert.equal(m.openGraph!.url, undefined);
  assert.deepEqual(m.alternates, { canonical: '/catalog/blendery-1402' });
});

test('SEO-OG: page-level og REPLACES the layout object, so locale/type/siteName/image are repeated', () => {
  // Next merges metadata shallowly: a view that sets openGraph without
  // locale/type/siteName/images would lose the layout default og:image
  // entirely (generate-metadata docs, «Merging»).
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
  });
  assert.equal(m.openGraph!.locale, 'uk_UA');
  // `.type` sits on one member of Next's OpenGraph union — structural cast.
  assert.equal((m.openGraph as unknown as { type: string }).type, 'website');
  assert.equal(m.openGraph!.siteName, 'Товари для дому');
  assert.deepEqual(m.openGraph!.images, ['/og-image.png']);
});

test('SEO-OG: noindex views (search) still carry og — harmless, keeps messenger previews meaningful', () => {
  const s = buildCatalogViewMetadata({ input: { search: 'мультипіч' } });
  assert.deepEqual(s.robots, { index: false, follow: true });
  assert.ok(s.openGraph, 'og missing on a noindex view');
  assert.equal(s.openGraph!.title, s.title);
  assert.equal(s.openGraph!.description, s.description);
});

// ---- unique category meta description from the admin copy (audit
// 2026-09-13: the template was shared by every category) ----

test('SEO-DESC: admin category description becomes the meta description, capped ≤160 on a word boundary', () => {
  const long = 'Блендери для кухні — '.repeat(20); // 420 chars of prose
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
    categoryDescription: long,
  });
  assert.equal(m.description, truncateMetaDescription(long));
  assert.ok(String(m.description).length <= 160);
  assert.ok(!String(m.description).endsWith('—'), 'no dangling word fragment');
});

test('SEO-DESC: short admin copy passes through as-is; blank/null falls back to the template', () => {
  const short = 'Компактні блендери для смузі та соусів з доставкою по Україні.';
  const withCopy = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
    categoryDescription: short,
  });
  assert.equal(withCopy.description, short);

  for (const blank of [null, undefined, '   ', '\n\n']) {
    const fallback = buildCatalogViewMetadata({
      input: { categorySlug: 'blendery-1402', categoryFound: true },
      categoryName: 'Блендери',
      categoryDescription: blank as string | null | undefined,
    });
    assert.equal(
      fallback.description,
      'Товари у категорії «Блендери» — купити в інтернет-магазині Товари для дому з доставкою по Україні та самовивозом у Кривому Розі.',
      `blank description (${JSON.stringify(blank)}) must keep the geo template`
    );
  }
});

// ---- geo in the template descriptions (marketing audit 2026-09-14: generic
// metas carried no geo; titles stay geo-free, the geo lives in description) ----

test('SEO-GEO: template descriptions carry Ukraine delivery + Kryvyi Rih pickup', () => {
  // Category fallback template
  const cat = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
  });
  assert.ok(String(cat.description).includes('доставкою по Україні'));
  assert.ok(String(cat.description).includes('самовивозом у Кривому Розі'));

  // Brand fallback template
  const brand = buildCatalogViewMetadata({
    input: { brandSlug: 'tefal', brandFound: true },
    brandName: 'TEFAL',
  });
  assert.ok(String(brand.description).includes('доставкою по Україні'));
  assert.ok(String(brand.description).includes('самовивозом у Кривому Розі'));

  // Bare /catalog template (different grammar — nominative tail)
  const bare = buildCatalogViewMetadata({ input: {} });
  assert.ok(String(bare.description).includes('доставка по Україні'));
  assert.ok(String(bare.description).includes('самовивіз у Кривому Розі'));

  // /oboi template keeps the factual type list and gains the pickup geo
  const oboi = buildWallpapersMetadata();
  assert.ok(String(oboi.description).includes('вініл, флізелін, дуплекс, шовкографія'));
  assert.ok(String(oboi.description).includes('доставкою по Україні'));
  assert.ok(String(oboi.description).includes('самовивозом у Кривому Розі'));
});

test('SEO-GEO: titles stay geo-free (city would overflow the ~60-char SERP window)', () => {
  for (const m of [
    buildCatalogViewMetadata({ input: {} }),
    buildCatalogViewMetadata({
      input: { categorySlug: 'blendery-1402', categoryFound: true },
      categoryName: 'Блендери',
    }),
    buildCatalogViewMetadata({
      input: { brandSlug: 'tefal', brandFound: true },
      brandName: 'TEFAL',
    }),
    buildWallpapersMetadata(),
  ]) {
    assert.ok(!String(m.title).includes('Кривому'), `geo leaked into title: ${m.title}`);
  }
});

test('SEO-DESC: truncateMetaDescription collapses whitespace, cuts on words, honors the cap', () => {
  assert.equal(truncateMetaDescription('  Опис   з   переносами\n\nрядків. '), 'Опис з переносами рядків.');
  // 160-char window ends mid-word → the cut steps back to the last space.
  const words = 'слово '.repeat(60); // 360 chars, spaces at 5,11,...
  const cut = truncateMetaDescription(words);
  assert.ok(cut.length <= 160, `cap violated: ${cut.length}`);
  assert.ok(cut.endsWith('слово'), 'cut must land after a whole word');
  assert.equal(words.startsWith(cut + ' '), true, 'prefix of the source text');
  // Single word longer than the cap: hard slice, cap still honored.
  const long = 'ж'.repeat(300);
  assert.equal(truncateMetaDescription(long), 'ж'.repeat(160));
  assert.equal(truncateMetaDescription('короткий опис'), 'короткий опис');
});

// ---- twitter card + metadata-chain wiring (source pins) ----

test('SEO-TWITTER: root layout declares twitter:card (title/description/image inherit from og)', () => {
  const layout = readFileSync('app/layout.tsx', 'utf8');
  assert.match(layout, /twitter:\s*{\s*card:\s*'summary_large_image'/);
});

test('SEO-DESC: catalogViewMetadata feeds the admin description through the SAME cache()d read', () => {
  const view = readFileSync('app/catalog/CatalogView.tsx', 'utf8');
  // The read joins the existing parallel batch in the metadata function…
  // 2026-09-16 (owner SEO-audit P1): the gate gained the !brandSlug guard —
  // a combo view must NOT read the per-axis category copy (its meta is
  // template-only, see the SEO-COMBO tests).
  assert.match(
    view,
    /category && filters\.categorySlug && !filters\.brandSlug && filters\.page === 1\s*\?\s*fetchCategoryDescription\(filters\.categorySlug\)/,
    'metadata must read the description behind the page-1, non-combo gate'
  );
  // …and reaches the builder as a parameter (no duplicate DB read — the
  // page body reuses the React-cache()d call). R8: brandDescription rides
  // the same parameter pass.
  assert.match(view, /categoryDescription,\s*brandDescription,\s*\}\),/);
  // The chain shape (override wraps the builder) is pinned by
  // tests/catalog-category-paths.test.ts and stays intact.
  assert.match(view, /applyCategorySeoMetadata\(\s*buildCatalogViewMetadata\(/);
});

test('SEO-R8: catalogViewMetadata feeds the brand description the same way (audit R8 2026-09-15)', () => {
  const view = readFileSync('app/catalog/CatalogView.tsx', 'utf8');
  // 2026-09-16: mirrored !categorySlug guard — a combo reads neither copy.
  assert.match(
    view,
    /brand && filters\.brandSlug && !filters\.categorySlug && filters\.page === 1\s*\?\s*fetchBrandDescription\(filters\.brandSlug\)/,
    'metadata must read the brand description behind the page-1, non-combo gate'
  );
  assert.match(view, /brandDescription,\s*\}\),/, 'builder must receive brandDescription');
});

test('SEO-COMBO: catalogViewMetadata fetches the joint count and gates per-axis overrides', () => {
  const view = readFileSync('app/catalog/CatalogView.tsx', 'utf8');
  // Joint eligible-count fetch (same null degradation as the axis counts —
  // a read failure can never noindex a full page).
  assert.match(view, /fetchCategoryBrandProductCount\(/);
  // The fact reaches the decision input: false = jointly-empty → noindex.
  assert.match(view, /comboHasProducts:\s*comboCount === 0 \? false : undefined/);
  // The pinned category title/H1 override (category-seo.ts) must NOT fire
  // on a combo view: the slug is passed only when NO brand is requested.
  assert.match(view, /filters\.brandSlug \? undefined : filters\.categorySlug/);
  // The visible pinned intro block is gated the same way.
  assert.match(
    view,
    /!filters\.search && filters\.categorySlug && !filters\.brandSlug/,
    'pinned category copy must not swallow the combo H1/title'
  );
  // Visible per-axis admin copy blocks: neither renders on a combo.
  assert.match(
    view,
    /Boolean\(filters\.categorySlug\) && !filters\.brandSlug && page === 1/
  );
  assert.match(
    view,
    /Boolean\(filters\.brandSlug\) && !filters\.categorySlug && page === 1/
  );
  // Combo H1 «Категорія Бренд» in the shared heading helper.
  assert.match(
    view,
    /`\$\{names\.categoryName\} \$\{names\.brandName\}`/,
    'combo H1 template missing in catalogHeading'
  );
});

test('SEO-R8: brand-description reader mirrors the category reader contract', () => {
  const src = readFileSync('app/lib/brand-description.ts', 'utf8');
  assert.match(src, /from\('brands'\)/);
  assert.match(src, /\.eq\('is_active', true\)/);
  assert.match(src, /splitDescriptionParagraphs/, 'rendering contract is shared');
  assert.match(src, /cachePublicRead/, 'same Data Cache posture as category copy');
});

test('SEO: home metadata is unique vs root layout title (static source check)', () => {
  const home = readFileSync('app/(home)/page.tsx', 'utf8');
  assert.match(home, /export const metadata[\s\S]*?title:/);
  const layout = readFileSync('app/layout.tsx', 'utf8');
  const homeTitle = home.match(/title:\s*[`'"]([^`'"]+)/)?.[1] ?? '';
  const layoutTitle = layout.match(/title:\s*[`'"]([^`'"]+)/)?.[1] ?? '';
  assert.ok(homeTitle.length > 0);
  assert.notEqual(homeTitle, layoutTitle);
});

test('SEO-R6: home title leads with the brand + assortment, desc carries the stock fact', () => {
  const home = readFileSync('app/(home)/page.tsx', 'utf8');
  // The old title duplicated the brand twice and the desc said nothing
  // quotable; the new copy names the three real assortment pillars.
  assert.match(home, /title:\s*'Товари для дому — побутова техніка, посуд, шпалери'/);
  assert.match(home, /понад 5 000 товарів/);
  assert.match(home, /самовивіз у Кривому Розі/);
  assert.ok(!home.includes('Інтернет-магазин товарів для дому | Товари для дому'));
});

test('SEO-R9: home links every active top-level category, not a hardcoded 5-item slice', () => {
  const home = readFileSync('app/(home)/page.tsx', 'utf8');
  assert.ok(!home.includes('.slice(0, 5)'), 'the 5-item slice is gone');
  assert.match(home, /categories\.map\(\(category, idx\)/);
  // Odd counts leave an orphan card on the 2-col mobile grid — the last
  // card spans the full row (same affordance the old slice-5 hack served).
  assert.match(home, /categories\.length % 2 === 1/);
});
