/**
 * Pure validation for anonymous feedback messages. The ONLY user datum is
 * the message text — no name, email, IP or user-agent is collected.
 */

export const FEEDBACK_MIN_LENGTH = 10;
export const FEEDBACK_MAX_LENGTH = 1000;

/**
 * Shared, multi-instance-safe daily flood cap. Counted over the feedback
 * table's created_at only — no user identifier is involved (per-IP abuse
 * stays on the transient in-memory limiter, which never persists anything).
 */
export const FEEDBACK_DAILY_CAP = 100;

/** Control characters (except \n \r \t) that have no place in user text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export type FeedbackValidation =
  | { ok: true; text: string }
  | { ok: false };

export function validateFeedbackMessage(raw: unknown): FeedbackValidation {
  if (typeof raw !== 'string') return { ok: false };
  const cleaned = raw.replace(CONTROL_CHARS, '').trim();
  if (cleaned.length < FEEDBACK_MIN_LENGTH) return { ok: false };
  if (cleaned.length > FEEDBACK_MAX_LENGTH) return { ok: false };
  return { ok: true, text: cleaned };
}
