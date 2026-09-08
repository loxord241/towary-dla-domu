/**
 * Migration 038 (Ukrposhta shipments) — static invariants.
 *
 * Adds the second carrier: order_shipments.carrier (default nova_poshta),
 * a carrier-agnostic destination XOR with the extended service_type
 * whitelist, and the re-created admin_replace_shipment_plan accepting
 * ukrposhta_warehouse plans with an optional carrier key. Nova Post
 * behavior is unchanged: existing rows backfill to 'nova_poshta', the
 * freeze/validation/grant guarantees of 021/026 are kept verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/038_ukrposhta_shipments.sql';
const sql = src(MIGRATION);
const code = sql.replace(/^\s*--.*$/gm, '');

test('SHIPMENTS-038: migration file exists as 038 and is transactional', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('038_ukrposhta_shipments.sql'),
    `expected ${MIGRATION}; found: ${files.filter((f) => f.startsWith('0')).join(', ')}`
  );
  assert.match(code, /^begin;/m);
  assert.match(code, /^commit;/m);
});

test('SHIPMENTS-038: carrier column added with nova_poshta backfill default + whitelist', () => {
  assert.match(
    code,
    /alter table order_shipments add column if not exists carrier\s+text not null default 'nova_poshta'/
  );
  assert.match(code, /chk_order_shipments_carrier/);
  assert.match(
    code,
    /check \(carrier in \('nova_poshta', 'ukrposhta'\)\)/
  );
});

test('SHIPMENTS-038: destination XOR is rebuilt carrier-agnostic with the extended whitelist', () => {
  // old hard-coded constraint is dropped first
  assert.match(
    code,
    /alter table order_shipments drop constraint if exists chk_order_shipments_destination/
  );
  const addMatch = code.match(
    /alter table order_shipments add constraint chk_order_shipments_destination check \(([\s\S]*?)\);/
  );
  assert.ok(addMatch, 'new destination constraint missing');
  const body = addMatch[1]!;
  // service_type whitelist includes all three modes
  assert.match(body, /'nova_poshta_warehouse'/);
  assert.match(body, /'nova_poshta_courier'/);
  assert.match(body, /'ukrposhta_warehouse'/);
  // the XOR itself references ONLY the destination columns — no service
  // type may re-enter the structural XOR
  const xorPart = body.slice(body.indexOf('(warehouse_ref is not null'));
  assert.match(xorPart, /warehouse_ref is not null and address is null/);
  assert.match(xorPart, /warehouse_ref is null and address is not null/);
  assert.doesNotMatch(xorPart, /service_type/);
});

test('SHIPMENTS-038: RPC re-created with the extended service_type whitelist', () => {
  assert.match(
    code,
    /create or replace function public\.admin_replace_shipment_plan\(/
  );
  assert.match(
    code,
    /'nova_poshta_warehouse', 'nova_poshta_courier', 'ukrposhta_warehouse'/
  );
});

test('SHIPMENTS-038: RPC validates the optional carrier key and pairs it with service_type', () => {
  assert.match(code, /coalesce\(v_sh ->> 'carrier', 'nova_poshta'\)/);
  assert.match(code, /v_carrier not in \('nova_poshta', 'ukrposhta'\)/);
  assert.match(code, /CARRIER_INVALID/);
  // pairing: ukrposhta carrier ⇔ ukrposhta_warehouse service
  assert.match(
    code,
    /\(v_carrier = 'ukrposhta'\) <> \(v_service_type = 'ukrposhta_warehouse'\)/
  );
});

test('SHIPMENTS-038: warehouse destination checks cover BOTH warehouse service types', () => {
  assert.match(
    code,
    /v_service_type in \('nova_poshta_warehouse', 'ukrposhta_warehouse'\)/
  );
  // the numeric id contract (city/warehouse refs) is kept for both
  assert.match(code, /\^\[0-9\]\{1,20\}\$/);
});

test('SHIPMENTS-038: RPC keeps freeze guard (planned-only, no TTN)', () => {
  assert.match(code, /status <> 'planned' or ttn_number is not null/);
});

test('SHIPMENTS-038: insert writes the carrier column with the documented default', () => {
  const insertMatch = code.match(
    /insert into order_shipments \(([\s\S]*?)\) values \(([\s\S]*?)\)\s*returning/
  );
  assert.ok(insertMatch, 'insert statement missing');
  assert.match(insertMatch[1]!, /carrier/);
  assert.match(insertMatch[2]!, /coalesce\(v_sh ->> 'carrier', 'nova_poshta'\)/);
});

test('SHIPMENTS-038: no ukrposhta courier mode is introduced', () => {
  assert.doesNotMatch(code, /ukrposhta_courier/);
});

test('SHIPMENTS-038: orders table and money model untouched', () => {
  assert.doesNotMatch(code, /alter table orders\b/);
  assert.doesNotMatch(code, /total_amount|shipping_total|prepayment_amount/);
});

test('SHIPMENTS-038: RPC grants unchanged (service_role only)', () => {
  assert.match(
    code,
    /revoke all on function public\.admin_replace_shipment_plan\(uuid, jsonb\) from public/
  );
  assert.match(
    code,
    /revoke execute on function public\.admin_replace_shipment_plan\(uuid, ?jsonb\) from anon, authenticated/
  );
  assert.match(
    code,
    /grant execute on function public\.admin_replace_shipment_plan\(uuid, ?jsonb\) to service_role/
  );
});

test('SHIPMENTS-038: header documents pre-check, verify and rollback paths', () => {
  assert.match(sql, /-- SAFETY \/ PRE-CHECK/);
  assert.match(sql, /VERIFY \(run AFTER applying\)/);
  assert.match(sql, /ROLLBACK \(restore the 019\/026 state\)/);
  // rollback restores the previous constraint shape
  assert.match(sql, /chk_order_shipments_destination check \(/);
});
