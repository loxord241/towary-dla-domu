import crypto from 'node:crypto';

/**
 * Capability token binding an order number to its confirmation URL.
 * Derived from the service-role key, which never leaves the server.
 */
export function orderAccessToken(orderNumber: string): string {
  return crypto
    .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY!)
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
