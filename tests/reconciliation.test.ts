/**
 * READ-ONLY LiqPay ↔ DB reconciliation classifier.
 *
 * Pure-logic tests only: no Supabase, no network, no writes. Mirrors
 * liqpay-status.test.ts / payment-gateway-adapter.test.ts conventions.
 *
 * The classifier compares a DB orders row (liqpay bookkeeping columns from
 * migration 017) against a LiqPay Status API response (action=status,
 * version=3 — the production-verified contract) and deterministically maps
 * it to one orphan/diff case. It NEVER decides a fix; remediation is out of
 * scope by design (B1 interlock semantics respected).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyReconcileRow,
  findDuplicatePaymentIdGroups,
} = await import('../app/lib/payment/reconciliation.ts');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-08-27T12:00:00Z');

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    order_number: 'ORD-20260820-ABC123',
    liqpay_order_id: 'ORD-20260820-ABC123',
    liqpay_payment_id: 7_777_777,
    payment_status: 'paid',
    amount: '1050.50',
    currency: 'UAH',
    status: 'pending',
    expires_at: null as string | null,
    created_at: '2026-08-20T10:00:00Z',
    ...overrides,
  };
}

function providerOk(overrides: Record<string, unknown> = {}) {
  return {
    result: 'ok',
    status: 'success',
    order_id: 'ORD-20260820-ABC123',
    payment_id: 7_777_777,
    transaction_id: 7_777_777,
    amount: '1050.5', // same money as DB "1050.50" — normalization required
    currency: 'UAH',
    paytype: 'card',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. OK_OK
// ---------------------------------------------------------------------------

test('RECONCILE: OK_OK — paid + success, all identity fields agree', () => {
  const c = classifyReconcileRow(dbRow(), providerOk(), NOW);
  assert.equal(c, 'OK_OK');
});

test('RECONCILE: OK_OK — money normalization "1050.50" vs number 1050.5', () => {
  const c = classifyReconcileRow(
    dbRow({ amount: '1050.50' }),
    providerOk({ amount: 1050.5 }),
    NOW
  );
  assert.equal(c, 'OK_OK');
});

test('RECONCILE: OK_OK — sandbox status counts as terminal paid (docs semantics)', () => {
  const c = classifyReconcileRow(dbRow(), providerOk({ status: 'sandbox' }), NOW);
  assert.equal(c, 'OK_OK');
});

test('RECONCILE: OK_OK — failed/failure is a consistent terminal pair', () => {
  const c = classifyReconcileRow(
    dbRow({ payment_status: 'failed' }),
    providerOk({ status: 'failure' }),
    NOW
  );
  assert.equal(c, 'OK_OK');
});

test('RECONCILE: OK_OK — refunded/reversed is a consistent terminal pair', () => {
  const c = classifyReconcileRow(
    dbRow({ payment_status: 'refunded' }),
    providerOk({ status: 'reversed' }),
    NOW
  );
  assert.equal(c, 'OK_OK');
});

test('RECONCILE: OK_OK — in-flight pending/pending before expiry is normal', () => {
  const c = classifyReconcileRow(
    dbRow({
      payment_status: 'pending',
      expires_at: '2026-08-28T00:00:00Z',
    }),
    providerOk({ status: 'processing', amount: '1050.50' }),
    NOW
  );
  assert.equal(c, 'OK_OK');
});

// ---------------------------------------------------------------------------
// 2. PROVIDER_SUCCESS_DB_NOT_PAID
// ---------------------------------------------------------------------------

test('RECONCILE: provider success + DB pending → PROVIDER_SUCCESS_DB_NOT_PAID', () => {
  const c = classifyReconcileRow(
    dbRow({ payment_status: 'pending' }),
    providerOk(),
    NOW
  );
  assert.equal(c, 'PROVIDER_SUCCESS_DB_NOT_PAID');
});

test('RECONCILE: provider sandbox + DB unpaid → PROVIDER_SUCCESS_DB_NOT_PAID', () => {
  const c = classifyReconcileRow(
    dbRow({ payment_status: 'unpaid' }),
    providerOk({ status: 'sandbox' }),
    NOW
  );
  assert.equal(c, 'PROVIDER_SUCCESS_DB_NOT_PAID');
});

// B1 interlock semantics: late success after expiry-cancel stays classified
// as a discrepancy for MANUAL handling, never silently OK.
test('RECONCILE: provider success + DB cancelled → PROVIDER_SUCCESS_DB_NOT_PAID (manual)', () => {
  const c = classifyReconcileRow(
    dbRow({ status: 'cancelled', payment_status: 'pending' }),
    providerOk(),
    NOW
  );
  assert.equal(c, 'PROVIDER_SUCCESS_DB_NOT_PAID');
});

// ---------------------------------------------------------------------------
// 3. DB_PAID_PROVIDER_NOT_SUCCESS
// ---------------------------------------------------------------------------

test('RECONCILE: DB paid + provider processing → DB_PAID_PROVIDER_NOT_SUCCESS', () => {
  const c = classifyReconcileRow(
    dbRow(),
    providerOk({ status: 'processing' }),
    NOW
  );
  assert.equal(c, 'DB_PAID_PROVIDER_NOT_SUCCESS');
});

test('RECONCILE: DB paid + provider failure → DB_PAID_PROVIDER_NOT_SUCCESS', () => {
  const c = classifyReconcileRow(
    dbRow(),
    providerOk({ status: 'failure', amount: undefined }),
    NOW
  );
  assert.equal(c, 'DB_PAID_PROVIDER_NOT_SUCCESS');
});

// ---------------------------------------------------------------------------
// 4/5. Money mismatches (checked before state comparisons on paid claims)
// ---------------------------------------------------------------------------

test('RECONCILE: provider success amount differs → AMOUNT_MISMATCH', () => {
  const c = classifyReconcileRow(
    dbRow(),
    providerOk({ amount: 2050.5 }),
    NOW
  );
  assert.equal(c, 'AMOUNT_MISMATCH');
});

test('RECONCILE: provider success garbage amount → AMOUNT_MISMATCH (fail closed)', () => {
  const c = classifyReconcileRow(
    dbRow(),
    providerOk({ amount: 'abc' }),
    NOW
  );
  assert.equal(c, 'AMOUNT_MISMATCH');
});

test('RECONCILE: provider success currency differs → CURRENCY_MISMATCH', () => {
  const c = classifyReconcileRow(
    dbRow(),
    providerOk({ currency: 'USD' }),
    NOW
  );
  assert.equal(c, 'CURRENCY_MISMATCH');
});

test('RECONCILE: currency comparison is case-insensitive', () => {
  const c = classifyReconcileRow(
    dbRow({ currency: 'uah' }),
    providerOk({ currency: 'UAH' }),
    NOW
  );
  assert.equal(c, 'OK_OK');
});

// ---------------------------------------------------------------------------
// 6. PAID_MISSING_PAYMENT_ID
// ---------------------------------------------------------------------------

test('RECONCILE: DB paid without liqpay_payment_id → PAID_MISSING_PAYMENT_ID', () => {
  const c = classifyReconcileRow(
    dbRow({ liqpay_payment_id: null }),
    providerOk(),
    NOW
  );
  assert.equal(c, 'PAID_MISSING_PAYMENT_ID');
});

// ---------------------------------------------------------------------------
// 7. STALE_ATTEMPT — pending/cancelled attempt past its session lifetime;
// must NOT fire for a normal in-flight pending order.
// ---------------------------------------------------------------------------

test('RECONCILE: pending attempt with expired expires_at → STALE_ATTEMPT', () => {
  const c = classifyReconcileRow(
    dbRow({
      payment_status: 'pending',
      expires_at: '2026-08-21T00:00:00Z',
    }),
    providerOk({ status: 'processing', amount: '1050.50' }),
    NOW
  );
  assert.equal(c, 'STALE_ATTEMPT');
});

test('RECONCILE: cancelled order attempt (provider non-terminal) → STALE_ATTEMPT', () => {
  const c = classifyReconcileRow(
    dbRow({ status: 'cancelled', payment_status: 'pending' }),
    providerOk({ status: 'processing', amount: '1050.50' }),
    NOW
  );
  assert.equal(c, 'STALE_ATTEMPT');
});

test('RECONCILE: normal unexpired pending attempt is NOT stale', () => {
  const c = classifyReconcileRow(
    dbRow({
      payment_status: 'pending',
      expires_at: '2026-08-28T00:00:00Z',
    }),
    providerOk({ status: '3ds_verify', amount: '1050.50' }),
    NOW
  );
  assert.equal(c, 'OK_OK');
});

// ---------------------------------------------------------------------------
// 8. DUPLICATE_PAYMENT_ID — batch-level pass over fetched rows.
// ---------------------------------------------------------------------------

test('RECONCILE: duplicate liqpay_payment_id across rows is detected as a group', () => {
  const dupes = findDuplicatePaymentIdGroups([
    dbRow({ order_number: 'ORD-A' }),
    dbRow({ order_number: 'ORD-B' }),
    dbRow({ order_number: 'ORD-C', liqpay_payment_id: 888 }),
  ]);
  assert.deepEqual(dupes, [
    { liqpay_payment_id: 7_777_777, order_numbers: ['ORD-A', 'ORD-B'] },
  ]);
});

test('RECONCILE: no duplicates and nulls are not grouped', () => {
  const dupes = findDuplicatePaymentIdGroups([
    dbRow({ order_number: 'ORD-A', liqpay_payment_id: 1 }),
    dbRow({ order_number: 'ORD-B', liqpay_payment_id: 2 }),
    dbRow({ order_number: 'ORD-C', liqpay_payment_id: null }),
  ]);
  assert.deepEqual(dupes, []);
});

// ---------------------------------------------------------------------------
// 9. UNREACHABLE — retry-safe, NOT a payment error.
// ---------------------------------------------------------------------------

test('RECONCILE: missing provider response → UNREACHABLE', () => {
  const c = classifyReconcileRow(dbRow(), null, NOW);
  assert.equal(c, 'UNREACHABLE');
});

test('RECONCILE: provider result=error → UNREACHABLE (retry-safe)', () => {
  const c = classifyReconcileRow(
    dbRow(),
    { result: 'error', error_code: 'order_not_found' },
    NOW
  );
  assert.equal(c, 'UNREACHABLE');
});

test('RECONCILE: malformed provider payload → UNREACHABLE', () => {
  const c = classifyReconcileRow(
    dbRow(),
    { unexpected: true },
    NOW
  );
  assert.equal(c, 'UNREACHABLE');
});

// ---------------------------------------------------------------------------
// PROVIDER_NOT_FOUND vs UNREACHABLE — phase 2 refinement.
//
// Production evidence (read-only probes against the Status API, action=status):
//   - "not found":   HTTP 200, result="error",
//                    code/err_code="payment_not_found",
//                    err_description="Платіж не знайдено";
//   - other errors:  e.g. err_code="invalid_signature";
// i.e. a machine-readable err_code discriminates a COMPLETED lookup from an
// exchange that cannot be trusted. Semantics of NOT_FOUND: the API answered
// that no transaction exists for this order_id in the CURRENT merchant/key
// context — nothing more (no refund/no DB implications are implied).
// ---------------------------------------------------------------------------

test('RECONCILE: exact production "Платіж не знайдено" body → PROVIDER_NOT_FOUND', () => {
  const c = classifyReconcileRow(
    dbRow({
      payment_status: 'pending',
      liqpay_payment_id: null,
      status: 'cancelled',
    }),
    {
      code: 'payment_not_found',
      err_code: 'payment_not_found',
      err_description: 'Платіж не знайдено',
      result: 'error',
      status: 'error',
    },
    NOW
  );
  assert.equal(c, 'PROVIDER_NOT_FOUND');
});

test('RECONCILE: result=error WITHOUT payment_not_found code stays UNREACHABLE', () => {
  const c = classifyReconcileRow(
    dbRow(),
    {
      code: 'invalid_signature',
      err_code: 'invalid_signature',
      err_description: 'Невірний підпис signature',
      result: 'error',
      status: 'error',
    },
    NOW
  );
  assert.equal(c, 'UNREACHABLE');
});

test('RECONCILE: result=error with unknown/absent err_code → UNREACHABLE (fail closed)', () => {
  assert.equal(classifyReconcileRow(dbRow(), { result: 'error' }, NOW), 'UNREACHABLE');
  assert.equal(
    classifyReconcileRow(dbRow(), { result: 'error', err_code: 'something_new' }, NOW),
    'UNREACHABLE'
  );
});

test('RECONCILE: realistic found-success response → OK_OK', () => {
  const c = classifyReconcileRow(
    dbRow({ amount: '20', currency: 'UAH' }),
    providerOk({ amount: 20, currency: 'UAH' }),
    NOW
  );
  assert.equal(c, 'OK_OK');
});

// ---------------------------------------------------------------------------
// Priority sanity: reachability > money > identity > state > staleness.
// ---------------------------------------------------------------------------

test('RECONCILE: priority — money mismatch outranks missing payment id', () => {
  const c = classifyReconcileRow(
    dbRow({ liqpay_payment_id: null }),
    providerOk({ amount: 999 }),
    NOW
  );
  assert.equal(c, 'AMOUNT_MISMATCH');
});

test('RECONCILE: classifier is deterministic (same input twice)', () => {
  const row = dbRow();
  const p = providerOk();
  assert.equal(classifyReconcileRow(row, p, NOW), classifyReconcileRow(row, p, NOW));
});
