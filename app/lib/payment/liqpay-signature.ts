import crypto from 'node:crypto';

/**
 * LiqPay API v3 signature primitives.
 *
 * Scheme (current LiqPay documentation):
 *   signature = base64( sha3-256( private_key + data + private_key ) )
 *
 * The private key is ALWAYS passed explicitly by the server-side caller
 * (see app/lib/payment/liqpay-config.ts) and must never reach the client
 * bundle; these functions are imported only by route handlers.
 *
 * All comparisons are timing-safe over the DECODED digest bytes so that an
 * attacker-controlled signature of arbitrary length cannot extend its
 * lifetime through length-dependent early exits (length is checked first,
 * which leaks nothing about the expected value).
 */

export function createLiqPaySignature(data: string, privateKey: string): string {
  return crypto
    .createHash('sha3-256')
    .update(privateKey + data + privateKey, 'utf8')
    .digest('base64');
}

/** Timing-safe verification of an untrusted `signature` against `data`. */
export function verifyLiqPaySignature(
  data: string,
  signature: unknown,
  privateKey: string
): boolean {
  if (!data || typeof signature !== 'string' || signature === '') return false;
  const expected = Buffer.from(createLiqPaySignature(data, privateKey), 'base64');
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

/** Serialize checkout/callback params to the `data` field: base64(JSON). */
export function encodeLiqPayData(params: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(params), 'utf8').toString('base64');
}

/**
 * Strict decode of an incoming `data` field. Rejects non-string input,
 * malformed base64 shapes and non-object JSON. Signature verification must
 * happen BEFORE this on the raw string; after verification passes, a null
 * here means the payload is unusable and must be treated as invalid.
 */
export function decodeLiqPayData(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string' || data === '') return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      return null;
    }
    return json as Record<string, unknown>;
  } catch {
    return null;
  }
}
