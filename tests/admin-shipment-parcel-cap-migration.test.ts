/**
 * Migration 023 (shipment plan parcels cap 50 → 10) — static invariants.
 *
 * The live Nova Post calculation parser (app/lib/delivery/novapost/
 * delivery-cost.ts) caps parcels[] at 10. To keep 2D plans inside the
 * verified live envelope, the replace-all RPC must enforce the same cap.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(
  path.join(root, 'database/migrations/023_shipment_plan_parcel_cap.sql'),
  'utf8'
);
const code = sql.replace(/^\s*--.*$/gm, '');

test('SHIPMENTS-023: migration file exists and is 023', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('023_shipment_plan_parcel_cap.sql'),
    `found: ${files.join(', ')}`
  );
});

test('SHIPMENTS-023: RPC replaced with parcels cap 10', () => {
  assert.match(code, /create or replace function public\.admin_replace_shipment_plan/i);
  assert.match(code, /jsonb_array_length\(v_parcels\) > 10/);
  assert.match(code, /max 10/);
  // the old cap must be gone
  assert.doesNotMatch(code, /jsonb_array_length\(v_parcels\) > 50/);
  assert.doesNotMatch(code, /\(max 50\)/);
});

test('SHIPMENTS-023: RPC contract and security model unchanged', () => {
  assert.match(code, /security definer/i);
  assert.match(code, /revoke execute on function public\.admin_replace_shipment_plan\(uuid, jsonb\) from anon, authenticated/i);
  assert.match(code, /grant execute on function public\.admin_replace_shipment_plan\(uuid, jsonb\) to service_role/i);
  assert.match(code, /SHIPMENTS_LOCKED/);
  assert.match(code, /delete from order_shipments\s+where order_id = p_order_id/i);
  // still no TTN writes
  assert.doesNotMatch(code, /ttn_number\s*(:?=|,|\))/i);
});

test('SHIPMENTS-023: scope guard — no schema/payment/provider changes', () => {
  assert.doesNotMatch(code, /liqpay|place_order|admin_cancel_order|expire_pending_orders/i);
  assert.doesNotMatch(code, /novaposhta\.ua|api\.novapost/i);
  assert.doesNotMatch(code, /alter table|create\s+policy/i);
});
