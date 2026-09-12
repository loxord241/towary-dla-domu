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

// ---------------------------------------------------------------------------
// Rotating per-order tokens (2026-09 audit P1): the deterministic HMAC above
// is eternal — a leaked URL/log gives permanent order access. New orders get
// a random token; only its SHA-256 hash is stored (orders.access_token_hash,
// migration 045). Every successful lookup (email+number proves identity) and
// every idempotent checkout replay ROTATES the token; legacy links keep
// working until the first rotation of that specific order (NULL-hash rows).
// ---------------------------------------------------------------------------

/** URL-safe random token (~190 bit) — issued once per (re)generation. */
export function generateOrderAccessToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** Stored form: SHA-256 of the token — a DB leak does not leak the URL. */
export function hashOrderAccessToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time verification against a stored hash. */
export function verifyStoredAccessToken(
  token: unknown,
  storedHash: unknown
): boolean {
  if (typeof token !== 'string' || token === '') return false;
  if (typeof storedHash !== 'string' || storedHash.length !== 64) return false;
  const expected = Buffer.from(hashOrderAccessToken(token), 'utf8');
  const provided = Buffer.from(storedHash, 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}
