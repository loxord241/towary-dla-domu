/**
 * Unit tests for the HMAC order access token (capability pair
 * order_number + token). Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The token is derived from the service-role key; tests stub it BEFORE any
// call (the key is read inside the functions, not at import time).
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key-for-unit-tests';

const { orderAccessToken, verifyOrderAccessToken } = await import(
  '../app/lib/order-token.ts'
);

const ORDER = 'ORD-20260823-ABC123';

test('token is deterministic for the same order number', () => {
  assert.equal(orderAccessToken(ORDER), orderAccessToken(ORDER));
});

test('token differs between order numbers', () => {
  assert.notEqual(orderAccessToken(ORDER), orderAccessToken('ORD-20260823-XYZ789'));
});

test('token is 32 hex chars', () => {
  assert.match(orderAccessToken(ORDER), /^[0-9a-f]{32}$/);
});

test('verify accepts the correct token', () => {
  assert.equal(verifyOrderAccessToken(ORDER, orderAccessToken(ORDER)), true);
});

test('verify rejects wrong token / wrong order / malformed input', () => {
  assert.equal(verifyOrderAccessToken(ORDER, '0'.repeat(32)), false);
  assert.equal(
    verifyOrderAccessToken('ORD-20260823-XYZ789', orderAccessToken(ORDER)),
    false
  );
  assert.equal(verifyOrderAccessToken(ORDER, 'short'), false);
  assert.equal(verifyOrderAccessToken(ORDER, ''), false);
  assert.equal(verifyOrderAccessToken(ORDER, null), false);
  assert.equal(verifyOrderAccessToken(ORDER, undefined), false);
  assert.equal(verifyOrderAccessToken('', orderAccessToken(ORDER)), false);
});
