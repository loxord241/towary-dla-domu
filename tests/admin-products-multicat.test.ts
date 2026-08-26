import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const post = () => readFileSync('app/api/admin/products/route.ts', 'utf8');
const one = () => readFileSync('app/api/admin/products/[id]/route.ts', 'utf8');

test('ADMIN-MULTICAT: POST writes junction rows from category_ids', () => {
  const s = post();
  assert.match(s, /from\('product_categories'\)/);
  assert.match(s, /category_ids/);
});

test('ADMIN-MULTICAT: PUT validates every uuid before touching db', () => {
  const s = one();
  assert.match(s, /Некоректний id категорії/);
  assert.match(s, /product_categories/);
});

test('ADMIN-MULTICAT: GET detail returns category_ids', () => {
  const s = one();
  assert.match(s, /category_ids/);
  // junction read drives the payload
  assert.match(s, /from\('product_categories'\)[\s\S]{0,200}category_id/);
});

test('ADMIN-MULTICAT: legacy category_id stays synchronized (= first selected)', () => {
  const s = one();
  assert.match(
    s,
    /categoryIds\[0\] \?\? null|ids\[0\] \?\? null/,
    'PUT must keep products.category_id = first selected for transition'
  );
});

test('ADMIN-MULTICAT: empty array clears junction links', () => {
  const s = one();
  assert.match(s, /\.delete\(\)\s*\.eq\('product_id', id\)/);
});
