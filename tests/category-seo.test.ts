/**
 * Category-level SEO package (2026-08): crawlable intent anchor «Товари для
 * дому» in the SSR footer, direct-children links on the category page, a
 * unique Ukrainian intro for the pinned category, metadata override and a
 * catalog BreadcrumbList. JSX is not executable in node:test (established
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
} from '../app/lib/category-seo.ts';
import { compareCategories } from '../app/lib/category-tree.ts';
import type { Category } from '../app/lib/catalog.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- metadata / content override

test('SEO-CAT: target category resolves the intent override', () => {
  const seo = getCategorySeo(TDD_CATEGORY_SLUG);
  assert.ok(seo, 'override missing for the pinned slug');
  assert.equal(seo.h1, 'Товари для дому');
  assert.ok(seo.title.startsWith('Товари для дому'), 'title must lead with the intent keyword');
  assert.ok(seo.title.includes('купити'), 'commercial intent in title');
  assert.ok(seo.title.length <= 80, `title too long: ${seo.title.length}`);
  assert.ok(seo.description.includes('Товари для дому'));
  assert.ok(seo.description.length >= 70, 'description too thin');
  assert.ok(seo.intro.length >= 1, 'unique intro copy missing');
  assert.ok(seo.intro.every((p) => p.length >= 80), 'intro paragraphs must carry real content');
});

test('SEO-CAT: other slugs get no override (existing metadata behavior)', () => {
  assert.equal(getCategorySeo('blendery-1402'), null);
  assert.equal(getCategorySeo(undefined), null);
  assert.equal(getCategorySeo('hospodarchi-tovary-1451-lookalike'), null);
});

test('SEO-CAT: applyCategorySeoMetadata overrides only title/description', () => {
  const base = {
    title: 'Господарчі товари — купити в Товари для дому',
    description: 'Товари у категорії «Господарчі товари» — купити в інтернет-магазині Товари для дому.',
    alternates: { canonical: `/catalog?category=${TDD_CATEGORY_SLUG}` },
  };
  const merged = applyCategorySeoMetadata(base, TDD_CATEGORY_SLUG);
  assert.equal(merged.title, getCategorySeo(TDD_CATEGORY_SLUG)!.title);
  assert.equal(merged.description, getCategorySeo(TDD_CATEGORY_SLUG)!.description);
  assert.deepEqual(merged.alternates, base.alternates, 'canonical must be untouched');

  const untouched = applyCategorySeoMetadata(base, 'other-slug');
  assert.equal(untouched.title, base.title);
  assert.equal(untouched.description, base.description);
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
  assert.ok(compareCategories(categories[1], categories[0]) < 0);
});

test('SEO-CAT: leaf category has no children', () => {
  assert.deepEqual(listDirectChildren([cat('leaf', null)], 'leaf'), []);
});

// ---- crawlable SSR anchor in the footer (source invariants)

test('SEO-CAT: footer renders a crawlable «Товари для дому» anchor to the category', () => {
  const footer = src('app/components/SiteFooter.tsx');
  assert.match(
    footer,
    /href=\{?['"`]\/catalog\?category=hospodarchi-tovary-1451['"`]\}?|TDD_CATEGORY_SLUG/,
    'footer must link the pinned category URL'
  );
  assert.match(footer, /Товари для дому/, 'anchor text must be the intent keyword');
  // inside a real <Link> (SSR anchor), not a button or the drawer
  assert.match(footer, /<Link[^>]*[\s\S]{0,200}>[\s\S]{0,80}Товари для дому/);
});

test('SEO-CAT: catalog page renders subcategory links and unique intro for the pinned category', () => {
  const page = src('app/catalog/page.tsx');
  assert.match(page, /listDirectChildren\(/, 'direct children must be rendered as links');
  assert.match(page, /getCategorySeo\(/, 'intro copy must come from the SEO map');
  assert.match(page, /buildCatalogBreadcrumbJsonLd\(/, 'catalog breadcrumb JSON-LD missing');
});

test('SEO-CAT: catalog page keeps exactly one h1 literal (h1 invariant preserved)', () => {
  const page = src('app/catalog/page.tsx');
  assert.equal((page.match(/<h1/g) ?? []).length, 1);
});
