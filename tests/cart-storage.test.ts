/**
 * Unit tests for the pure cart-storage sanitizers (no DOM, no React).
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeStoredCart,
  clampQuantity,
  lineKey,
  MAX_CART_LINES,
  MAX_ITEM_QUANTITY,
  type CartItem,
} from '../app/lib/cart-storage.ts';

const PID = '11111111-1111-1111-1111-111111111111';
const VID = '22222222-2222-2222-2222-222222222222';

function pid(n: number): string {
  return `${String(n).padStart(8, '0')}-1111-1111-1111-111111111111`;
}

test('accepts a valid cart and strips unknown fields', () => {
  const raw = [
    {
      productId: PID,
      variantId: null,
      quantity: 2,
      hackerField: 'x',
      price: 1,
    },
  ];
  assert.deepEqual(sanitizeStoredCart(raw), [
    { productId: PID, variantId: null, quantity: 2 },
  ]);
});

test('non-array input degrades to empty cart', () => {
  for (const raw of [null, undefined, '[]', 42, {}, true]) {
    assert.deepEqual(sanitizeStoredCart(raw), []);
  }
});

test('invalid UUIDs are dropped (product and variant)', () => {
  assert.deepEqual(
    sanitizeStoredCart([{ productId: 'not-a-uuid', variantId: null, quantity: 1 }]),
    []
  );
  assert.deepEqual(
    sanitizeStoredCart([
      { productId: PID, variantId: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', quantity: 1 },
    ]),
    []
  );
  assert.deepEqual(
    sanitizeStoredCart([{ productId: PID, variantId: VID, quantity: 1 }]),
    [{ productId: PID, variantId: VID, quantity: 1 }]
  );
});

test('quantity 0, negative, fractional, NaN, Infinity, huge are rejected', () => {
  const bad = [0, -1, -5, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const q of bad) {
    assert.deepEqual(
      sanitizeStoredCart([{ productId: PID, variantId: null, quantity: q }]),
      []
    );
  }
  // above cap is clamped on duplicate merge only; single entry > cap is dropped
  assert.deepEqual(
    sanitizeStoredCart([
      { productId: PID, variantId: null, quantity: MAX_ITEM_QUANTITY + 1 },
    ]),
    []
  );
  assert.equal(clampQuantity(99), 99);
  assert.equal(clampQuantity('3'), null);
  assert.equal(clampQuantity({}), null);
});

test('string / missing quantity entries are dropped', () => {
  assert.deepEqual(
    sanitizeStoredCart([
      { productId: PID, variantId: null, quantity: '2' },
      { productId: PID, variantId: null },
      { productId: PID, variantId: null, quantity: null },
    ]),
    []
  );
});

test('non-object entries are ignored', () => {
  assert.deepEqual(sanitizeStoredCart([null, 5, 'x', [], true]), []);
});

test('duplicates merge and are capped at MAX_ITEM_QUANTITY', () => {
  const lines = sanitizeStoredCart([
    { productId: PID, variantId: null, quantity: 60 },
    { productId: PID, variantId: null, quantity: 60 },
  ]);
  assert.deepEqual(lines, [{ productId: PID, variantId: null, quantity: MAX_ITEM_QUANTITY }]);
});

test('same product with different variants stays separate', () => {
  const lines = sanitizeStoredCart([
    { productId: PID, variantId: null, quantity: 1 },
    { productId: PID, variantId: VID, quantity: 2 },
  ]);
  assert.equal(lines.length, 2);
});

test('cart line count is capped at MAX_CART_LINES', () => {
  const raw = Array.from({ length: MAX_CART_LINES + 50 }, (_, i) => ({
    productId: pid(i + 1),
    variantId: null,
    quantity: 1,
  }));
  const lines = sanitizeStoredCart(raw);
  assert.equal(lines.length, MAX_CART_LINES);
});

test('lineKey distinguishes variant vs base product', () => {
  assert.notEqual(lineKey(PID, null), lineKey(PID, VID));
  assert.equal(lineKey(PID, null), `${PID}::`);
});

test('empty array stays empty', () => {
  const empty: CartItem[] = sanitizeStoredCart([]);
  assert.deepEqual(empty, []);
});
