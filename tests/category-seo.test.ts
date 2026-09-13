/**
 * Category-level SEO package (2026-08): a crawlable merchandising intent
 * anchor in the SSR footer, direct-children links on the category page, a
 * unique Ukrainian intro for the pinned category, metadata override and a
 * catalog BreadcrumbList. The pin originally pointed at «Господарчі товари»
 * (removed by the owner 2026-09-12) and now points at the live category
 * mala-kukhonna-tekhnika-69. JSX is not executable in node:test (established
 * pattern), so component invariants are pinned at source level.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  TDD_CATEGORY_SLUG,
  getCategorySeo,
  applyCategorySeoMetadata,
  listDirectChildren,
  isPureCategoryView,
  filterNonEmptyChildren,
  SUBCATEGORIES_HEADING,
} from '../app/lib/category-seo.ts';
import { compareCategories } from '../app/lib/category-tree.ts';
import type { Category } from '../app/lib/catalog.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- metadata / content override

test('SEO-CAT: target category resolves the intent override', () => {
  const seo = getCategorySeo(TDD_CATEGORY_SLUG);
  assert.ok(seo, 'override missing for the pinned slug');
  assert.equal(seo.h1, 'Дрібна побутова техніка');
  assert.ok(
    seo.title.startsWith('Дрібна побутова техніка'),
    'title must lead with the intent keyword'
  );
  // Audit 2026-09-13: the «купити» tail is gone (title pinned exactly by
  // the dedicated test below) — the intent keyword lead is the invariant.
  assert.ok(seo.title.length <= 80, `title too long: ${seo.title.length}`);
  assert.ok(seo.description.includes('Дрібна побутова техніка'));
  assert.ok(seo.description.length >= 70, 'description too thin');
  assert.ok(seo.intro.length >= 1, 'unique intro copy missing');
  assert.ok(seo.intro.every((p) => p.length >= 80), 'intro paragraphs must carry real content');
});

test('SEO-CAT: pinned title keeps the brand-only tail (audit 2026-09-13, ≤55-char SERP window)', () => {
  const seo = getCategorySeo(TDD_CATEGORY_SLUG)!;
  // The previous «— купити в інтернет-магазині Товари для дому» tail pushed
  // the title to 69 chars; the brand-only tail fits the ~55-char window.
  assert.equal(seo.title, 'Дрібна побутова техніка — Товари для дому');
  assert.ok(seo.title.length <= 55, `title too long for the SERP window: ${seo.title.length}`);
});

test('SEO-CAT: other slugs get no override (existing metadata behavior)', () => {
  assert.equal(getCategorySeo('blendery-1402'), null);
  assert.equal(getCategorySeo(undefined), null);
  // The removed «Господарчі товари» slug (owner deleted the category
  // 2026-09-12) and any prefix-lookalike of the pinned slug stay unoverridden.
  assert.equal(getCategorySeo('hospodarchi-tovary-1451'), null);
  assert.equal(getCategorySeo('mala-kukhonna-tekhnika-69-lookalike'), null);
});

test('SEO-CAT: applyCategorySeoMetadata overrides only title/description', () => {
  const base = {
    title: 'Дрібна побутова техніка — купити в Товари для дому',
    description: 'Техніка у категорії «Дрібна побутова техніка» — купити в інтернет-магазині Товари для дому.',
    alternates: { canonical: `/catalog/${TDD_CATEGORY_SLUG}` },
  };
  const merged = applyCategorySeoMetadata(base, TDD_CATEGORY_SLUG);
  assert.equal(merged.title, getCategorySeo(TDD_CATEGORY_SLUG)!.title);
  assert.equal(merged.description, getCategorySeo(TDD_CATEGORY_SLUG)!.description);
  assert.deepEqual(merged.alternates, base.alternates, 'canonical must be untouched');

  const untouched = applyCategorySeoMetadata(base, 'other-slug');
  assert.equal(untouched.title, base.title);
  assert.equal(untouched.description, base.description);
});

test('SEO-CAT: applyCategorySeoMetadata reaches og:title/og:description when og is present', () => {
  // The view-level og object REPLACES the layout default (shallow merge) —
  // if the override skipped it, the messenger card would keep the generic
  // copy while the SERP shows the pinned intent copy.
  const base = {
    title: 'Дрібна побутова техніка — купити в Товари для дому',
    description: 'шаблонний опис',
    openGraph: {
      title: 'Дрібна побутова техніка — купити в Товари для дому',
      description: 'шаблонний опис',
      locale: 'uk_UA',
      type: 'website',
      siteName: 'Товари для дому',
      images: ['/og-image.png'],
    },
  };
  const merged = applyCategorySeoMetadata(base, TDD_CATEGORY_SLUG);
  const seo = getCategorySeo(TDD_CATEGORY_SLUG)!;
  assert.equal(merged.openGraph!.title, seo.title, 'og:title must follow the override');
  assert.equal(merged.openGraph!.description, seo.description, 'og:description must follow the override');
  // Non-copy og fields survive the merge untouched.
  assert.equal(merged.openGraph!.locale, 'uk_UA');
  assert.deepEqual(merged.openGraph!.images, ['/og-image.png']);

  // Views without og stay og-less (nothing invented).
  const bare = { title: 'x', description: 'y', openGraph: undefined };
  assert.equal(applyCategorySeoMetadata(bare, TDD_CATEGORY_SLUG).openGraph, undefined);
});

// ---- direct children (pure tree slice)

function cat(id: string, parentId: string | null, sortOrder = 0, name = id): Category {
  return {
    id,
    parent_id: parentId,
    name,
    slug: id,
    sort_order: sortOrder,
    is_active: true,
    created_at: '',
    updated_at: '',
  };
}

test('SEO-CAT: listDirectChildren returns only direct children, commercially sorted', () => {
  const categories = [
    cat('root', null),
    cat('child-b', 'root', 2),
    cat('child-a', 'root', 1),
    cat('grandchild', 'child-a', 0),
    cat('other-tree', 'another-root', 0),
  ];
  const kids = listDirectChildren(categories, 'root');
  assert.deepEqual(
    kids.map((c) => c.id),
    ['child-a', 'child-b'],
    'grandchildren and foreign branches must be excluded; sort_order wins'
  );
});

test('SEO-CAT: listDirectChildren falls back to ukrainian name ordering (compareCategories)', () => {
  const categories = [cat('x', 'root', 5, 'Яблуко'), cat('y', 'root', 5, 'Абриc')];
  const kids = listDirectChildren(categories, 'root');
  assert.deepEqual(kids.map((c) => c.id), ['y', 'x']);
  const y = categories[1];
  const x = categories[0];
  assert.ok(y !== undefined && x !== undefined, 'fixture categories must exist');
  assert.ok(compareCategories(y, x) < 0);
});

test('SEO-CAT: leaf category has no children', () => {
  assert.deepEqual(listDirectChildren([cat('leaf', null)], 'leaf'), []);
});

// ---- crawlable SSR anchor in the footer (source invariants)

test('SEO-CAT: footer renders a crawlable merchandising anchor to a category', () => {
  const footer = src('app/components/SiteFooter.tsx');
  // The crawlable anchors come from merch-categories.ts (Task #28): the
  // merchandising slugs are its single source. The former «Господарчі
  // товари» anchor was removed 2026-09-12 (category deleted by the owner).
  assert.match(
    footer,
    /merch-categories/,
    'footer category links must come from merch-categories.ts'
  );
  assert.match(
    footer,
    /selectFooterCategories\(/,
    'footer must render the selected hub categories'
  );
  assert.match(footer, /footerCategoryLabel/, 'anchor text must come from the merch label map');
  // inside a real <Link> (SSR anchor), not a button or the drawer.
  // Path form (owner task 2026-09-13); the query form 308-redirects to it.
  assert.match(
    footer,
    /<Link[^>]*catalog\/\$\{encodeURIComponent\(category\.slug\)\}[\s\S]{0,200}>[\s\S]{0,120}\{footerCategoryLabel\(category\)\}/
  );
});

test('SEO-CAT: catalog page renders subcategory links and unique intro for the pinned category', () => {
  const page = src('app/catalog/CatalogView.tsx');
  assert.match(page, /listDirectChildren\(/, 'direct children must be rendered as links');
  assert.match(page, /getCategorySeo\(/, 'intro copy must come from the SEO map');
  assert.match(page, /buildCatalogBreadcrumbJsonLd\(/, 'catalog breadcrumb JSON-LD missing');
});

test('SEO-CAT: catalog page keeps exactly one h1 literal (h1 invariant preserved)', () => {
  const page = src('app/catalog/CatalogView.tsx');
  assert.equal((page.match(/<h1/g) ?? []).length, 1);
});

// ---- crawlable path to mid/leaf categories (storefront audit 2026-09, P1)

test('SEO-CAT: isPureCategoryView mirrors the indexable category-view contract (lib/seo.ts)', () => {
  const pure = { categorySlug: 'velyka-pobutova-tekhnika-739', sort: 'newest', page: 1 };
  assert.equal(isPureCategoryView(pure), true, 'single category, page 1, default sort');
  assert.equal(isPureCategoryView({ ...pure, search: 'посуд' }), false, 'search view is noindex');
  assert.equal(isPureCategoryView({ ...pure, brandSlug: 'b' }), false, 'category+brand is multiFilter');
  assert.equal(isPureCategoryView({ ...pure, minPrice: 10 }), false, 'price filter is noindex');
  assert.equal(isPureCategoryView({ ...pure, maxPrice: 100 }), false, 'price filter is noindex');
  assert.equal(isPureCategoryView({ ...pure, inStockOnly: true }), false, 'stock filter is noindex');
  assert.equal(isPureCategoryView({ ...pure, sort: 'price_asc' }), false, 'non-default sort is noindex');
  assert.equal(isPureCategoryView({ ...pure, page: 2 }), false, 'pagination depth is noindex');
  assert.equal(
    isPureCategoryView({ sort: 'newest', page: 1 }),
    false,
    'bare /catalog is not a category view'
  );
});

test('SEO-CAT: SUBCATEGORIES_HEADING matches the pinned intro heading text', () => {
  // The generic block must visually equal the pinned block («та же разметка»).
  assert.equal(getCategorySeo(TDD_CATEGORY_SLUG)!.introHeading, SUBCATEGORIES_HEADING);
});

test('SEO-CAT: filterNonEmptyChildren keeps ≥1-eligible children, drops empty, degrades errors to non-empty', async () => {
  const kids = [cat('with', 'p'), cat('empty', 'p'), cat('errored', 'p')];
  const counts = new Map<string, number | null>([['with', 3], ['empty', 0]]);
  const kept = await filterNonEmptyChildren(kids, (slug) =>
    Promise.resolve(counts.get(slug) ?? null)
  );
  assert.deepEqual(
    kept.map((c) => c.id),
    ['with', 'errored'],
    'count 0 (noindex view) is unlinked; a failed count degrades to non-empty (same direction as generateMetadata)'
  );
});

test('SEO-CAT: filterNonEmptyChildren short-circuits on leaf views — zero count reads', async () => {
  let queried = 0;
  const kept = await filterNonEmptyChildren([], () => {
    queried += 1;
    return Promise.resolve(1);
  });
  assert.deepEqual(kept, []);
  assert.equal(queried, 0, 'leaf/filtered views must not fire count queries');
});

test('SEO-CAT: catalog page wires the subcategory block to pure views + non-empty children', () => {
  const page = src('app/catalog/CatalogView.tsx');
  assert.match(
    page,
    /isPureCategoryView\(filters\)/,
    'block must render only on pure, indexable category views'
  );
  assert.match(
    page,
    /listDirectChildren\(categories, activeCategory\.id\)/,
    'children must be sliced from the already-fetched active list'
  );
  assert.match(
    page,
    /filterNonEmptyChildren\(/,
    'children must be filtered to non-empty views (noindex pages are never linked)'
  );
  assert.match(
    page,
    /fetchCategoryProductCount\(slug\)\.catch\(\(\) => null\)/,
    'counts must reuse the grid eligibility shapes and degrade on read errors'
  );
  assert.match(
    page,
    /childCategories\.length > 0/,
    'the chip list must render only when non-empty children exist'
  );
  assert.match(
    page,
    /href=\{`\/catalog\/\$\{encodeURIComponent\(child\.slug\)\}`\}/,
    'children must be server-rendered <a> anchors on the path form (next/link)'
  );
});

test('SEO-CAT: SiteFooter comment states the real mid/leaf linking mechanism', () => {
  const footer = src('app/components/SiteFooter.tsx');
  assert.match(
    footer,
    /category-seo\.ts \+\s*\n \* app\/catalog\/CatalogView\.tsx/,
    'the comment must point to the module that renders the child links'
  );
  assert.ok(
    !footer.includes('Mid/leaf levels stay linked via parent hubs and'),
    'the outdated «parent hubs only» claim must be gone'
  );
});
