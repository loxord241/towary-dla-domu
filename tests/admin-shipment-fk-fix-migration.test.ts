/**
 * Migration 022 (composite FK order fix) — static invariants.
 *
 * Bug found live during stage 2D verification: migration 020 declared the
 * composite FKs with the referenced column list in the wrong order
 * (references order_shipments(order_id, id) instead of (id, order_id)).
 * FK column lists match BY POSITION, so the applied constraints actually
 * enforce order_id = shipment_id AND id = order_id — i.e. any correct
 * shipment-item row is REJECTED (verified in the sandbox: the correct pair
 * fails, the swapped pair passes). order_shipment_items was unwritable in
 * production (tables are empty, so nobody could notice until stage 2D).
 *
 * Fix: drop both FKs and re-add them with the referenced list (id, order_id)
 * — the unique indexes uq_..._order_id_id (order_id, id) cover that column
 * set regardless of order.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(
  path.join(root, 'database/migrations/022_fix_composite_fk_order.sql'),
  'utf8'
);
const code = sql.replace(/^\s*--.*$/gm, '');

test('SHIPMENTS-022: migration file exists and is 022', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('022_fix_composite_fk_order.sql'),
    `found: ${files.join(', ')}`
  );
});

test('SHIPMENTS-022: broken composite FKs are dropped and re-added correctly', () => {
  // drop the wrongly-ordered constraints
  assert.match(
    code,
    /drop constraint if exists fk_order_shipment_items_shipment_order/i
  );
  assert.match(
    code,
    /drop constraint if exists fk_order_shipment_items_item_order/i
  );
  // re-add with the referenced list (id, order_id): shipment_id ↔ id,
  // order_id ↔ order_id (positional matching, as verified live in sandbox)
  assert.match(
    code,
    /foreign key \(shipment_id, order_id\)\s*references order_shipments \(id, order_id\)/i
  );
  assert.match(
    code,
    /foreign key \(order_item_id, order_id\)\s*references order_items \(id, order_id\)/i
  );
  // both keep ON DELETE CASCADE (020 semantics preserved)
  const fk1 = code.match(/foreign key \(shipment_id, order_id\)[\s\S]*?on delete cascade/i);
  const fk2 = code.match(/foreign key \(order_item_id, order_id\)[\s\S]*?on delete cascade/i);
  assert.ok(fk1, 'shipment composite FK not found');
  assert.ok(fk2, 'item composite FK not found');
  // the wrong (order_id, id) referenced order must not appear in the fix
  assert.doesNotMatch(code, /references order_shipments \(order_id, id\)/i);
  assert.doesNotMatch(code, /references order_items \(order_id, id\)/i);
});

test('SHIPMENTS-022: no checkout/payment/Nova Post changes, no RLS policies', () => {
  assert.doesNotMatch(code, /liqpay|processLiqPay|place_order|admin_cancel_order|expire_pending_orders/i);
  assert.doesNotMatch(code, /novaposhta|api\.novapost/i);
  assert.doesNotMatch(code, /set\s+payment_status|set\s+total_amount/i);
  assert.doesNotMatch(code, /create\s+policy/i);
  assert.doesNotMatch(code, /alter table orders/i);
});
