/**
 * Static invariants for the 2026-08 UX/UI audit fixes (P2–P8).
 *
 * The storefront pages are server components with JSX, which node:test
 * cannot execute directly (no JSX transform in the test runner — same
 * constraint as tests/product-specifications.test.ts). Following the
 * established pagination-hardening pattern, these tests pin the SOURCE
 * invariants that the audit fixes depend on, so a revert or regression
 * fails loudly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- P2: home featured section has an intentional, non-broken empty state

test('home: featured empty state is a designed promo banner, not a bare EmptyState box', () => {
  const home = src('app/(home)/page.tsx');
  // the empty branch must keep the section useful: explicit copy + catalog CTA
  assert.match(home, /Добірка найкращих товарів/);
  // Superseded 2026-08-28: the section variable is selectedProducts (the
  // block is driven by the independent is_selected flag, migration 028).
  assert.match(home, /selectedProducts\.length === 0/);
  // and the populated branch still renders the product grid
  assert.match(home, /selectedProducts\.map/);
});

// ---- P3: interactive hit targets — superseded 2026-08-28 (P1 mobile audit
// B4): the former >=24px floor was raised to ~44px on the storefront path.

test('FavoriteButton: hit area class guarantees a ~44px target around the icon', () => {
  const fav = src('app/components/FavoriteButton.tsx');
  assert.match(fav, /inline-flex.*items-center.*justify-center/);
  // h-9 w-9 button + the card's p-1 wrapper ≈ 44px total hit area.
  assert.match(fav, /h-9 w-9|h-11 w-11|min-w-11|min-h-11/);
});

test('SiteHeader: search submit button has a ~44px hit area and the input reserves room', () => {
  // 2026-09-11: the input + submit button live in the SearchSuggest island.
  const search = src('app/components/SearchSuggest.tsx');
  assert.match(search, /h-11 w-11/);
  // input must not hide typed text under the absolutely positioned button
  assert.match(search, /pr-1[0-4]/);
});

// ---- P4: no Russian leftovers in the touched storefront UI

test('catalog page: pagination label is Ukrainian and filter chips use display names', () => {
  const catalog = src('app/catalog/CatalogView.tsx');
  assert.ok(!/Страница/.test(catalog), 'Russian «Страница» must not appear');
  assert.ok(!/·\s*найдено/.test(catalog), 'Russian «найдено» must not appear');
  assert.match(catalog, /Сторінка/);
  assert.match(catalog, /знайдено/);
  // chips resolve slug -> display name via the fetched dictionaries
  assert.match(catalog, /categoryName/);
  assert.match(catalog, /brandName/);
});

test('FavoritesBadge: Ukrainian title and aria-label', () => {
  const badge = src('app/components/FavoritesBadge.tsx');
  assert.ok(!badge.includes('Избранное'), 'Russian «Избранное» must not appear');
  assert.match(badge, /Обране/);
  assert.match(badge, /товарів/);
});

// ---- P5: SEO metadata + H1

test('catalog: dynamic H1 exists exactly once and metadata is generated', () => {
  // Since 2026-09-13 the route file keeps generateMetadata and the shared
  // CatalogView component renders the markup.
  const catalog = src('app/catalog/page.tsx');
  const view = src('app/catalog/CatalogView.tsx');
  assert.match(catalog, /generateMetadata/);
  assert.match(view, /<h1/);
  assert.ok(!view.match(/<h2[^>]*>Каталог товарів/), 'heading must be promoted to h1');
});

test('product: generateMetadata provides unique title/description', () => {
  const product = src('app/product/[slug]/page.tsx');
  assert.match(product, /export async function generateMetadata/);
  assert.match(product, /: Promise<Metadata>/);
  assert.match(product, /title: `\$\{product\.name\} — Товари для дому`/);
});

// ---- P6: product page structure

test('product: brand and category are links, page wrapped in <main>', () => {
  const product = src('app/product/[slug]/page.tsx');
  assert.match(product, /<main/);
  assert.match(product, /\/catalog\?brand=/);
  assert.match(product, /\/catalog\?category=/);
});

test('product: above-the-fold gallery image is not lazy (priority/eager)', () => {
  const gallery = src('app/components/ProductGallery.tsx');
  assert.match(gallery, /priority|loading="eager"/);
});

// ---- P7: mobile collapsible filters (2026-08: superseded by the sheet)

test('catalog: mobile filters live behind a toggle; desktop sidebar stays open', () => {
  const catalog = src('app/catalog/CatalogView.tsx');
  const filters = src('app/catalog/CatalogFilters.tsx');
  // the client component owns the open state
  assert.match(filters, /useState/);
  assert.match(filters, /md:hidden/, 'mobile trigger exists');
  assert.match(filters, /md:block/, 'desktop panel always visible');
  // the page no longer auto-expands anything on mobile — the sheet replaces it
  assert.ok(!catalog.includes('defaultOpen='), 'defaultOpen prop retired');
});

// ---- P8: cosmetics

test('cart: integer prices render without forced .00 decimals', () => {
  const cart = src('app/cart/page.tsx');
  assert.match(cart, /formatPrice|formatUah/);
  assert.ok(!cart.includes('.toFixed(2)'), 'raw toFixed(2) must go through the shared formatter');
});

test('header: search input has an accessible label; badges hide zero state', () => {
  // 2026-09-11: the search input (+ label) moved into the SearchSuggest
  // autocomplete island; the header keeps the same no-JS GET form.
  const header = src('app/components/SiteHeader.tsx');
  assert.match(header, /<SearchSuggest/);
  const search = src('app/components/SearchSuggest.tsx');
  assert.match(search, /aria-label="Пошук"/);
  const cartBadge = src('app/components/CartBadge.tsx');
  const favBadge = src('app/components/FavoritesBadge.tsx');
  assert.match(cartBadge, /count > 0 &&/);
  assert.match(favBadge, /count > 0 &&/);
});

// ---- 2026-08-27 stage: sort change resets pagination to page 1

test('catalog: SortSelect builds URLs via the tested buildSortSearchParams helper', () => {
  const s = src('app/catalog/SortSelect.tsx');
  assert.match(s, /buildSortSearchParams/, 'sort control must use the shared URL contract');
  // the old inline builder kept ?page=N on sort change — must not return
  assert.doesNotMatch(s, /new URLSearchParams\(searchParams\.toString\(\)\)/);
});
