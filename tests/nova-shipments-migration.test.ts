/**
 * Migration 019 (order shipments model) — static invariants.
 *
 * Stage 1 of the Nova Post delivery integration: data structure only.
 * No NP API, no TTN creation, no tracking, no payment-flow changes.
 * These tests pin the migration content so the model cannot silently
 * regress on security (RLS/revokes) or on the money/allocation invariants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/019_order_shipments.sql';
const sql = src(MIGRATION);
// Strip comments so prose cannot satisfy assertions.
const code = sql.replace(/^\s*--.*$/gm, '');

test('SHIPMENTS-019: migration file exists and is 019', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('019_order_shipments.sql'),
    `expected ${MIGRATION}; found: ${files.join(', ')}`
  );
});

test('SHIPMENTS-019: model tables created with cascade FKs', () => {
  assert.match(code, /create table if not exists order_shipments/i);
  assert.match(code, /create table if not exists order_shipment_items/i);
  // shipment belongs to exactly one order; deleting the order cascades
  assert.match(
    code,
    /order_id\s+uuid not null references orders\(id\) on delete cascade/i
  );
  // items link shipments to order items; cascade both directions of cleanup
  assert.match(
    code,
    /shipment_id\s+uuid not null references order_shipments\(id\) on delete cascade/i
  );
  assert.match(
    code,
    /order_item_id\s+uuid not null references order_items\(id\) on delete cascade/i
  );
});

test('SHIPMENTS-019: one order to many shipments, TTN unique per shipment', () => {
  // (order_id, shipment_index) unique — a repeated shipment row is impossible
  assert.match(
    code,
    /constraint uq_order_shipments_order_index unique \(order_id, shipment_index\)/
  );
  // TTN identity belongs to at most one shipment (mirrors 017 liqpay pattern)
  assert.match(code, /uq_order_shipments_ttn_number[\s\S]*?where ttn_number is not null/i);
  assert.match(code, /uq_order_shipments_ttn_ref[\s\S]*?where ttn_ref is not null/i);
  assert.match(code, /ttn_number\s+text/);
  assert.match(code, /ttn_ref\s+text/);
});

test('SHIPMENTS-019: per-shipment money columns present', () => {
  assert.match(code, /cod_amount\s+numeric\(12, ?2\) not null/);
  assert.match(code, /constraint chk_order_shipments_cod_amount check \(cod_amount >= 0\)/);
  assert.match(code, /delivery_cost\s+numeric\(12, ?2\)/);
  assert.match(code, /delivery_cost_estimated\s+numeric\(12, ?2\)/);
});

test('SHIPMENTS-019: warehouse vs courier delivery modes enforced', () => {
  assert.match(
    code,
    /service_type\s+text not null/
  );
  const xor = code.match(/constraint chk_order_shipments_destination check \(([\s\S]*?)\),\n\n/);
  assert.ok(xor, 'destination XOR constraint missing');
  assert.ok(xor[1] !== undefined);
  // warehouse branch: a warehouse ref, never an address
  assert.match(xor[1], /service_type = 'nova_poshta_warehouse'/);
  assert.match(xor[1], /warehouse_ref is not null/);
  assert.match(xor[1], /address is null/);
  // courier branch: an address, never a warehouse ref
  assert.match(xor[1], /service_type = 'nova_poshta_courier'/);
  assert.match(xor[1], /address is not null/);
  assert.match(xor[1], /warehouse_ref is null/);
});

test('SHIPMENTS-019: shipment status independent of order status', () => {
  assert.match(code, /status\s+text not null default 'planned'/);
  for (const s of [
    'planned', 'created', 'rejected', 'in_transit', 'arrived',
    'delivered', 'received', 'refused', 'returned', 'cancelled',
  ]) {
    assert.match(code, new RegExp(`'${s}'`), `status '${s}' missing from CHECK`);
  }
});

test('SHIPMENTS-019: money invariant trigger (sum cod = total - prepayment)', () => {
  assert.match(code, /create or replace function public\.assert_shipments_cod_sum/i);
  assert.match(
    code,
    /create constraint trigger trg_shipments_cod_sum[\s\S]*?deferrable initially deferred[\s\S]*?execute function public\.assert_shipments_cod_sum/i
  );
  // invariant expression: expected = total_amount - prepayment_amount
  assert.match(code, /v_expected := v_total - v_prepaid;/);
  // invariant is dormant while prepayment is unknown (stage-2 activation)
  assert.match(code, /v_prepaid is null then\s+return null;/);
  // fail-closed with the same errcode convention as the rest of the project
  assert.match(code, /COD_SUM_MISMATCH/);
  assert.match(code, /errcode = 'P0409'/);
});

test('SHIPMENTS-019: allocation invariant trigger (no over-allocation)', () => {
  assert.match(code, /create or replace function public\.assert_shipment_items_allocation/i);
  assert.match(
    code,
    /create constraint trigger trg_shipment_items_allocation[\s\S]*?deferrable initially deferred[\s\S]*?execute function public\.assert_shipment_items_allocation/i
  );
  assert.match(code, /SHIPMENT_ITEM_OVERALLOCATED/);
  assert.match(code, /v_allocated > v_ordered/);
  assert.match(code, /constraint chk_order_shipment_items_quantity check \(quantity > 0\)/);
});

test('SHIPMENTS-019: cascade deletion must not be blocked by allocation trigger', () => {
  // Regression (post-audit fix): when order_shipment_items rows are deleted
  // via ON DELETE CASCADE, the parent order_item may already be gone inside
  // the same transaction. The trigger must return NULL in that branch —
  // raising there would abort every cascade delete (order → order_items →
  // order_shipment_items), contradicting the model's own FK semantics.
  const fn = code.match(
    /create or replace function public\.assert_shipment_items_allocation[\s\S]*?^\$\$;/m
  );
  assert.ok(fn, 'assert_shipment_items_allocation() body not found');
  assert.match(fn[0], /if not found then\s+return null;/);
  assert.doesNotMatch(fn[0], /SHIPMENT_ITEM_ORDER_NOT_FOUND/);
  // the over-allocation guard itself must remain fully intact
  assert.match(fn[0], /v_allocated > v_ordered/);
  assert.match(fn[0], /raise exception 'SHIPMENT_ITEM_OVERALLOCATED/);
  assert.match(fn[0], /errcode = 'P0409'/);
});

test('SHIPMENTS-019: cascade paths preserved (items cleanup, not prevented)', () => {
  // order_shipment_items must still die with both parents — the fix relies
  // on the cascade doing the cleanup, so the FKs must keep ON DELETE CASCADE.
  assert.match(
    code,
    /shipment_id\s+uuid not null references order_shipments\(id\) on delete cascade/i
  );
  assert.match(
    code,
    /order_item_id\s+uuid not null references order_items\(id\) on delete cascade/i
  );
  // sibling invariant (money) is untouched: its not-found branch (order being
  // deleted) already returned NULL before this fix and must continue to.
  const moneyFn = code.match(
    /create or replace function public\.assert_shipments_cod_sum[\s\S]*?^\$\$;/m
  );
  assert.ok(moneyFn, 'assert_shipments_cod_sum() body not found');
  assert.match(moneyFn[0], /if not found or v_prepaid is null then\s+return null;/);
  assert.match(moneyFn[0], /COD_SUM_MISMATCH/);
});

test('SHIPMENTS-019: RLS enabled with zero policies + explicit revokes', () => {
  assert.match(code, /alter table order_shipments enable row level security/i);
  assert.match(code, /alter table order_shipment_items enable row level security/i);
  // final_001 default-privilege footgun: new tables start world-readable —
  // belt-and-suspenders revoke (014/006 pattern) is mandatory here.
  assert.match(
    code,
    /revoke all on order_shipments from anon, authenticated/i
  );
  assert.match(
    code,
    /revoke all on order_shipment_items from anon, authenticated/i
  );
  // default deny: no policies may exist on the new tables
  assert.doesNotMatch(code, /create\s+policy/i);
});

test('SHIPMENTS-019: trigger functions executable by service_role only', () => {
  for (const fn of ['assert_shipments_cod_sum', 'assert_shipment_items_allocation']) {
    assert.match(
      code,
      new RegExp(`revoke execute on function public\\.${fn}\\(\\) from anon, authenticated`, 'i')
    );
    assert.match(
      code,
      new RegExp(`grant execute on function public\\.${fn}\\(\\) to service_role`, 'i')
    );
  }
});

test('SHIPMENTS-019: prepayment_amount added as nullable, never written', () => {
  assert.match(code, /add column if not exists prepayment_amount numeric\(12, ?2\)/);
  // no default written anywhere in this migration (stage 2 decision)
  assert.doesNotMatch(code, /prepayment_amount\s+numeric[^;]*default/i);
  assert.doesNotMatch(code, /set\s+prepayment_amount/i);
});

test('SHIPMENTS-019: stage-1 scope guard — no provider/API/payment changes', () => {
  // no Nova Post network integration
  assert.doesNotMatch(code, /novaposhta\.ua|api\.novaposhta|nova_poshta_api|NOVA_POSHTA_API_KEY/i);
  // no red-lined functions touched
  assert.doesNotMatch(code, /create or replace function public\.(place_order|admin_cancel_order|expire_pending_orders)/i);
  assert.doesNotMatch(code, /processLiqPay|liqpay/i);
  // no payment columns mutated
  assert.doesNotMatch(code, /set\s+payment_status|set\s+total_amount/i);
  // no product catalog weight/dimension fields added
  assert.doesNotMatch(code, /alter table products/i);
});
