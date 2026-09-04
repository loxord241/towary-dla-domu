/**
 * Migration 034 invariants: unique partial index on orders.liqpay_payment_id.
 * Static characterization tests — read-only, no I/O.
 *
 * One LiqPay transaction id must map to at most one order. Migration 017
 * shipped only a NON-unique partial index; 034 upgrades it to unique
 * (concurrently, without reusing the old name) after a live-duplicate
 * audit came back clean (2026-09-04).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'database/migrations/034_unique_liqpay_payment_id.sql'),
  'utf8'
);

test('MIGRATION-034: creates the UNIQUE partial index idempotently', () => {
  assert.match(
    sql,
    /create unique index concurrently if not exists idx_orders_liqpay_payment_id_unique/i
  );
  assert.match(
    sql,
    /on\s+(public\.)?orders\(liqpay_payment_id\)\s+where\s+liqpay_payment_id\s+is\s+not\s+null/i
  );
});

test('MIGRATION-034: builds CONCURRENTLY (no begin/commit wrapper)', () => {
  assert.match(sql, /create unique index concurrently/i);
  // CONCURRENTLY cannot run inside a transaction block.
  assert.doesNotMatch(sql, /^\s*begin\s*;/im);
  assert.doesNotMatch(sql, /^\s*commit\s*;/im);
});

test('MIGRATION-034: drops the old 017 non-unique index, does NOT reuse its name', () => {
  assert.match(
    sql,
    /drop\s+index\s+concurrently\s+if\s+exists\s+(public\.)?idx_orders_liqpay_payment_id\s*;/i
  );
  // The unique index must carry the _unique suffix, never the bare old name.
  assert.doesNotMatch(sql, /index\s+idx_orders_liqpay_payment_id\s/i);
});

test('MIGRATION-034: additive-only — does not edit 017 in place', () => {
  // 017 file must stay untouched by this migration's approach: 034 never
  // rewrites the 017 statements, it only adds/drops indexes of its own.
  assert.doesNotMatch(sql, /alter table/i);
  assert.doesNotMatch(sql, /add column/i);
  assert.doesNotMatch(sql, /create or replace/i);
  assert.doesNotMatch(sql, /grant|revoke/i);
});

test('MIGRATION-034: no data writes (DML-free), no RLS changes', () => {
  assert.doesNotMatch(sql, /insert\s+into|update\s+\w+\s+set|delete\s+from/i);
  assert.doesNotMatch(sql, /disable row level security|enable row level security/i);
});
