/**
 * Migration 021 (admin shipment planning RPC) — static invariants.
 *
 * Stage 2D: the ONLY writer of order_shipments/order_shipment_items/
 * order_shipment_parcels is the atomic RPC admin_replace_shipment_plan
 * (replace-all plan in one transaction, so the DEFERRABLE COD/allocation
 * triggers evaluate the final state at commit). These tests pin the
 * security model, the locking/guard behavior and the validation rules.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/021_admin_shipment_planning.sql';
const sql = src(MIGRATION);
// Strip comments so prose cannot satisfy assertions.
const code = sql.replace(/^\s*--.*$/gm, '');

const fn = code.match(
  /create or replace function public\.admin_replace_shipment_plan[\s\S]*?^\$\$;/m
);
const fnBody = fn ? fn[0] : '';

test('SHIPMENTS-021: migration file exists and is 021', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('021_admin_shipment_planning.sql'),
    `expected ${MIGRATION}; found: ${files.join(', ')}`
  );
});

test('SHIPMENTS-021: atomic replace-all RPC exists, security definer', () => {
  assert.match(code, /create or replace function public\.admin_replace_shipment_plan/i);
  assert.match(code, /security definer/i);
  assert.match(fnBody, /set search_path = public/i);
});

test('SHIPMENTS-021: RPC executable by service_role only', () => {
  assert.match(code, /revoke all on function public\.admin_replace_shipment_plan\(uuid, jsonb\) from public/i);
  assert.match(code, /revoke execute on function public\.admin_replace_shipment_plan\(uuid, jsonb\) from anon, authenticated/i);
  assert.match(code, /grant execute on function public\.admin_replace_shipment_plan\(uuid, jsonb\) to service_role/i);
});

test('SHIPMENTS-021: guards — order lock, not found, closed order, planned-only', () => {
  // serialize concurrent plan saves per order
  assert.match(fnBody, /for update/);
  assert.match(fnBody, /ORDER_NOT_FOUND/);
  assert.match(fnBody, /P0404/);
  // cancelled/returned orders must not be re-planned
  assert.match(fnBody, /ORDER_CLOSED/);
  assert.match(fnBody, /'cancelled'/);
  assert.match(fnBody, /'returned'/);
  // shipments past 'planned' (TTN flow) are frozen
  assert.match(fnBody, /SHIPMENTS_LOCKED/);
  assert.match(fnBody, /status <> 'planned'|ttn_number is not null/);
});

test('SHIPMENTS-021: validation mirrors 019/020 constraints', () => {
  // service_type whitelist (destination XOR enforced against DB check anyway)
  assert.match(fnBody, /nova_poshta_warehouse/);
  assert.match(fnBody, /nova_poshta_courier/);
  // destination XOR
  assert.match(fnBody, /DESTINATION_REQUIRED/);
  // cod_amount >= 0
  assert.match(fnBody, /COD_AMOUNT_INVALID/);
  // items: uuid + positive integer quantity
  assert.match(fnBody, /ITEM_INVALID/);
  // parcels: 10 g rounding rule + positive dims + insurance > 0
  assert.match(fnBody, /WEIGHT_INVALID/);
  assert.match(fnBody, /DIMENSION_INVALID/);
  assert.match(fnBody, /INSURANCE_INVALID/);
  assert.match(fnBody, /CARGO_CATEGORY_INVALID/);
  // items must belong to the order (belt for the composite FK suspenders)
  assert.match(fnBody, /ITEM_NOT_IN_ORDER/);
});

test('SHIPMENTS-021: replace-all — deletes planned shipments then recreates', () => {
  assert.match(fnBody, /delete from order_shipments\s+where order_id = p_order_id/i);
  assert.match(fnBody, /insert into order_shipments/i);
  assert.match(fnBody, /insert into order_shipment_items/i);
  assert.match(fnBody, /insert into order_shipment_parcels/i);
  // never writes TTN or provider state
  assert.doesNotMatch(fnBody, /ttn_number\s*(:?=|,|\))/i);
  assert.doesNotMatch(fnBody, /status\s*:=\s*'created'/i);
  // inserted shipments are always 'planned'
  assert.match(fnBody, /'planned'/);
});

test('SHIPMENTS-021: scope guard — no provider/payment/checkout changes', () => {
  assert.doesNotMatch(code, /novaposhta\.ua|api\.novapost|api\.novaposhta|NOVA_POST_API_KEY/i);
  assert.doesNotMatch(code, /create or replace function public\.(place_order|admin_cancel_order|expire_pending_orders|admin_set_order_status)/i);
  assert.doesNotMatch(code, /liqpay|processLiqPay/i);
  assert.doesNotMatch(code, /set\s+payment_status|set\s+total_amount|alter table orders/i);
  assert.doesNotMatch(code, /alter table order_shipment_items\s|alter table order_shipment_parcels\s/i);
  assert.doesNotMatch(code, /create\s+policy/i);
});
