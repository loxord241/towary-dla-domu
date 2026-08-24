import crypto from 'node:crypto';

/**
 * Minimal HS256 JWT signer for the Yugcontract auth handshake.
 *
 * Produces exactly what the provider documentation's
 * `jwt.sign({ algorithm: 'HS256', user_key }, secret, { expiresIn: 180 })`
 * produces (jsonwebtoken-compatible shape):
 *   header  = {"alg":"HS256","typ":"JWT"}
 *   payload = {...payload, iat: <sec>, exp: <sec>}
 * Implemented with node:crypto to avoid adding a dependency; the private
 * key material never leaves the caller.
 *
 * Server-side only: must never be imported from a client component.
 */
export function signHs256Jwt(
  payload: Record<string, unknown>,
  secret: string,
  expiresInSec: number
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    'utf8'
  ).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec }),
    'utf8'
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}
