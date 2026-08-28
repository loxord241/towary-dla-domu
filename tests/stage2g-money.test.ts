/**
 * Stage 2G — money invariants of the delivery choice.
 *
 * Business rule: delivery is paid by the RECIPIENT (payerType=Recipient,
 * fixed server-side). The Nova Post delivery choice and its cost must
 * NEVER enter the order money: not orders.total_amount, not
 * shipping_total, not the checkout "До сплати" sum. These are source-level
 * invariants (same pattern as order-security.test.ts) because the money
 * paths live in SQL and route handlers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

test('MONEY-2G: place_order never reads or writes delivery cost fields', () => {
  const src006 = src('database/migrations/006_orders_checkout.sql');
  const placeOrder = src006.slice(
    src006.indexOf('create or replace function public.place_order')
  );
  assert.doesNotMatch(placeOrder, /delivery_cost/i);
  // shipping_total is written as the constant 0 (existing behavior) — it
  // must never carry a computed delivery cost.
  assert.match(placeOrder, /v_subtotal, 0,/);
  // shipping_info is stored verbatim as display data — no money extraction
  assert.doesNotMatch(placeOrder, /delivery->/);
});

test('MONEY-2G: orders route has no money path for delivery', () => {
  const route = src('app/api/orders/route.ts');
  assert.doesNotMatch(route, /shipping_total/);
  assert.doesNotMatch(route, /delivery_cost/i);
  assert.doesNotMatch(route, /payerType/);
  assert.doesNotMatch(route, /cod_amount/);
});

test('MONEY-2G: checkout does not add delivery cost to the payable total', () => {
  const form = src('app/checkout/CheckoutForm.tsx');
  // The payable row stays goods-only: subtotal, never a delivery addition
  assert.doesNotMatch(form, /delivery_cost/i);
  assert.doesNotMatch(form, /shipping_total/);
  assert.match(form, /за тарифами перевізника/);
});

test('MONEY-2G: payerType=Recipient is fixed server-side in the calculation lib', () => {
  const calc = src('app/lib/delivery/novapost/delivery-cost.ts');
  assert.match(calc, /payerType: 'Recipient'/);
  // payerType is a server constant, never parsed from the client body
  assert.match(calc, /Never accepted from the client/);
  assert.doesNotMatch(calc, /raw\.payerType/);
  assert.doesNotMatch(calc, /body\.payerType/);
});

test('MONEY-2G: TTN payload builder fixes payerType=Recipient', () => {
  const ttn = src('app/lib/admin-shipments-ttn.ts');
  assert.match(ttn, /payerType: 'Recipient'/);
});
