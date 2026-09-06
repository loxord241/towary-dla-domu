/**
 * Behavioral tests for cart-context (client module, no React rendering).
 * node:test cannot render JSX, so we drive the exported pure logic directly:
 *  - reducer — the exact state machine CartProvider dispatches into
 *    (HYDRATE / ADD_ITEM / REMOVE_ITEM / UPDATE_QUANTITY / CLEAR, line
 *    merging, MAX_ITEM_QUANTITY and MAX_CART_LINES caps);
 *  - loadStoredCart — the hydration loader, exercised against a
 *    window.localStorage stub (valid data, garbage JSON, legacy shapes,
 *    blocked storage, missing window). Sanitization itself is covered by
 *    cart-storage.test.ts — here we pin the context-side contract that every
 *    failure mode degrades to an empty cart and still calls back.
 * The real .tsx module is imported through tests/helpers/tsx-loader.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/tsx-loader.mjs', import.meta.url);

const {
  reducer,
  loadStoredCart,
  MAX_CART_LINES,
  MAX_ITEM_QUANTITY,
} = await import('../app/lib/cart-context.tsx');
const { CART_STORAGE_KEY, lineKey } = await import(
  '../app/lib/cart-storage.ts'
);

import type { CartItem } from '../app/lib/cart-storage.ts';
import type { CartState } from '../app/lib/cart-context.tsx';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function pid(n: number): string {
  return `${String(n).padStart(8, '0')}-8888-8888-8888-888888888888`;
}

const EMPTY: CartState = { items: [], hydrated: false };
const HYDRATED_EMPTY: CartState = { items: [], hydrated: true };

const item = (
  productId: string,
  variantId: string | null,
  quantity: number
): CartItem => ({ productId, variantId, quantity });

// ---- reducer: ADD_ITEM / REMOVE_ITEM / UPDATE_QUANTITY / CLEAR / HYDRATE --

test('cart reducer: HYDRATE replaces items and marks the cart hydrated', () => {
  const next = reducer(EMPTY, { type: 'HYDRATE', items: [item(A, null, 2)] });
  assert.deepEqual(next, { items: [item(A, null, 2)], hydrated: true });
});

test('cart reducer: ADD_ITEM appends a new line and preserves hydrated flag', () => {
  const next = reducer(HYDRATED_EMPTY, { type: 'ADD_ITEM', item: item(A, null, 2) });
  assert.deepEqual(next, { items: [item(A, null, 2)], hydrated: true });
});

test('cart reducer: ADD_ITEM merges into an existing line (same product+variant)', () => {
  const state = { items: [item(A, null, 2), item(B, null, 1)], hydrated: true };
  const next = reducer(state, { type: 'ADD_ITEM', item: item(A, null, 3) });
  assert.deepEqual(next.items, [item(A, null, 5), item(B, null, 1)]);
});

test('cart reducer: same product with different variants stays separate lines', () => {
  const state = { items: [item(A, null, 1)], hydrated: true };
  const next = reducer(state, { type: 'ADD_ITEM', item: item(A, '33333333-3333-3333-3333-333333333333', 1) });
  assert.equal(next.items.length, 2);
});

test('cart reducer: merged quantity is capped at MAX_ITEM_QUANTITY', () => {
  const state = { items: [item(A, null, 60)], hydrated: true };
  const next = reducer(state, { type: 'ADD_ITEM', item: item(A, null, 60) });
  assert.deepEqual(next.items, [item(A, null, MAX_ITEM_QUANTITY)]);
});

test('cart reducer: a new line beyond MAX_CART_LINES is dropped, state unchanged', () => {
  const full: CartState = {
    items: Array.from({ length: MAX_CART_LINES }, (_, i) =>
      item(pid(i + 1), null, 1)
    ),
    hydrated: true,
  };
  const next = reducer(full, {
    type: 'ADD_ITEM',
    item: item(pid(MAX_CART_LINES + 1), null, 1),
  });
  assert.equal(next, full, 'reducer must return the same state object');
  assert.equal(next.items.length, MAX_CART_LINES);
  assert.equal(next.hydrated, true);
});

test('cart reducer: merging into an existing line still works at MAX_CART_LINES', () => {
  const full: CartState = {
    items: Array.from({ length: MAX_CART_LINES }, (_, i) =>
      item(pid(i + 1), null, 1)
    ),
    hydrated: true,
  };
  const next = reducer(full, { type: 'ADD_ITEM', item: item(pid(1), null, 4) });
  assert.equal(next.items.length, MAX_CART_LINES);
  assert.equal(next.items[0]?.quantity, 5);
});

test('cart reducer: REMOVE_ITEM deletes by product+variant key', () => {
  const state = { items: [item(A, null, 1), item(B, null, 2)], hydrated: true };
  const next = reducer(state, { type: 'REMOVE_ITEM', key: lineKey(A, null) });
  assert.deepEqual(next.items, [item(B, null, 2)]);
  assert.equal(next.hydrated, true);
});

test('cart reducer: REMOVE_ITEM with an unknown key leaves items unchanged', () => {
  const state = { items: [item(A, null, 1)], hydrated: true };
  const next = reducer(state, { type: 'REMOVE_ITEM', key: lineKey(B, null) });
  assert.deepEqual(next.items, [item(A, null, 1)]);
});

test('cart reducer: UPDATE_QUANTITY sets a valid quantity on the matching line', () => {
  const state = { items: [item(A, null, 1), item(B, null, 2)], hydrated: true };
  const next = reducer(state, {
    type: 'UPDATE_QUANTITY',
    key: lineKey(B, null),
    quantity: 7,
  });
  assert.deepEqual(next.items, [item(A, null, 1), item(B, null, 7)]);
});

test('cart reducer: UPDATE_QUANTITY rejects 0 / negative / fractional / string / NaN / over-cap', () => {
  const state = { items: [item(A, null, 2)], hydrated: true };
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_ITEM_QUANTITY + 1]) {
    const next = reducer(state, {
      type: 'UPDATE_QUANTITY',
      key: lineKey(A, null),
      quantity: bad,
    });
    assert.equal(next, state, `quantity ${String(bad)} must be a no-op`);
  }
});

test('cart reducer: UPDATE_QUANTITY on the quantity cap boundary is accepted', () => {
  const state = { items: [item(A, null, 1)], hydrated: true };
  const next = reducer(state, {
    type: 'UPDATE_QUANTITY',
    key: lineKey(A, null),
    quantity: MAX_ITEM_QUANTITY,
  });
  assert.deepEqual(next.items, [item(A, null, MAX_ITEM_QUANTITY)]);
});

test('cart reducer: UPDATE_QUANTITY for an unknown key leaves items unchanged', () => {
  const state = { items: [item(A, null, 1)], hydrated: true };
  const next = reducer(state, {
    type: 'UPDATE_QUANTITY',
    key: lineKey(B, null),
    quantity: 3,
  });
  assert.deepEqual(next.items, [item(A, null, 1)]);
});

test('cart reducer: CLEAR empties the cart and keeps it hydrated', () => {
  const state = { items: [item(A, null, 1)], hydrated: true };
  assert.deepEqual(reducer(state, { type: 'CLEAR' }), HYDRATED_EMPTY);
  assert.deepEqual(reducer(EMPTY, { type: 'CLEAR' }), HYDRATED_EMPTY);
});

// ---- loadStoredCart: rehydrate from localStorage --------------------------

interface StorageStub {
  getItem: (key: string) => string | null;
}

async function loadWith(localStorage: StorageStub): Promise<CartItem[]> {
  let received: CartItem[] | undefined;
  let calls = 0;
  const g = globalThis as { window?: unknown };
  const originalWindow = g.window;
  g.window = { localStorage };
  try {
    await loadStoredCart((items) => {
      calls += 1;
      received = items;
    });
    assert.equal(calls, 1, 'loader must always terminate with one callback');
    assert.ok(Array.isArray(received), 'callback must receive an array');
    return received;
  } finally {
    if (originalWindow === undefined) delete g.window;
    else g.window = originalWindow;
  }
}

test('cart loader: valid stored lines pass sanitization, key read is the cart key', async () => {
  const items = await loadWith({
    getItem: (key) => {
      assert.equal(key, CART_STORAGE_KEY);
      return JSON.stringify([item(A, null, 2), item(B, '44444444-4444-4444-4444-444444444444', 1)]);
    },
  });
  assert.deepEqual(items, [
    item(A, null, 2),
    item(B, '44444444-4444-4444-4444-444444444444', 1),
  ]);
});

test('cart loader: invalid uuids / quantities / legacy shapes are dropped', async () => {
  const items = await loadWith({
    getItem: () =>
      JSON.stringify([
        'not-an-object',
        { productId: 'nope', variantId: null, quantity: 1 },
        { productId: A, variantId: null, quantity: 0 },
        { legacy: 'shape' },
        item(B, null, 3),
      ]),
  });
  assert.deepEqual(items, [item(B, null, 3)]);
});

test('cart loader: duplicate stored lines merge with the quantity cap', async () => {
  const items = await loadWith({
    getItem: () =>
      JSON.stringify([item(A, null, 60), item(A, null, 60)]),
  });
  assert.deepEqual(items, [item(A, null, MAX_ITEM_QUANTITY)]);
});

test('cart loader: broken JSON degrades to an empty cart', async () => {
  assert.deepEqual(await loadWith({ getItem: () => '[oops' }), []);
});

test('cart loader: non-array JSON (wrong shape) degrades to an empty cart', async () => {
  assert.deepEqual(await loadWith({ getItem: () => JSON.stringify({ items: [] }) }), []);
  assert.deepEqual(await loadWith({ getItem: () => '"cart"' }), []);
});

test('cart loader: missing key (null) yields an empty cart', async () => {
  assert.deepEqual(await loadWith({ getItem: () => null }), []);
});

test('cart loader: blocked storage (thrown getItem) degrades to an empty cart', async () => {
  const items = await loadWith({
    get getItem(): (key: string) => string | null {
      throw new Error('SecurityError: access denied');
    },
  });
  assert.deepEqual(items, []);
});

test('cart loader: missing window (SSR / no DOM) degrades to an empty cart', async () => {
  // window deliberately not installed — ReferenceError must be swallowed.
  let received: CartItem[] | undefined;
  await loadStoredCart((items) => {
    received = items;
  });
  assert.deepEqual(received, []);
});
