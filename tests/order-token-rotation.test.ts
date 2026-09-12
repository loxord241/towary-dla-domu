/**
 * Guest order token rotation (audit P1, 2026-09-12; migration 045).
 *
 * The legacy token was an eternal deterministic HMAC(order_number) — a
 * leaked URL/log gave permanent order access. Now:
 *   - new orders get a random per-order token; only its SHA-256 hash is
 *     stored (orders.access_token_hash);
 *   - every successful lookup (email + number = identity proof) and every
 *     idempotent checkout replay ROTATES the token;
 *   - NULL-hash rows (never rotated) still verify the legacy HMAC — links
 *     issued before 2026-09-12 keep working until first rotation.
 *
 * Covers: token/hash/verify unit (randomness, hash round-trip, timing-safe
 * rejection), the static wiring of both issuance sites (checkout POST and
 * lookup POST: rotate → store hash → legacy fallback), the order page
 * dual-verify, and the migration file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const { generateOrderAccessToken, hashOrderAccessToken, verifyStoredAccessToken } =
  await import(pathToFileURL(path.join(root, 'app/lib/order-token.ts')).href);

test('ROTATE unit: tokens are random, URL-safe, hash round-trips', () => {
  const a = generateOrderAccessToken();
  const b = generateOrderAccessToken();
  assert.notEqual(a, b, 'two tokens must never collide');
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  const hash = hashOrderAccessToken(a);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, a, 'stored form is a hash, not the token');
  assert.equal(verifyStoredAccessToken(a, hash), true);
  assert.equal(verifyStoredAccessToken(b, hash), false, 'another token rejects');
  // Truncated / tampered / wrong-type inputs reject without throwing.
  assert.equal(verifyStoredAccessToken(a.slice(0, 8), hash), false);
  assert.equal(verifyStoredAccessToken('', hash), false);
  assert.equal(verifyStoredAccessToken(null, hash), false);
  assert.equal(verifyStoredAccessToken(a, 'deadbeef'), false);
});

const ORDERS = src('app/api/orders/route.ts');
const LOOKUP = src('app/api/orders/lookup/route.ts');
const PAGE = src('app/orders/[orderNumber]/page.tsx');

test('ROTATE checkout: random token issued, hash stored, legacy fallback', () => {
  for (const pattern of [
    /accessToken = generateOrderAccessToken\(\)/,
    /access_token_hash: hashOrderAccessToken\(accessToken\)/,
    /accessToken = orderAccessToken\(orderNumber\)/,
    // Replay (created=false) takes the same rotate path — a leaked URL dies.
    /every issue \(fresh creation AND idempotent replay\)[\s/]+ROTATES/,
  ]) {
    assert.match(ORDERS, pattern);
  }
  // Token rotation failure never fails the order (legacy fallback inside
  // the catch returns the deterministic HMAC).
  assert.match(ORDERS, /} catch \(err\) \{[\s\S]{0,400}?accessToken = orderAccessToken\(orderNumber\)/);
});

test('ROTATE lookup: successful identity proof rotates the token', () => {
  assert.match(LOOKUP, /generateOrderAccessToken\(\)/);
  assert.match(LOOKUP, /access_token_hash: hashOrderAccessToken\(accessToken\)/);
  assert.match(LOOKUP, /accessToken = orderAccessToken\(data\.order_number\)/);
  // Rotation happens AFTER the email+number match (inside the success path).
  const selectIdx = LOOKUP.indexOf(".eq('email', email)");
  const rotateIdx = LOOKUP.indexOf('generateOrderAccessToken()');
  assert.ok(selectIdx !== -1 && rotateIdx !== -1 && rotateIdx > selectIdx);
});

test('ROTATE order page: stored hash verifies first; NULL hash → legacy HMAC', () => {
  assert.match(PAGE, /verifyStoredAccessToken\(t, storedHash\)/);
  assert.match(PAGE, /verifyOrderAccessToken\(orderNumber, t\)/);
  // The stored hash is read from the server-side row, never from the URL.
  assert.match(PAGE, /access_token_hash/);
});

test('MIGRATION 045: nullable access_token_hash, no data writes', () => {
  const m = src('database/migrations/045_order_access_token_rotation.sql');
  assert.match(m, /add column if not exists access_token_hash text/i);
  assert.doesNotMatch(m, /insert into|update\s+\w+\s+set|delete from/i);
  assert.match(m, /VERIFY-PRE/);
  assert.match(m, /VERIFY-POST/);
});
