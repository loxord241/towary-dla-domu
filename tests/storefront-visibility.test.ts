/**
 * F2 UX storefront visibility: products without at least one photo are
 * excluded from every storefront read via the `!inner` images join in
 * PRODUCT_SELECT (app/lib/catalog.ts). Static invariants below pin the
 * policy boundaries so they cannot silently regress:
 *   - storefront (catalog/search/featured/slug) filtered centrally;
 *   - count query mirrors the join (pagination totals stay truthful);
 *   - admin API keeps seeing ALL products;
 *   - cart-preview stays unfiltered (existing carts keep working);
 *   - importer/data layer untouched (no !inner leaks into yugcontract/*).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

test('VISIBILITY: PRODUCT_SELECT excludes imageless products via !inner', () => {
  const src = read('app/lib/catalog.ts');
  assert.match(
    src,
    /images:product_images!inner\(\*\)/,
    'PRODUCT_SELECT обязан использовать inner join по images'
  );
});

test('VISIBILITY: catalog head-count mirrors the eligibility join', () => {
  const src = read('app/lib/catalog.ts');
  const start = src.indexOf('export async function fetchCatalogProducts');
  const body = src.slice(start, src.indexOf('\n}', start + 100));
  assert.match(
    body,
    /\.select\(ELIGIBLE_COUNT_SELECT, \{ count: 'exact', head: true \}\)/,
    'count-запрос каталога должен использовать тот же eligibility join, иначе total не сойдётся с выдачей'
  );
});

test('VISIBILITY: direct slug inherits the filter (hidden → notFound)', () => {
  const src = read('app/lib/catalog.ts');
  const start = src.indexOf('export async function fetchProductBySlug');
  const body = src.slice(start);
  assert.match(body, /\.select\(PRODUCT_SELECT\)/, 'slug-запрос должен идти через PRODUCT_SELECT');
});

test('BOUNDARY admin: products API does NOT use the visibility filter', () => {
  const src = read('app/api/admin/products/route.ts');
  const selectStart = src.indexOf("const SELECT =");
  const selectEnd = src.indexOf(';', selectStart);
  const select = src.slice(selectStart, selectEnd);
  assert.ok(!select.includes('!inner'), 'admin должен видеть ВСЕ товары, включая без фото');
});

test('BOUNDARY cart-preview: lookup stays unfiltered (existing carts keep working)', () => {
  const src = read('app/api/cart-preview/route.ts');
  assert.ok(!src.includes('!inner'), 'cart-preview не должен фильтровать по наличию фото');
  assert.match(src, /images:product_images\(/);
});

test('BOUNDARY importer: yugcontract data layer has no storefront visibility logic', () => {
  for (const rel of [
    'app/lib/yugcontract/content-import.ts',
    'app/lib/yugcontract/content-images.ts',
    'app/lib/yugcontract/import-run.ts',
  ]) {
    const src = read(rel);
    assert.ok(!src.includes('!inner'), `${rel}: importer не должен зависеть от storefront-фильтра`);
  }
});
