/**
 * Unit tests for LiqPay SHA3-256 signing/verification primitives.
 *
 * LiqPay API v3 signature scheme:
 *   signature = base64( sha3-256( private_key + data + private_key ) )
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// Stubbed BEFORE import — the module reads nothing at import time, the key
// is always passed explicitly (testable, never bundled client-side).
const PRIV = 'sandbox-private-key-for-unit-tests';

const { createLiqPaySignature, verifyLiqPaySignature, encodeLiqPayData, decodeLiqPayData } =
  await import('../app/lib/payment/liqpay-signature.ts');

function manualSignature(data: string, priv: string): string {
  return crypto
    .createHash('sha3-256')
    .update(priv + data + priv, 'utf8')
    .digest('base64');
}

test('SIG: signature equals independent sha3-256(private+data+private) recomputation', () => {
  const data = encodeLiqPayData({ action: 'pay', amount: '100.00' });
  assert.equal(createLiqPaySignature(data, PRIV), manualSignature(data, PRIV));
});

test('SIG: deterministic output for identical input', () => {
  const data = 'dGVzdA==';
  assert.equal(
    createLiqPaySignature(data, PRIV),
    createLiqPaySignature(data, PRIV)
  );
});

test('SIG: depends on both data and key', () => {
  const data = 'dGVzdA==';
  assert.notEqual(createLiqPaySignature(data, PRIV), createLiqPaySignature(data, 'other-key'));
  assert.notEqual(createLiqPaySignature(data, PRIV), createLiqPaySignature('other', PRIV));
});

test('SIG: output is valid base64 of 32 bytes (sha3-256 digest)', () => {
  const data = 'e30=';
  const sig = createLiqPaySignature(data, PRIV);
  assert.match(sig, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(sig, 'base64').length, 32);
});

test('VERIFY: accepts a genuine signature', () => {
  const data = encodeLiqPayData({ action: 'status', order_id: 'ORD-20260101-ABC123:2' });
  const sig = createLiqPaySignature(data, PRIV);
  assert.equal(verifyLiqPaySignature(data, sig, PRIV), true);
});

test('VERIFY: rejects tampered data (same-length edit)', () => {
  const data = encodeLiqPayData({ action: 'pay', amount: '100.00' });
  const sig = createLiqPaySignature(data, PRIV);
  const tampered = (data[0] === 'Z' ? 'a' : 'Z') + data.slice(1);
  assert.equal(verifyLiqPaySignature(tampered, sig, PRIV), false);
});

test('VERIFY: rejects tampered/altered signature', () => {
  const data = encodeLiqPayData({ action: 'pay' });
  const sig = createLiqPaySignature(data, PRIV);
  const flipped = (() => {
    const buf = Buffer.from(sig, 'base64');
    buf[5] ^= 0x01;
    return buf.toString('base64');
  })();
  assert.equal(flipped !== sig, true);
  assert.equal(verifyLiqPaySignature(data, flipped, PRIV), false);
});

test('VERIFY: rejects foreign-key signature and malformed types', () => {
  const data = 'YWJj';
  assert.equal(
    verifyLiqPaySignature(data, createLiqPaySignature(data, 'attacker'), PRIV),
    false
  );
  assert.equal(verifyLiqPaySignature(data, '', PRIV), false);
  assert.equal(verifyLiqPaySignature(data, undefined, PRIV), false);
  assert.equal(verifyLiqPaySignature(data, 12345, PRIV), false);
  assert.equal(verifyLiqPaySignature('', 'c2ln', PRIV), false);
});

test('SIG SOURCE: uses sha3-256 and timing-safe comparison', () => {
  const src = readFileSync(
    new URL('../app/lib/payment/liqpay-signature.ts', import.meta.url),
    'utf8'
  );
  assert.match(src, /sha3-256/);
  assert.match(src, /timingSafeEqual/);
});

test('DECODE: round-trips base64(JSON) and rejects junk shapes', () => {
  const payload = { order_id: 'ORD-20260826-ABC123:2', amount: '1050.50' };
  const encoded = encodeLiqPayData(payload);
  assert.deepEqual(decodeLiqPayData(encoded), payload);
  // Strict decode: charset and JSON-object requirements.
  assert.equal(decodeLiqPayData('not+base64!'), null);
  const arr = Buffer.from('[1,2,3]', 'utf8').toString('base64');
  assert.equal(decodeLiqPayData(arr), null); // array, not object
  assert.equal(
    decodeLiqPayData(Buffer.from('"str"', 'utf8').toString('base64')),
    null
  );
});

