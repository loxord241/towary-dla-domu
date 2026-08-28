/**
 * Migration 026 (courier structured address) — static invariants.
 *
 * Stage 2G: structured courier destination on order_shipments
 * (street_name / building / flat), so the Nova Post payload can be built
 * without parsing a free-text `address` string. `address` stays as the
 * display/compat field. city_ref/warehouse_ref keep their roles
 * (settlementId / divisionId as numeric text) — no new integer columns.
 *
 * The admin_replace_shipment_plan RPC (021) is extended minimally: it
 * accepts optional street_name/building/flat for courier shipments and
 * rejects them for warehouse ones; all existing freeze/validation
 * guarantees stay untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/026_shipment_courier_address.sql';
const sql = src(MIGRATION);
const code = sql.replace(/^\s*--.*$/gm, '');

test('SHIPMENTS-026: migration file exists as 026', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('026_shipment_courier_address.sql'),
    `expected ${MIGRATION}; found: ${files.filter((f) => f.startsWith('0')).join(', ')}`
  );
});

test('SHIPMENTS-026: structured courier address columns added', () => {
  assert.match(code, /alter table order_shipments add column if not exists street_name text/);
  assert.match(code, /alter table order_shipments add column if not exists building text/);
  assert.match(code, /alter table order_shipments add column if not exists flat text/);
});

test('SHIPMENTS-026: no new integer city/division columns', () => {
  assert.doesNotMatch(code, /add column if not exists settlement_id/i);
  assert.doesNotMatch(code, /add column if not exists division_id/i);
  assert.doesNotMatch(code, /add column if not exists city_id/i);
});

test('SHIPMENTS-026: orders money columns untouched', () => {
  assert.doesNotMatch(code, /alter table orders/i);
  assert.doesNotMatch(code, /total_amount/);
  assert.doesNotMatch(code, /shipping_total/);
});

test('SHIPMENTS-026: RPC re-created (replace) with courier address fields', () => {
  assert.match(
    code,
    /create or replace function public\.admin_replace_shipment_plan\(/
  );
  // inserts the structured courier columns
  assert.match(code, /street_name/);
  assert.match(code, /building/);
  assert.match(code, /flat/);
});

test('SHIPMENTS-026: RPC keeps freeze guard (planned-only, no TTN)', () => {
  assert.match(
    code,
    /status <> 'planned' or ttn_number is not null/
  );
});

test('SHIPMENTS-026: RPC keeps destination XOR and city_ref numeric validation', () => {
  assert.match(code, /nova_poshta_warehouse/);
  assert.match(code, /nova_poshta_courier/);
  assert.match(code, /\^\[0-9\]\{1,20\}\$/);
});

test('SHIPMENTS-026: courier structured address must not leak into warehouse rows', () => {
  // warehouse branch must reject structured courier address fields
  const courierGuard = code.match(
    /if v_sh ->> 'service_type' = 'nova_poshta_warehouse' then([\s\S]*?)else/
  );
  assert.ok(courierGuard, 'warehouse/courier branch structure missing');
  assert.match(courierGuard[1], /street_name/);
  assert.match(courierGuard[1], /building/);
});

test('SHIPMENTS-026: RPC grants unchanged (service_role only)', () => {
  assert.match(
    code,
    /revoke execute on function public\.admin_replace_shipment_plan\(uuid, ?jsonb\) from anon, authenticated/
  );
  assert.match(
    code,
    /grant execute on function public\.admin_replace_shipment_plan\(uuid, ?jsonb\) to service_role/
  );
});
