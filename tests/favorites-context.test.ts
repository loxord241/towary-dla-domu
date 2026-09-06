/**
 * Behavioral tests for favorites-context (client module, no React rendering).
 * node:test cannot render JSX, so we drive the exported pure logic directly:
 *  - toggleFavoriteList — the exact function the provider's toggleFavorite
 *    setState callback dispatches through (add / remove / MAX cap);
 *  - loadStoredFavorites — the hydration loader, exercised against a
 *    window.localStorage stub (valid data, garbage JSON, legacy shapes,
 *    blocked storage, missing window). Sanitization itself is covered by
 *    favorites-storage.test.ts — here we pin the context-side contract that
 *    every failure mode degrades to an empty list and still calls back.
 * The real .tsx modules are imported through tests/helpers/tsx-loader.mjs.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/tsx-loader.mjs', import.meta.url);

const { loadStoredFavorites, toggleFavoriteList, MAX_FAVORITES } = await import(
  '../app/lib/favorites-context.tsx'
);
const { FAVORITES_STORAGE_KEY } = await import(
  '../app/lib/favorites-storage.ts'
);

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function pid(n: number): string {
  return `${String(n).padStart(8, '0')}-9999-9999-9999-999999999999`;
}

// ---- window.localStorage stub -------------------------------------------

interface StorageStub {
  getItem: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
}

let originalWindow: unknown;

function installWindow(localStorage: unknown): void {
  const g = globalThis as { window?: unknown };
  originalWindow = g.window;
  g.window = { localStorage };
}

function uninstallWindow(): void {
  const g = globalThis as { window?: unknown };
  if (originalWindow === undefined) {
    delete g.window;
  } else {
    g.window = originalWindow;
  }
}

async function loadWith(localStorage: StorageStub): Promise<string[]> {
  installWindow(localStorage);
  try {
    let received: string[] | undefined;
    let calls = 0;
    await loadStoredFavorites((ids) => {
      calls += 1;
      received = ids;
    });
    assert.equal(calls, 1, 'loader must always terminate with one callback');
    assert.ok(Array.isArray(received), 'callback must receive an array');
    return received;
  } finally {
    uninstallWindow();
  }
}

beforeEach(() => {
  uninstallWindow();
});
afterEach(() => {
  uninstallWindow();
});

// ---- toggleFavoriteList: add / remove / cap ------------------------------

test('favorites: toggle adds a new id, keeping order and not mutating input', () => {
  const before = [A];
  const next = toggleFavoriteList(before, B);
  assert.deepEqual(next, [A, B]);
  assert.deepEqual(before, [A], 'input array must not be mutated');
});

test('favorites: toggle of an existing id removes it', () => {
  assert.deepEqual(toggleFavoriteList([A, B], A), [B]);
  assert.deepEqual(toggleFavoriteList([A, B], B), [A]);
  assert.deepEqual(toggleFavoriteList([A], A), []);
});

test('favorites: toggle at the MAX cap is a no-op (null) for a new id', () => {
  const full = Array.from({ length: MAX_FAVORITES }, (_, i) => pid(i + 1));
  assert.equal(
    toggleFavoriteList(full, pid(MAX_FAVORITES + 1)),
    null,
    'adding beyond the cap must be rejected'
  );
  assert.equal(full.length, MAX_FAVORITES);
});

test('favorites: removing still works at the MAX cap', () => {
  const full = Array.from({ length: MAX_FAVORITES }, (_, i) => pid(i + 1));
  const next = toggleFavoriteList(full, full[0] as string);
  assert.equal(next?.length, MAX_FAVORITES - 1);
  assert.equal(next?.includes(full[0] as string), false);
});

test('favorites: adding the last free slot up to the cap succeeds', () => {
  const almostFull = Array.from(
    { length: MAX_FAVORITES - 1 },
    (_, i) => pid(i + 1)
  );
  const next = toggleFavoriteList(almostFull, pid(MAX_FAVORITES));
  assert.equal(next?.length, MAX_FAVORITES);
});

// ---- loadStoredFavorites: rehydrate from localStorage --------------------

test('favorites: valid stored ids are loaded in order, deduplicated', async () => {
  const ids = await loadWith({
    getItem: (key) => {
      assert.equal(key, FAVORITES_STORAGE_KEY);
      return JSON.stringify([A, B, A]);
    },
  });
  assert.deepEqual(ids, [A, B]);
});

test('favorites: non-uuid and legacy object entries are dropped (sanitizer contract)', async () => {
  const ids = await loadWith({
    getItem: () => JSON.stringify(['nope', { id: A }, null, 42, B]),
  });
  assert.deepEqual(ids, [B]);
});

test('favorites: oversized stored list is capped at MAX_FAVORITES on read', async () => {
  const ids = await loadWith({
    getItem: () =>
      JSON.stringify(
        Array.from({ length: MAX_FAVORITES + 40 }, (_, i) => pid(i + 1))
      ),
  });
  assert.equal(ids.length, MAX_FAVORITES);
});

test('favorites: broken JSON degrades to an empty list', async () => {
  const ids = await loadWith({ getItem: () => '{oops' });
  assert.deepEqual(ids, []);
});

test('favorites: non-array JSON (wrong shape) degrades to an empty list', async () => {
  assert.deepEqual(await loadWith({ getItem: () => JSON.stringify({ x: 1 }) }), []);
  assert.deepEqual(await loadWith({ getItem: () => '"hello"' }), []);
  assert.deepEqual(await loadWith({ getItem: () => '42' }), []);
});

test('favorites: missing key (null) yields an empty list', async () => {
  assert.deepEqual(await loadWith({ getItem: () => null }), []);
});

test('favorites: blocked storage (thrown getItem) degrades to an empty list', async () => {
  const ids = await loadWith({
    get getItem(): (key: string) => string | null {
      throw new Error('SecurityError: access denied');
    },
  });
  assert.deepEqual(ids, []);
});

test('favorites: missing window (SSR / no DOM) degrades to an empty list', async () => {
  // window deliberately not installed — ReferenceError must be swallowed.
  let received: string[] | undefined;
  await loadStoredFavorites((ids) => {
    received = ids;
  });
  assert.deepEqual(received, []);
});
