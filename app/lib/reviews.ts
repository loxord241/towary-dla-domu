/**
 * Pure validation for product-review submissions (Відгуки). No DOM, no
 * Supabase — imported by the public POST route and the client form, and
 * unit-tested directly in Node.
 *
 * Privacy: the ONLY accepted fields are rating, text and an OPTIONAL
 * user-typed display name. No email/order/customer data is requested,
 * accepted or stored anywhere in this feature.
 */

export const REVIEW_MIN_LENGTH = 10;
export const REVIEW_MAX_LENGTH = 1000;
export const REVIEW_NAME_MAX_LENGTH = 40;

/**
 * Multi-instance-safe daily flood cap over the whole reviews table
 * (created_at count only — identifier-free), same pattern as FEEDBACK_DAILY_CAP.
 */
export const REVIEW_DAILY_CAP = 50;

/** Control characters (except \n \r \t) that have no place in user text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function cleanUserString(value: string): string {
  return value.replace(CONTROL_CHARS, '').trim();
}

export type ReviewValidation =
  | { ok: true; rating: number; text: string; displayName: string | null }
  | { ok: false };

export function validateReviewInput(raw: {
  rating?: unknown;
  text?: unknown;
  displayName?: unknown;
}): ReviewValidation {
  // Rating must be a real integer in 1..5 — strings like "5" are rejected
  // so the client cannot smuggle coercion surprises.
  const rating = raw?.rating;
  if (typeof rating !== 'number' || !Number.isInteger(rating)) return { ok: false };
  if (rating < 1 || rating > 5) return { ok: false };

  if (typeof raw?.text !== 'string') return { ok: false };
  const cleanedText = cleanUserString(raw.text);
  if (
    cleanedText.length < REVIEW_MIN_LENGTH ||
    cleanedText.length > REVIEW_MAX_LENGTH
  ) {
    return { ok: false };
  }

  let cleanedName: string | null = null;
  if (raw.displayName !== undefined && raw.displayName !== null) {
    if (typeof raw.displayName !== 'string') return { ok: false };
    cleanedName = cleanUserString(raw.displayName);
    if (cleanedName.length === 0) {
      cleanedName = null;
    } else if (cleanedName.length > REVIEW_NAME_MAX_LENGTH) {
      return { ok: false };
    }
  }

  return { ok: true, rating, text: cleanedText, displayName: cleanedName };
}
