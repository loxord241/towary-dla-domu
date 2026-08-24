/**
 * Unit tests for the Yugcontract HS256 request-token signer.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { signHs256Jwt } = await import('../app/lib/yugcontract/jwt.ts');

const SECRET = 'test-secret-ключ';
const PAYLOAD = { algorithm: 'HS256', user_key: 'my-public-user-key' };

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

test('produces a three-segment base64url JWT', () => {
  const token = signHs256Jwt(PAYLOAD, SECRET, 180);
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.match(part, /^[A-Za-z0-9_-]+$/); // no '+', '/', '='
  }
});

test('header is {"alg":"HS256","typ":"JWT"}', () => {
  const [head] = signHs256Jwt(PAYLOAD, SECRET, 180).split('.');
  assert.deepEqual(decodeSegment(head), { alg: 'HS256', typ: 'JWT' });
});

test('payload carries user fields plus iat/exp with the exact TTL', () => {
  const [, body] = signHs256Jwt(PAYLOAD, SECRET, 180).split('.');
  const payload = decodeSegment(body);
  assert.equal(payload.algorithm, 'HS256');
  assert.equal(payload.user_key, 'my-public-user-key');
  assert.equal(typeof payload.iat, 'number');
  assert.equal(typeof payload.exp, 'number');
  assert.equal((payload.exp as number) - (payload.iat as number), 180);
});

test('signature verifies with node:crypto HMAC and the same secret only', () => {
  const token = signHs256Jwt(PAYLOAD, SECRET, 180);
  const [head, body, signature] = token.split('.');

  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(`${head}.${body}`)
    .digest('base64url');
  assert.equal(signature, expected);

  const wrongSecret = crypto
    .createHmac('sha256', 'another-secret')
    .update(`${head}.${body}`)
    .digest('base64url');
  assert.notEqual(signature, wrongSecret);
});

test('token changes when the secret or payload changes', () => {
  const base = signHs256Jwt(PAYLOAD, SECRET, 180);
  assert.notEqual(base, signHs256Jwt(PAYLOAD, 'other-secret', 180));
  assert.notEqual(
    base,
    signHs256Jwt({ ...PAYLOAD, user_key: 'other-key' }, SECRET, 180)
  );
});
