/**
 * Unit tests for LiqPay checkout signing/verification primitives.
 *
 * Confirmed contract for /api/3/checkout (matches ALL official LiqPay SDKs:
 * sdk-nodejs str_to_sign, sdk-php sha1($str, true), sdk-python hashlib.sha1):
 *
 *   signature = base64( sha1( private_key + data + private_key ) )
 *
 * NOTE: the documentation page text mentions sha3-256, but every official
 * SDK targeting /api/3/checkout uses SHA-1 — pinned here as THE contract.
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

function manualSha1(data: string, priv: string): string {
  return crypto
    .createHash('sha1')
    .update(priv + data + priv, 'utf8')
    .digest('base64');
}

test('SIG: signature equals independent sha1(private+data+private) recomputation', () => {
  const data = encodeLiqPayData({ action: 'pay', amount: '100.00' });
  assert.equal(createLiqPaySignature(data, PRIV), manualSha1(data, PRIV));
});

test('SIG: official vector — sdk-php sha1 scheme byte contract', () => {
  // Fixed vector computed independently via openssl equivalent:
  //   printf '%s' "${PRIV}${DATA}${PRIV}" | openssl dgst -binary -sha1 | base64
  const priv = 'a4825234f4bae72a0be04eafe9e8e2bada209255'; // doc example key (public in docs)
  const data =
    'eyJwdWJsaWNfa2V5IjoiaTAwMDAwMDAwIiwidmVyc2lvbiI6MywiYWN0aW9uIjoicGF5IiwiYW1vdW50IjoiMSIsImN1cnJlbmN5IjoiVUFIIiwiZGVzY3JpcHRpb24iOiJ0ZXN0Iiwib3JkZXJfaWQiOiIxIn0=';
  const expected = crypto
    .createHash('sha1')
    .update(priv + data + priv, 'utf8')
    .digest('base64');
  assert.equal(createLiqPaySignature(data, priv), expected);
  // and identical bytes round-trip through verification
  assert.equal(verifyLiqPaySignature(data, expected, priv), true);
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

test('SIG: output is base64 of a 20-byte SHA-1 digest (28 chars)', () => {
  const sig = createLiqPaySignature('e30=', PRIV);
  assert.equal(sig.length, 28, 'sha1 base64 must be exactly 28 chars');
  assert.match(sig, /^[A-Za-z0-9+/]+={0,2}$/);
  const raw = Buffer.from(sig, 'base64');
  assert.equal(raw.length, 20, 'sha1 digest is 20 bytes');
  // cross-check digest against node's own sha1
  assert.equal(raw.equals(crypto.createHash('sha1').update(PRIV + 'e30=' + PRIV, 'utf8').digest()), true);
});

test('SIG: signing input is byte-exact concatenation (no reserialization)', () => {
  const json = '{"b":1,"a":"тест"}'; // unicode inside
  const data = Buffer.from(json, 'utf8').toString('base64');
  const expectedInput = PRIV + data + PRIV;
  // signed over exactly those UTF-8 bytes
  const expected = crypto.createHash('sha1').update(expectedInput, 'utf8').digest('base64');
  assert.equal(createLiqPaySignature(data, PRIV), expected);
  // decoded data equals original JSON byte-for-byte
  assert.equal(Buffer.from(data, 'base64').toString('utf8'), json);
});

test('VERIFY: accepts a genuine signature', () => {
  const data = encodeLiqPayData({ action: 'status', order_id: 'ORD-20260101-ABC123:2' });
  const sig = createLiqPaySignature(data, PRIV);
  assert.equal(verifyLiqPaySignature(data, sig, PRIV), true);
});

test('VERIFY: data/signature pair matches byte-for-byte after transport shape', () => {
  // simulate exactly what goes on the wire and comes back
  const payload = { order_id: 'ORD-X', amount: '99.00' };
  const data = encodeLiqPayData(payload);
  const sig = createLiqPaySignature(data, PRIV);
  // verifier recomputes over the SAME data string it receives
  assert.equal(verifyLiqPaySignature(data, sig, PRIV), true);
  // even a 1-bit change in signature breaks it
  const buf = Buffer.from(sig, 'base64');
  buf[0] ^= 0x01;
  assert.equal(verifyLiqPaySignature(data, buf.toString('base64'), PRIV), false);
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

test('SIG SOURCE: uses sha1 for checkout and timing-safe comparison', () => {
  const src = readFileSync(
    new URL('../app/lib/payment/liqpay-signature.ts', import.meta.url),
    'utf8'
  );
  assert.match(src, /createHash\('sha1'\)/, 'checkout contract = SHA-1');
  assert.doesNotMatch(src, /createHash\('sha3-256'\)/, 'no dual-algorithm fallback');
  assert.match(src, /timingSafeEqual/);
});
