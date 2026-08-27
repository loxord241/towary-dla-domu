/**
 * READ-ONLY LiqPay ↔ DB reconciliation classifier.
 *
 * Pure module: no Supabase client, no network, no side effects. It reuses
 * the production money semantics (sameMoneyCents from order-payment-update)
 * and status mapping (liqpay-status) so reconciliation CANNOT drift from
 * what the live callback flow accepts as truth.
 *
 * Input pair:
 *   - a DB orders row projected to the migration-017 bookkeeping columns;
 *   - a LiqPay Status API response (action=status, version=3 — the same
 *     contract verified in scripts/tmp-verify-live-payment.ts), or null when
 *     the provider could not be reached.
 *
 * Classification priority (each later check only sees rows the earlier ones
 * did not classify):
 *   1. provider reachability / well-formedness  → UNREACHABLE (retry-safe,
 *      deliberately NOT a payment failure);
 *   2. money identity of a paid claim           → AMOUNT_MISMATCH,
 *                                                  CURRENCY_MISMATCH
 *      (mirrors callback flow: amount/currency are verified only on
 *      terminal claims; non-success statuses may omit them);
 *   3. payment identity                         → PAID_MISSING_PAYMENT_ID
 *   4. DB/payment state vs provider state       → PROVIDER_SUCCESS_DB_NOT_PAID,
 *                                                  DB_PAID_PROVIDER_NOT_SUCCESS,
 *                                                  consistent pairs → OK_OK;
 *   5. stale attempt lifetime                   → STALE_ATTEMPT.
 *
 * Anything inconsistent but not enumerated falls through to MANUAL_REVIEW —
 * an explicit "human must look" bucket rather than silently reporting OK.
 *
 * B1 interlock semantics respected by construction: cancelled+provider
 * success classifies to PROVIDER_SUCCESS_DB_NOT_PAID — reported for manual
 * remediation (refund via LiqPay dashboard), never auto-correctable here.
 */

import { mapLiqPayStatus } from './liqpay-status.ts';
import { sameMoneyCents } from './order-payment-update.ts';

export type ReconciliationCase =
  | 'OK_OK'
  | 'PROVIDER_SUCCESS_DB_NOT_PAID'
  | 'DB_PAID_PROVIDER_NOT_SUCCESS'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'PAID_MISSING_PAYMENT_ID'
  | 'STALE_ATTEMPT'
  | 'MANUAL_REVIEW'
  | 'UNREACHABLE'
  | 'DUPLICATE_PAYMENT_ID';

/** Projection of one orders row (migration 017 bookkeeping + money cols). */
export interface ReconcileRow {
  order_number: string;
  liqpay_order_id: string | null;
  liqpay_payment_id: number | string | null;
  payment_status: string;
  /** orders.total_amount projected under the neutral name `amount`. */
  amount: number | string;
  currency: string;
  /** Order lifecycle status (pending/cancelled/...). */
  status: string;
  expires_at: string | null;
  created_at?: string | null;
}

/**
 * Shape of LiqPay's action=status response. Fields arrive unvalidated:
 * the classifier treats anything malformed as UNREACHABLE, never as
 * evidence about payment state.
 */
export interface ProviderStatus {
  result?: unknown;
  status?: unknown;
  order_id?: unknown;
  payment_id?: unknown;
  transaction_id?: unknown;
  amount?: unknown;
  currency?: unknown;
  paytype?: unknown;
  [key: string]: unknown;
}

function isWellFormedProvider(p: ProviderStatus): boolean {
  // Structural minimum; status semantics are delegated to mapLiqPayStatus,
  // which intentionally maps undocumented statuses to non-terminal pending
  // so they can never assert money movement here.
  return p.result === 'ok' && typeof p.status === 'string' && p.status.length > 0;
}

function currencyEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

function isExpired(expiresAt: string | null, nowMs: number): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t < nowMs;
}

export function classifyReconcileRow(
  row: ReconcileRow,
  provider: ProviderStatus | null,
  nowMs: number = Date.now()
): Exclude<ReconciliationCase, 'DUPLICATE_PAYMENT_ID'> {
  // 1. Reachability first: no provider answer → say nothing about money.
  if (!provider || !isWellFormedProvider(provider)) return 'UNREACHABLE';

  const mapped = mapLiqPayStatus(provider.status);

  // 2. Money identity — only a PAID claim asserts real money moved, mirroring
  //    the callback flow's fail-closed verification of terminal claims.
  if (mapped === 'paid') {
    if (!sameMoneyCents(provider.amount ?? null, row.amount)) {
      return 'AMOUNT_MISMATCH';
    }
    if (!currencyEquals(provider.currency ?? null, row.currency)) {
      return 'CURRENCY_MISMATCH';
    }
  }

  // 3. Payment identity: a paid DB row without its transaction id breaks
  //    the accounting chain even when both sides agree on success.
  if (row.payment_status === 'paid') {
    if (row.liqpay_payment_id == null) return 'PAID_MISSING_PAYMENT_ID';
    if (mapped !== 'paid') return 'DB_PAID_PROVIDER_NOT_SUCCESS';
    return 'OK_OK';
  }

  // 4. DB/payment state vs provider claim.
  if (mapped === 'paid') return 'PROVIDER_SUCCESS_DB_NOT_PAID';
  if (
    row.payment_status === 'failed' &&
    mapped === 'failed' &&
    row.status !== 'cancelled'
  ) {
    return 'OK_OK';
  }
  if (row.payment_status === 'refunded' && mapped === 'refunded') return 'OK_OK';

  // 5. Stale attempt: session dead (expired or cancelled) with no provider
  //    success — informational; must not be confused with in-flight pending.
  const stale = isExpired(row.expires_at, nowMs) || row.status === 'cancelled';
  if (stale && (row.payment_status === 'pending' || row.payment_status === 'unpaid')) {
    return 'STALE_ATTEMPT';
  }

  // In-flight agreement: pending DB ↔ non-terminal provider before expiry.
  if (row.payment_status === 'pending' && mapped === 'pending' && !stale) {
    return 'OK_OK';
  }

  return 'MANUAL_REVIEW';
}

/**
 * Batch-level duplicate detection over fetched rows (SELECT-only; grouping
 * happens in memory because PostgREST exposes no GROUP BY/HAVING). Only
 * concrete ids participate — nulls mean "never paid", not a shared value.
 */
export function findDuplicatePaymentIdGroups(
  rows: ReconcileRow[]
): Array<{ liqpay_payment_id: number; order_numbers: string[] }> {
  const groups = new Map<number, string[]>();
  for (const r of rows) {
    if (r.liqpay_payment_id == null) continue;
    const id =
      typeof r.liqpay_payment_id === 'number'
        ? r.liqpay_payment_id
        : Number(r.liqpay_payment_id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const list = groups.get(id);
    if (list) list.push(r.order_number);
    else groups.set(id, [r.order_number]);
  }
  return [...groups.entries()]
    .filter(([, nums]) => nums.length > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([liqpay_payment_id, order_numbers]) => ({
      liqpay_payment_id,
      order_numbers: [...order_numbers].sort(),
    }));
}
