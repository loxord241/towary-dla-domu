/**
 * Migration 020 (shipment parcels + cross-order integrity) — static
 * invariants. Pins the composite-FK pinning, parcel contract (live Nova
 * Post units), audit CHECKs and the security model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = 'database/migrations/020_shipment_parcels_integrity.sql';
const sql = readFileSync(path.join(root, MIGRATION), 'utf8');
const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

test('PARCELS-020: cross-order integrity — composite FK pinning', () => {
  // parents get (order_id, id) unique targets
  assert.match(
    code,
    /create unique index if not exists uq_order_shipments_order_id_id\s+on order_shipments\(order_id, id\)/i
  );
  assert.match(
    code,
    /create unique index if not exists uq_order_items_order_id_id\s+on order_items\(order_id, id\)/i
  );
  // child carries its own order_id, backfilled then pinned NOT NULL
  assert.match(code, /add column if not exists order_id uuid/i);
  assert.match(code, /alter column order_id set not null/i);
  // composite FKs: link row valid only when order_id matches BOTH parents
  assert.match(
    code,
    /add constraint fk_order_shipment_items_shipment_order\s+foreign key \(shipment_id, order_id\)\s+references order_shipments\(order_id, id\)\s+on delete cascade/i
  );
  assert.match(
    code,
    /add constraint fk_order_shipment_items_item_order\s+foreign key \(order_item_id, order_id\)\s+references order_items\(order_id, id\)\s+on delete cascade/i
  );
  // migration refuses inconsistent pre-existing data instead of hiding it
  assert.match(code, /ORDER_SHIPMENT_ITEMS_CROSS_ORDER_DATA/);
});

test('PARCELS-020: audit CHECKs added (index positive, money non-negative)', () => {
  assert.match(code, /constraint chk_order_shipments_index check \(shipment_index > 0\)/);
  assert.match(code, /chk_order_shipments_volume_general\s+check \(volume_general >= 0\)/);
  assert.match(code, /chk_order_shipments_cost_of_goods\s+check \(cost_of_goods >= 0\)/);
  assert.match(code, /chk_order_shipments_delivery_cost\s+check \(delivery_cost >= 0\)/);
  assert.match(
    code,
    /chk_order_shipments_delivery_cost_estimated\s+check \(delivery_cost_estimated >= 0\)/
  );
});

test('PARCELS-020: parcel table structure matches the live NP contract', () => {
  assert.match(code, /create table if not exists order_shipment_parcels/i);
  assert.match(
    code,
    /shipment_id\s+uuid not null\s+references order_shipments\(id\) on delete cascade/i
  );
  // parcel_index: positive + unique per shipment (NP rowNumber)
  assert.match(code, /constraint chk_order_shipment_parcels_category/i);
  assert.match(code, /constraint uq_order_shipment_parcels_index\s+unique \(shipment_id, parcel_index\)/);
  // weight in GRAMS, multiple of 10 (live rounding rule)
  assert.match(
    code,
    /chk_order_shipment_parcels_weight\s+check \(actual_weight_grams > 0\s+and actual_weight_grams % 10 = 0\)/
  );
  // dimensions in MILLIMETERS, positive
  assert.match(code, /chk_order_shipment_parcels_width\s+check \(width_mm > 0\)/);
  assert.match(code, /chk_order_shipment_parcels_length\s+check \(length_mm > 0\)/);
  assert.match(code, /chk_order_shipment_parcels_height\s+check \(height_mm > 0\)/);
  // insurance_cost present, > 0, no defaults, no app derivation
  assert.match(code, /insurance_cost\s+numeric\(12, ?2\) not null/);
  assert.match(code, /chk_order_shipment_parcels_insurance\s+check \(insurance_cost > 0\)/);
  assert.doesNotMatch(code, /default\s+(?!now\(\)|uuid_generate_v4\('?\)?)/i);
});

test('PARCELS-020: cargo_category whitelist (live NP enum)', () => {
  const whitelist = code.match(
    /chk_order_shipment_parcels_category\s+check \(cargo_category in \(([\s\S]*?)\)\)/
  );
  assert.ok(whitelist, 'cargo_category CHECK missing');
  assert.ok(whitelist[1] !== undefined);
  for (const value of ['parcel', 'documents', 'pallet']) {
    assert.match(whitelist[1], new RegExp(`'${value}'`));
  }
  assert.ok(!/nova_poshta/i.test(whitelist[1]), 'no invented categories');
});

test('PARCELS-020: security model matches order_shipments (019)', () => {
  assert.match(code, /alter table order_shipment_parcels enable row level security/i);
  assert.match(code, /revoke all on order_shipment_parcels from anon, authenticated/i);
  assert.doesNotMatch(code, /create\s+policy/i);
});

test('PARCELS-020: no new business triggers; invariants untouched', () => {
  // only the conventions-level updated_at trigger may be created
  const triggers = code.match(/create trigger\s+(\w+)/g) ?? [];
  assert.deepEqual(
    triggers.map((t) => t.replace('create trigger ', '')),
    ['update_order_shipment_parcels_updated_at']
  );
  // allocation + money invariants live in 019 and must not be redefined here
  assert.doesNotMatch(code, /SHIPMENT_ITEM_OVERALLOCATED|COD_SUM_MISMATCH/);
  assert.doesNotMatch(code, /assert_shipment_items_allocation|assert_shipments_cod_sum/);
});

test('PARCELS-020: 019 legacy cargo fields preserved, marked non-authoritative', () => {
  assert.doesNotMatch(code, /drop column/i, '019 columns must not be removed');
  // the file must state that parcels are the authoritative NP source
  assert.match(
    sql,
    /order_shipment_parcels is the authoritative[\s\S]*physical-parameters source/i
  );
  assert.match(sql, /NOT synchronized/i);
});

test('PARCELS-020: scope guard — no payment/checkout/NP-client changes', () => {
  assert.doesNotMatch(code, /liqpay|place_order|admin_cancel_order|expire_pending_orders/i);
  assert.doesNotMatch(code, /alter table products|alter table orders\s+add/i);
  assert.doesNotMatch(code, /novaposhta\.ua|novapost\.com|NOVA_POST_API_KEY/i);
  // single transaction
  assert.match(code, /^begin;/m);
  assert.match(code, /^commit;/m);
});

test('PARCELS-020: 019 invariants remain intact (cross-file check)', () => {
  const m019 = readFileSync(
    path.join(root, 'database/migrations/019_order_shipments.sql'),
    'utf8'
  );
  assert.match(m019, /SHIPMENT_ITEM_OVERALLOCATED/);
  assert.match(m019, /COD_SUM_MISMATCH/);
  // cascade-deletion fix must stay: not-found branch returns NULL, no raise
  const allocFn = m019
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .match(
      /create or replace function public\.assert_shipment_items_allocation[\s\S]*?^\$\$;/m
    );
  assert.ok(allocFn);
  assert.match(allocFn[0], /if not found then\s+return null;/);
  assert.doesNotMatch(allocFn[0], /SHIPMENT_ITEM_ORDER_NOT_FOUND/);
});
