/**
 * Numbered catalog pagination (Audit 2026-09-05 low UX batch, item 5).
 *
 * buildPageWindow is pure and unit-tested directly; the page.tsx wiring
 * is pinned as source invariants (JSX is not executable in node:test —
 * established pattern). The P3-R2 contract (two aria-disabled spans,
 * prev/next via catalogPageUrl) must survive the numbered bar.
 *
 * Owner P1 fix 2026-09-18 (dead/rage clicks on /catalog/shpaleri-flizeli?page=3,
 * Clarity-confirmed): the interactive part moved into the shared client
 * component app/components/PaginationNav.tsx. Navigation mode — DOCUMENT
 * navigation (window.location.assign, owner revision of the same day):
 * soft navigation loses to the segment-cache race that already broke
 * sorting (isSortDocumentNavigation precedent 2026-09-15), while the
 * pre-unload pending dimming (grid anchor + clicked control) keeps the
 * click feedback instant. This file pins BOTH the server-side href/item
 * builders (still per storefront) and the client contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPageWindow } from '../app/lib/pagination.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageSrc = () =>
  readFileSync(path.join(root, 'app/catalog/CatalogView.tsx'), 'utf8');
const navSrc = () =>
  readFileSync(path.join(root, 'app/components/PaginationNav.tsx'), 'utf8');

// ---- pure window builder ----

test('PAGES: window is current ±2 plus first/last with ellipsis gaps', () => {
  assert.deepEqual(buildPageWindow(1, 12), [1, 2, 3, 'ellipsis', 12]);
  assert.deepEqual(buildPageWindow(6, 12), [
    1, 'ellipsis', 4, 5, 6, 7, 8, 'ellipsis', 12,
  ]);
  assert.deepEqual(buildPageWindow(11, 12), [1, 'ellipsis', 9, 10, 11, 12]);
});

test('PAGES: small catalogs collapse to a plain run without ellipsis', () => {
  assert.deepEqual(buildPageWindow(1, 2), [1, 2]);
  assert.deepEqual(buildPageWindow(2, 4), [1, 2, 3, 4]);
  assert.deepEqual(buildPageWindow(3, 5), [1, 2, 3, 4, 5]);
});

test('PAGES: a single skipped page is shown instead of an ellipsis', () => {
  assert.deepEqual(buildPageWindow(5, 10), [1, 2, 3, 4, 5, 6, 7, 'ellipsis', 10]);
  assert.deepEqual(buildPageWindow(4, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('PAGES: edges stay anchored when the window touches them', () => {
  assert.deepEqual(buildPageWindow(2, 10), [1, 2, 3, 4, 'ellipsis', 10]);
  assert.deepEqual(buildPageWindow(9, 10), [1, 'ellipsis', 7, 8, 9, 10]);
});

test('PAGES: the window never exceeds 9 items (single row on desktop)', () => {
  for (let page = 1; page <= 20; page++) {
    for (const maxPage of [10, 20, 50, 100]) {
      const p = Math.min(page, maxPage);
      assert.ok(
        buildPageWindow(p, maxPage).length <= 9,
        `page=${p} maxPage=${maxPage} exceeded 9 items`
      );
    }
  }
});

// ---- CatalogView wiring (source invariants; since 2026-09-13 the
// renderer is shared by /catalog and /catalog/<slug>; since 2026-09-18 the
// interactive nav is the shared PaginationNav client component) ----

test('PAGES: CatalogView builds page items via buildPageWindow + catalogPageUrl', () => {
  const src = pageSrc();
  assert.match(src, /import \{ buildPageWindow \} from '@\/app\/lib\/pagination'/);
  assert.match(src, /buildPageWindow\(page, maxPage\)/);
  assert.match(src, /catalogPageUrl\(linkParams, item, linkBase\)/,
    'number links must reuse the shared page-URL builder');
});

test('PAGES: CatalogView mounts PaginationNav with the grid anchor and shared geometry', () => {
  const src = pageSrc();
  assert.match(src, /<PaginationNav/);
  assert.match(src, /anchorId="catalog-products"/,
    'the nav must know the grid anchor for pending dimming + scroll');
  assert.match(src, /controlClassName=\{paginationControlClass\}/,
    'catalog button geometry stays pinned in the storefront');
  // prev/next URL logic stays in the storefront (P3-R2, p3-ux pin).
  assert.match(src, /catalogPageUrl\(linkParams, page - 1, linkBase\)/);
  assert.match(src, /catalogPageUrl\(linkParams, page \+ 1, linkBase\)/);
  // Status label stays server-rendered («Сторінка X із Y» — ux-fixes pin).
  assert.match(src, /Сторінка \{page\} із \{maxPage\}/);
});

// ---- PaginationNav client contract (owner P1 spec 2026-09-18) ----

test('PAGES: PaginationNav navigates by document — window.location.assign, no soft-nav machinery', () => {
  const src = navSrc();
  assert.match(src, /'use client'/);
  // Owner revision 2026-09-18 (isSortDocumentNavigation precedent
  // 2026-09-15): a document navigation always reaches the server — proxy
  // rewrites to the force-dynamic twin — so the segment-cache reuse of
  // static ISR prefetches across ?page values can never serve stale data.
  assert.match(src, /window\.location\.assign\(href\)/);
  assert.doesNotMatch(src, /router\.push|startTransition|useTransition|useRouter/,
    'soft-nav machinery must be gone with document navigation');
  // Links keep prefetch disabled: a document navigation never uses the RSC
  // payload, and each paginated prefetch would be a real twin render.
  assert.match(src, /prefetch=\{false\}/);
  // Modified/native clicks stay native (new tab must keep working).
  assert.match(src, /event\.button !== 0[\s\S]{0,80}event\.metaKey[\s\S]{0,40}event\.ctrlKey[\s\S]{0,40}event\.shiftKey[\s\S]{0,40}event\.altKey/);
});

test('PAGES: PaginationNav dims the grid and the clicked control before unload', () => {
  const src = navSrc();
  // Pending indication on the server-rendered grid container.
  assert.match(src, /opacity-60/);
  assert.match(src, /pointer-events-none/);
  assert.match(src, /getElementById\(anchorId\)/);
  assert.match(src, /classList\.add\(\.\.\.GRID_PENDING_CLASSES\)/);
  // State first, then document navigation: React flushes the update and
  // the dimming effect before the async navigation tears the page down.
  assert.match(src, /setPendingHref\(href\);\s*window\.location\.assign\(href\)/);
  // The post-render scroll machinery is gone with document navigation.
  assert.doesNotMatch(src, /scrollIntoView/);
});

test('PAGES: P3-R2 contract survives in PaginationNav — two aria-disabled spans, dead-looking disabled sides', () => {
  const src = navSrc();
  const spans = src.match(/<span\s+aria-disabled="true"/g) ?? [];
  assert.equal(spans.length, 2, 'prev+next inactive sides pinned');
  // Owner 2026-09-18: disabled controls must LOOK dead (mobile UX), while
  // aria-disabled stays for assistive tech.
  assert.match(
    src,
    /aria-disabled="true"\s+className=\{\`\$\{controlClassName\} opacity-30 pointer-events-none\`\}/
  );
  // The current page is aria-current, never a link; ellipsis is aria-hidden.
  assert.match(src, /aria-current="page"/);
  assert.match(src, /aria-hidden="true"/);
});
