import crypto from 'node:crypto';

/**
 * Domain-separated token secret (2026-09 hardening): the raw service-role
 * key is no longer used directly as the HMAC key. It is first derived into
 * a purpose-bound key — HMAC(serviceKey, 'order-token:v1') — so the same
 * secret material cannot be replayed across protocols (domain separation).
 * A leak of a token can therefore never be confused with, or reused as,
 * output of another consumer of the service key.
 *
 * NOTE: this deliberately invalidates every previously issued guest token
 * (accepted 2026-09: zero real orders in production, only verify-run
 * artifacts).
 */
function orderTokenSecret(): string {
  return crypto
    .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY!)
    .update('order-token:v1')
    .digest('hex');
}

/**
 * Capability token binding an order number to its confirmation URL.
 * Derived from the service-role key (via the domain-separated secret
 * above), which never leaves the server.
 */
export function orderAccessToken(orderNumber: string): string {
  return crypto
    .createHmac('sha256', orderTokenSecret())
    .update(orderNumber)
    .digest('hex')
    .slice(0, 32);
}

/** Constant-time comparison that survives malformed/short tokens. */
export function verifyOrderAccessToken(
  orderNumber: string,
  token: unknown
): boolean {
  if (!orderNumber || typeof token !== 'string') return false;
  const expected = Buffer.from(orderAccessToken(orderNumber), 'utf8');
  const provided = Buffer.from(token, 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}
