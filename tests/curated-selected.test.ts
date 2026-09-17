/**
 * «Обрані» vs «Популярні товари» — two INDEPENDENT admin-curated flags.
 *
 * Regression context (2026-08-28): the home page has TWO product sections —
 * «Обрані товари» and «Популярні товари» — but BOTH were driven by the same
 * `is_featured` flag, so flagging a product as «Обрані» in the admin also
 * put it into «Популярні товари». The fix: a second boolean column
 * `products.is_selected` (migration 028) that drives the «Обрані товари»
 * section, while `is_featured` keeps driving «Популярні товари» only.
 *
 * Pinned here:
 *  - migration 028 adds the column + partial index;
 *  - catalog exposes fetchSelectedProducts (is_selected only);
 *  - home renders «Обрані товари» from fetchSelectedProducts and
 *    «Популярні товари» from fetchPopularProducts — no shared source;
 *  - admin API persists is_selected independently of the featured limit;
 *  - admin UI renders two independent checkboxes and two list badges.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/028_product_is_selected.sql';
// 2026-09 refactor: the god-module was split into app/lib/catalog/* — the
// lib pins below read every fragment (original file order).
const LIB = [
  'app/lib/catalog/shared.ts',
  'app/lib/catalog/filters.ts',
  'app/lib/catalog/slug-lookup.ts',
  'app/lib/catalog/product-feed.ts',
  'app/lib/catalog/counts.ts',
  'app/lib/catalog/listing.ts',
  'app/lib/catalog/wallpaper-listing.ts',
  'app/lib/catalog/reviews.ts',
  'app/lib/catalog/shelves.ts',
  'app/lib/catalog/categories.ts',
  'app/lib/catalog/search.ts',
  'app/lib/catalog/product-card.ts',
  'app/lib/catalog/related.ts',
];
const readLib = (): string =>
  LIB.map((rel) => src(rel)).join('\n');
const HOME = 'app/(home)/page.tsx';
const LIST_ROUTE = 'app/api/admin/products/route.ts';
const ITEM_ROUTE = 'app/api/admin/products/[id]/route.ts';
const ADMIN_UI = 'app/admin/(dashboard)/products/page.tsx';

test('MIGRATION 028: adds products.is_selected with a partial active index', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /add column if not exists is_selected boolean/i,
    'is_selected column must be added idempotently'
  );
  assert.match(m, /default false/i);
  assert.match(
    m,
    /create index if not exists idx_products_active_selected/i,
    'partial index mirrors idx_products_active_featured'
  );
  // Featured column/mechanics must not be touched by this migration.
  assert.doesNotMatch(m, /drop column|alter column.*is_featured/i);
});

test('CATALOG: fetchSelectedProducts is a single bounded window (limit 8, no paged loop)', () => {
  const lib = readLib();
  assert.match(lib, /export async function fetchSelectedProducts/);
  const fnStart = lib.indexOf('export async function fetchSelectedProducts');
  // Window 1600→2400 (2026-09-17, linoleum batches): the ln-* exclusion
  // lines + in-stock-first ordering comment grew the function body past
  // 1600 chars BEFORE the closing .range(0, SELECTED_LIMIT - 1) — the
  // bounded-window invariant itself is intact, only the source slice was
  // too short. The .range now sits at offset ~1603 from the marker.
  const fnBody = lib.slice(fnStart, fnStart + 2400);

  // LIMIT = 8, mirrored from the featured shelf business rule.
  assert.match(lib, /export const SELECTED_LIMIT = 8;/);
  assert.match(fnBody, /\.range\(0, SELECTED_LIMIT - 1\)/);

  // Storefront eligibility filters stay: active + selected only.
  assert.match(fnBody, /\.eq\('is_active', true\)/);
  assert.match(fnBody, /\.eq\('is_selected', true\)/);

  // Deterministic order, same priority semantics as the popular shelf.
  assert.match(
    fnBody,
    /\.order\('created_at', \{ ascending: false \}\)[\s\S]*\.order\('id', \{ ascending: false \}\)/
  );

  // NO unbounded paged loop on the selected path: the function body must
  // not delegate to the shared paged fetchProducts and must not loop.
  assert.doesNotMatch(fnBody, /fetchProducts\(/);
  assert.doesNotMatch(fnBody, /for \(;;\)/);
  assert.doesNotMatch(fnBody, /from \+= PAGE/);
});

test('CATALOG: Product type carries both independent flags', () => {
  const lib = readLib();
  assert.match(lib, /is_featured: boolean;/);
  assert.match(lib, /is_selected: boolean;/);
});

test('HOME: «Обрані товари» section is fed by fetchSelectedProducts only', () => {
  const page = src(HOME);
  assert.match(page, /Обрані товари/, 'home section heading');
  assert.match(page, /fetchSelectedProducts\(\)/);
  const featuredCall = page.indexOf('fetchFeaturedProducts()');
  assert.equal(featuredCall, -1, 'home must not pull featured into Обрані');
});

test('HOME: «Популярні товари» section still reads fetchPopularProducts (is_featured)', () => {
  const page = src(HOME);
  assert.match(page, /Популярні товари/);
  // Extended 2026-09: the call passes the shown selected ids as excludeIds —
  // «Обрані» products no longer duplicate into «Популярні».
  assert.match(page, /fetchPopularProducts\(/);
});

test('ADMIN API: POST and PUT persist is_selected independent of featured logic', () => {
  const list = src(LIST_ROUTE);
  const item = src(ITEM_ROUTE);
  // Create path: is_selected lands in the insert payload from the request body.
  assert.match(list, /is_selected: Boolean\(body\.is_selected\)/);
  // Update path: dedicated branch, separate from the featured toggle block.
  assert.match(item, /if \('is_selected' in body\)/);
  assert.match(item, /patch\.is_selected = Boolean\(body\.is_selected\)/);
  // The featured-limit machinery stays untouched in both routes.
  assert.match(item, /decideFeaturedToggle/);
  assert.match(list, /decideFeaturedToggle/);
});

test('ADMIN UI: two independent checkboxes — «Популярні товари» and «Обрані»', () => {
  const ui = src(ADMIN_UI);
  // Featured checkbox is labeled by its home-block name again…
  assert.match(ui, /<span className="ml-2">Популярні товари<\/span>/);
  // …and the new flag has its own checkbox wired to is_selected.
  assert.match(ui, /name="is_selected"/);
  assert.match(ui, /checked=\{formData\.is_selected\}/);
  const selIdx = ui.indexOf('name="is_selected"');
  const featIdx = ui.indexOf('name="is_featured"');
  assert.ok(selIdx > -1 && featIdx > -1 && selIdx !== featIdx);
  // Label «Обрані» must sit next to the is_selected checkbox, not featured.
  const selBlock = ui.slice(selIdx - 400, selIdx + 400);
  assert.match(selBlock, /Обрані/);
  // Edit prefill loads both flags.
  assert.match(ui, /is_selected: Boolean\(p\.is_selected\)/);
});

test('ADMIN UI: list badges reflect each flag separately', () => {
  const ui = src(ADMIN_UI);
  assert.match(ui, /product\.is_featured &&/, 'featured badge still per-row');
  assert.match(ui, /product\.is_selected &&/, 'selected badge is per-row');
});
