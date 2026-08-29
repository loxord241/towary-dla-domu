/**
 * F2: Idempotency-Key parsing for POST /api/orders.
 *
 * Pure module (no DOM, no env, no network) so the validation rules are
 * unit-testable and shared by the route and the tests.
 *
 * Contract:
 *   - missing / empty header  → ok, key = null  (legacy requests keep
 *     working unchanged — the key is optional, dedup is DB-enforced);
 *   - a key is 8..128 printable ASCII chars (no spaces, no control chars);
 *   - anything else → ok: false with a fixed user-facing message (no
 *     internals echoed back).
 */

export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;

/** Printable ASCII without space (0x21–0x7E) — safe for logs and headers. */
const KEY_RE = /^[\x21-\x7E]+$/;

export type ParsedIdempotencyKey =
  | { ok: true; key: string | null }
  | { ok: false; error: string };

export function parseIdempotencyKey(raw: string | null): ParsedIdempotencyKey {
  if (raw === null) return { ok: true, key: null };
  const key = raw.trim();
  if (key === '') return { ok: true, key: null };
  if (
    key.length < IDEMPOTENCY_KEY_MIN ||
    key.length > IDEMPOTENCY_KEY_MAX ||
    !KEY_RE.test(key)
  ) {
    return { ok: false, error: 'Некоректний Idempotency-Key' };
  }
  return { ok: true, key };
}
