/**
 * Unit tests for LiqPay status → project payment_status mapping.
 *
 * Project model (migration 006 CHECK):
 *   unpaid | pending | paid | failed | refunded
 *
 * Mapping rules:
 *   success            → paid      (terminal)
 *   failure, error     → failed    (terminal)
 *   reversed           → refunded  (matches existing CHECK semantics)
 *   everything else
 *   (processing, 3ds_verify, otp_verify, wait_accept, wait_secure,
 *    prepared, hold_wait, cash_wait, invoices, unknown, garbage…) → pending
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { mapLiqPayStatus, isKnownLiqPayStatus } = await import(
  '../app/lib/payment/liqpay-status.ts'
);

test('STATUS: success maps to paid', () => {
  assert.equal(mapLiqPayStatus('success'), 'paid');
});

// LiqPay sandbox mode: a successful TEST payment is terminal status
// "sandbox" (docs: https://www.liqpay.ua/en/doc/api/testing — "Всі тестові
// платежі будуть мати статус sandbox - успішний тестовий платіж"). Real
// payments never carry this status; signature + amount/currency checks in
// the callback still gate everything.
test('STATUS: terminal sandbox status maps to paid', () => {
  assert.equal(mapLiqPayStatus('sandbox'), 'paid');
});

test('STATUS: failure and error map to failed', () => {
  assert.equal(mapLiqPayStatus('failure'), 'failed');
  assert.equal(mapLiqPayStatus('error'), 'failed');
});

test('STATUS: reversed maps to refunded', () => {
  assert.equal(mapLiqPayStatus('reversed'), 'refunded');
});

const INTERMEDIATE = [
  'processing',
  '3ds_verify',
  'otp_verify',
  'wait_accept',
  'wait_secure',
  'prepared',
  'hold_wait',
  'cash_wait',
];

test('STATUS: every non-final LiqPay status maps to pending', () => {
  for (const s of INTERMEDIATE) {
    assert.equal(mapLiqPayStatus(s), 'pending', `status ${s}`);
  }
});

test('STATUS: unknown/garbage/empty never produce a terminal state', () => {
  for (const s of ['subscribed', 'weird_new_status', '', null, undefined, 42, {}]) {
    assert.equal(mapLiqPayStatus(s), 'pending', `status ${String(s)}`);
  }
});

test('STATUS: isKnownLiqPayStatus distinguishes documented statuses for logging', () => {
  assert.equal(isKnownLiqPayStatus('success'), true);
  assert.equal(isKnownLiqPayStatus('hold_wait'), true);
  assert.equal(isKnownLiqPayStatus(''), false);
  assert.equal(isKnownLiqPayStatus('nope'), false);
  assert.equal(isKnownLiqPayStatus(null), false);
});

test('STATUS: callback path logs unknown statuses (policy stays unknown → pending)', () => {
  // The "unknown values are logged" promise is implemented at the callback
  // orchestration point (order-payment-update.ts), not silently dropped.
  const src = readFileSync(
    path.join(root, 'app/lib/payment/order-payment-update.ts'),
    'utf8'
  );
  assert.match(src, /isKnownLiqPayStatus/);
  assert.match(
    src,
    /if \(!isKnownLiqPayStatus\(payload\.status\)\) \{\n\s*console\.error\('liqpay\/callback: unknown status'/,
    'unknown provider statuses must reach the server log'
  );
  // …while the mapping policy itself is untouched (pending, never terminal).
  assert.equal(mapLiqPayStatus('brand_new_provider_status'), 'pending');
});
