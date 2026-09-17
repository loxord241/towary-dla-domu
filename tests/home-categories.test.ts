/**
 * Home «Категорії» section — at most 5 top-level hub cards (owner decision
 * 2026-09-17).
 *
 * Regression context: SEO-package item R9 (commit 7155342, 2026-09-15)
 * removed the old slice(0, 5) but never added a top-level filter, so the
 * section rendered ALL active categories of EVERY tree level (~175 cards,
 * confirmed by curl on live HTML) while its comment claimed "every active
 * TOP-LEVEL category renders". Owner decision 2026-09-17: the section
 * shows at most 5 cards — the first 5 top-level hubs (parent_id === null)
 * in the admin-managed sort_order (fetchActiveCategories orders by
 * sort_order → id; the owner reorders hubs via admin/categories/[id]/order,
 * so no separate hand-picked list is needed). Reachability of every hub is
 * preserved: SiteFooter links the same top-level hubs on every page,
 * /catalog carries the full tree, the sitemap lists it.
 *
 * Pinned here (source pins on app/(home)/page.tsx):
 *  - the section maps a featured array = top-level filter + slice(0, 5);
 *  - SiteFooter still receives the FULL categories list (never the sliced
 *    one — footer hub anchors are the crawlable path);
 *  - the «Усі категорії →» link stays;
 *  - the orphan col-span logic counts the featured array, not the full list;
 *  - no bare categories.map( anywhere in the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(path.join(root, 'app/(home)/page.tsx'), 'utf8');

test('HOME-CAT: featured array = top-level filter (parent_id === null) THEN slice(0, 5)', () => {
  // Order matters: slice must apply to the FILTERED array (top-level only),
  // never directly to the full list.
  assert.match(
    page,
    /featuredCategories = categories\s*\n\s*\.filter\(\(category\) => category\.parent_id === null\)\s*\n\s*\.slice\(0, 5\)/,
    'featured must be top-level hubs capped at 5'
  );
  // No slice straight on the raw list (that would reintroduce the mixed-
  // level bug: children sorted before hubs would crowd out top-level rows).
  assert.doesNotMatch(page, /categories\.slice\(/);
});

test('HOME-CAT: SiteFooter receives the FULL categories list, not the featured slice', () => {
  assert.match(
    page,
    /<SiteFooter categories=\{categories\} \/>/,
    'footer must keep every hub anchor'
  );
  assert.doesNotMatch(
    page,
    /categories=\{featuredCategories\}/,
    'footer must never be fed the 5-card slice'
  );
});

test('HOME-CAT: «Усі категорії →» link stays in the section header', () => {
  assert.match(page, /Усі категорії →/);
  assert.match(page, /href="\/catalog"/);
});

test('HOME-CAT: orphan col-span logic counts the featured array', () => {
  assert.match(
    page,
    /idx === featuredCategories\.length - 1 && featuredCategories\.length % 2 === 1/,
    'col-span must look at the rendered (featured) list'
  );
  assert.doesNotMatch(
    page,
    /idx === categories\.length - 1/,
    'stale full-list length in col-span logic'
  );
});

test('HOME-CAT: no bare categories.map( — the full list is never mapped into cards', () => {
  assert.doesNotMatch(
    page,
    /categories\.map\(/,
    'section must map featuredCategories, not the full list (175-card regression)'
  );
  assert.match(page, /featuredCategories\.map\(/);
});
