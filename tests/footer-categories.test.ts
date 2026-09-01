/**
 * Footer category-link selection (Task #28 internal linking, 2026-09): the
 * crawlable SSR anchors are the merchandising categories plus every OTHER
 * top-level category (the hub pages), hard-capped. Pure module — loads
 * without Supabase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MERCH_CATEGORIES,
  MAX_FOOTER_CATEGORY_LINKS,
  selectFooterCategories,
  footerCategoryLabel,
} from '../app/lib/merch-categories.ts';

function cat(
  id: string,
  parentId: string | null | undefined,
  name = id
): { id: string; name: string; slug: string; parent_id?: string | null } {
  return { id, name, slug: id, parent_id: parentId };
}

const TDD = MERCH_CATEGORIES.find((m) => m.slug === 'hospodarchi-tovary-1451')!;

test('FOOTER-CAT: merchandising anchors come first with merch labels', () => {
  const all = [
    cat('leaf-1', 'top-1'),
    cat('top-1', null, 'Кухонний посуд'),
    cat('tdd', null, 'Господарчі товари'), // slug matches MERCH below
  ].map((c) => ({ ...c, slug: c.slug === 'tdd' ? TDD.slug : c.slug }));

  const picked = selectFooterCategories(all);
  assert.equal(picked[0].slug, TDD.slug, 'merch anchor must lead the list');
  assert.equal(footerCategoryLabel(picked[0]), TDD.label, 'merch label wins over the DB name');
  assert.equal(picked.length, 2, 'merch slug must not repeat in the top-level list');
});

test('FOOTER-CAT: every other top-level category is linked; mid/leaf levels are not', () => {
  const all = [
    cat('top-a', null),
    cat('top-b', null),
    cat('mid', 'top-a'),
    cat('leaf', 'mid'),
    cat('top-c', null),
  ];
  const picked = selectFooterCategories(all);
  assert.deepEqual(
    picked.map((c) => c.id).sort(),
    ['top-a', 'top-b', 'top-c'],
    'only top-level rows make the footer'
  );
});

test('FOOTER-CAT: parent_id unknown (undefined) is NOT treated as top-level', () => {
  const all = [cat('legacy-a', undefined), cat('legacy-b', undefined)];
  assert.deepEqual(selectFooterCategories(all), []);
});

test('FOOTER-CAT: missing/inactive merch categories are skipped, never linked blind', () => {
  const all = [cat('top-1', null), cat('top-2', null)];
  const picked = selectFooterCategories(all);
  assert.equal(picked.length, 2, 'no phantom anchors');
  for (const m of MERCH_CATEGORIES) {
    assert.ok(!picked.some((c) => c.slug === m.slug), 'unresolved merch slug must be absent');
  }
});

test('FOOTER-CAT: list is hard-capped and the cap is sane for hub linking', () => {
  const many = Array.from({ length: 50 }, (_, i) => cat(`top-${i}`, null));
  const picked = selectFooterCategories(many);
  assert.equal(picked.length, MAX_FOOTER_CATEGORY_LINKS);
  assert.ok(MAX_FOOTER_CATEGORY_LINKS >= 12, 'cap must fit the real top-level hub count');
});

test('FOOTER-CAT: DB name is kept for non-merch categories', () => {
  assert.equal(
    footerCategoryLabel({ slug: 'kukhonnyi-posud-155', name: 'Кухонний посуд' }),
    'Кухонний посуд'
  );
});
