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
const crypto = await import('node:crypto');

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

// ---- Domain separation (2026-09 hardening) --------------------------------
// The HMAC key must be a DERIVED key — HMAC(serviceKey, 'order-token:v1') —
// never the raw service-role key. This deliberately invalidates every token
// issued before the change (accepted: production has zero real orders).

test('token is NOT the raw service-key HMAC of the order number (domain separation)', () => {
  const raw = crypto
    .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY!)
    .update(ORDER)
    .digest('hex')
    .slice(0, 32);
  assert.notEqual(orderAccessToken(ORDER), raw);
  // …and a pre-change (raw-key) token no longer verifies.
  assert.equal(verifyOrderAccessToken(ORDER, raw), false);
});

test('token secret is bound to the order-token domain string', () => {
  const expected = crypto
    .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY!)
    .update('order-token:v1')
    .digest('hex');
  const derivedToken = crypto
    .createHmac('sha256', expected)
    .update(ORDER)
    .digest('hex')
    .slice(0, 32);
  assert.equal(orderAccessToken(ORDER), derivedToken);
});

test('different service keys yield different tokens', () => {
  const first = orderAccessToken(ORDER);
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'another-test-service-key';
  const second = orderAccessToken(ORDER);
  assert.notEqual(first, second);
  // restore for any later test in the same process
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key-for-unit-tests';
  assert.equal(orderAccessToken(ORDER), first);
});
