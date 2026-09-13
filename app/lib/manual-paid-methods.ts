/**
 * Payment methods for MANUAL payment confirmation (owner 2026-09-13:
 * «люди можуть не довіряти сайтам і не платитимуть через LiqPay —
 * зателефонують і оплатять по телефону»). The checkout never sends these —
 * they are stamped by the admin mark-paid flow only.
 *
 * Whitelist rationale: free-text payment_method pollutes order history and
 * the Telegram digest; three canonical labels cover every real case.
 */

export const MANUAL_PAID_METHODS: readonly string[] = [
  'готівка при отриманні',
  'карткою (переказ за реквізитами)',
  'на рахунок (IBAN)',
];

export const DEFAULT_PAID_METHOD = MANUAL_PAID_METHODS[0]!;

export function isManualPaidMethod(value: unknown): value is string {
  return typeof value === 'string' && MANUAL_PAID_METHODS.includes(value);
}
