/**
 * Unit tests for the pure favorites-storage sanitizer.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeStoredFavorites,
  MAX_FAVORITES,
} from '../app/lib/favorites-storage.ts';

const PID = '11111111-1111-1111-1111-111111111111';

function pid(n: number): string {
  return `${String(n).padStart(8, '0')}-2222-2222-2222-222222222222`;
}

test('valid ids pass through, deduplicated, order preserved', () => {
  assert.deepEqual(sanitizeStoredFavorites([PID, PID]), [PID]);
});

test('non-array input degrades to empty list', () => {
  for (const raw of [null, undefined, 'x', 7, {}, false]) {
    assert.deepEqual(sanitizeStoredFavorites(raw), []);
  }
});

test('invalid UUIDs and non-string entries are dropped', () => {
  assert.deepEqual(
    sanitizeStoredFavorites([
      'nope',
      PID.toUpperCase() + 'X',
      { id: PID },
      null,
      12,
      '',
    ]),
    []
  );
});

test('uppercase UUIDs are accepted (regex is case-insensitive)', () => {
  assert.deepEqual(sanitizeStoredFavorites([PID.toUpperCase()]), [PID]);
});

test('list length is capped at MAX_FAVORITES', () => {
  const raw = Array.from({ length: MAX_FAVORITES + 30 }, (_, i) => pid(i + 1));
  assert.equal(sanitizeStoredFavorites(raw).length, MAX_FAVORITES);
});
