/**
 * LiqPay status mapping for the project's payment model.
 *
 * The project model (orders.payment_status, migration 006 CHECK) is:
 *   unpaid | pending | paid | failed | refunded
 *
 * Mapping policy — only LiqPay TERMINAL statuses ever move the order out of
 * `pending`:
 *   success        → paid      (terminal; guarded downstream as idempotent)
 *   sandbox        → paid      (terminal; a successful TEST payment — docs
 *                              /en/doc/api/testing: "успішний тестовий
 *                              платіж". Only occurs with sandbox keys /
 *                              sandbox=1 payload, still signature-verified
 *                              and amount/currency-checked downstream)
 *   failure, error → failed    (terminal)
 *   reversed       → refunded  (exists in CHECK; semantic match: payment
 *                              reversed after settlement)
 * Everything else (processing, 3ds_verify, otp_verify, wait_accept,
 * wait_secure, prepared, hold_wait, cash_wait, …and anything new LiqPay may
 * add) maps to `pending` — never to a terminal state by default.
 */

export type PaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed' | 'refunded';

const FINAL_PAID = new Set(['success', 'sandbox']);
const FINAL_FAILED = new Set(['failure', 'error']);
const FINAL_REFUNDED = new Set(['reversed']);

const KNOWN_NON_FINAL = new Set([
  'processing',
  '3ds_verify',
  'otp_verify',
  'wait_accept',
  'wait_secure',
  'prepared',
  'hold_wait',
  'cash_wait',
]);

export function mapLiqPayStatus(status: unknown): PaymentStatus {
  const s = typeof status === 'string' ? status : '';
  if (FINAL_PAID.has(s)) return 'paid';
  if (FINAL_FAILED.has(s)) return 'failed';
  if (FINAL_REFUNDED.has(s)) return 'refunded';
  return 'pending';
}

/** True only for statuses documented by LiqPay — unknown values are logged. */
export function isKnownLiqPayStatus(status: unknown): boolean {
  return (
    FINAL_PAID.has(typeof status === 'string' ? status : '') ||
    FINAL_FAILED.has(typeof status === 'string' ? status : '') ||
    FINAL_REFUNDED.has(typeof status === 'string' ? status : '') ||
    isKnownNonFinalLiqPayStatus(status)
  );
}

export function isKnownNonFinalLiqPayStatus(status: unknown): boolean {
  return typeof status === 'string' && KNOWN_NON_FINAL.has(status);
}
