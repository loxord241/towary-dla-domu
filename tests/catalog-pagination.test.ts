/**
 * Numbered catalog pagination (Audit 2026-09-05 low UX batch, item 5).
 *
 * buildPageWindow is pure and unit-tested directly; the page.tsx wiring
 * is pinned as source invariants (JSX is not executable in node:test —
 * established pattern). The P3-R2 contract (two aria-disabled spans,
 * prev/next via catalogPageUrl) must survive the numbered bar.
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
// renderer is shared by /catalog and /catalog/<slug>) ----

test('PAGES: CatalogView renders numbers via buildPageWindow + catalogPageUrl', () => {
  const src = pageSrc();
  assert.match(src, /import \{ buildPageWindow \} from '@\/app\/lib\/pagination'/);
  assert.match(src, /buildPageWindow\(page, maxPage\)/);
  assert.match(src, /catalogPageUrl\(linkParams, item, linkBase\)/,
    'number links must reuse the shared page-URL builder');
});

test('PAGES: current page is aria-current, ellipsis is aria-hidden', () => {
  const src = pageSrc();
  assert.match(src, /aria-current="page"/);
  assert.match(src, /key=\{`gap-\$\{idx\}`\}[\s\S]{0,200}aria-hidden="true"/,
    'ellipsis gaps must be hidden from assistive tech');
});

test('PAGES: P3-R2 contract survives — two aria-disabled spans, prev/next intact', () => {
  const src = pageSrc();
  const spans = src.match(/<span aria-disabled="true"/g) ?? [];
  assert.equal(spans.length, 2, 'prev+next inactive sides pinned');
  assert.match(src, /catalogPageUrl\(linkParams, page - 1, linkBase\)/);
  assert.match(src, /catalogPageUrl\(linkParams, page \+ 1, linkBase\)/);
});
