/**
 * Pure cancellation decision for the admin orders flow (B2 paid-order
 * interlock). The authoritative guards are the server-side pre-RPC check in
 * PATCH /api/admin/orders/[id] and the DB-level guard inside
 * admin_cancel_order() (migration 018); this module centralizes the rule.
 *
 * Rule: an order whose money has been captured (payment_status = 'paid')
 * must never be cancelled through the plain admin flow — stock would be
 * restored while the customer stays charged. Cancellation after a refund
 * ('refunded') remains legitimate: the money has already been returned.
 */
export type CancellationDecision =
  | { allowed: true }
  | { allowed: false; reason: 'paid' };

export function decideAdminCancellation(order: {
  status?: string | null;
  payment_status?: string | null;
}): CancellationDecision {
  if (order.payment_status === 'paid') return { allowed: false, reason: 'paid' };
  return { allowed: true };
}

/** Operator-facing message for a rejected cancellation (no internals). */
export const PAID_CANCEL_REJECTION_MESSAGE =
  'Оплачене замовлення не можна скасувати — спочатку оформіть повернення коштів (refund)';
