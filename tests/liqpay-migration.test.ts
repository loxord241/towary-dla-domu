/**
 * Migration 017 invariants: LiqPay payment columns + paid-order expiration
 * regression fix (expire_pending_orders must NOT cancel paid orders).
 * Static characterization tests — read-only, no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'database/migrations/017_liqpay_payments.sql'),
  'utf8'
);

// ---- LiqPay columns ----

test('MIGRATION-017: adds the five minimal payment columns idempotently', () => {
  assert.match(sql, /add column if not exists liqpay_payment_id bigint/i);
  assert.match(sql, /add column if not exists liqpay_order_id text/i);
  assert.match(sql, /add column if not exists paid_at timestamptz/i);
  assert.match(sql, /add column if not exists payment_method text/i);
  assert.match(sql, /add column if not exists payment_error text/i);
});

test('MIGRATION-017: does NOT store raw provider payloads or URLs', () => {
  // Deliberate non-goals: raw response JSON, payment_url,
  // redundant transaction duplicates.
  for (const bad of [
    /payment_response/i,
    /payment_url/i,
    /payment_transaction_id/i,
    /raw_callback/i,
    /\bjsonb\b.*column/i,
  ]) {
    assert.doesNotMatch(sql, bad);
  }
});

test('MIGRATION-017: unique partial index on liqpay_order_id + payment_id index', () => {
  assert.match(
    sql,
    /create unique index if not exists idx_orders_liqpay_order_id\s+on orders\(liqpay_order_id\)\s+where liqpay_order_id is not null/i
  );
  assert.match(
    sql,
    /create index if not exists idx_orders_liqpay_payment_id\s+on orders\(liqpay_payment_id\)\s+where liqpay_payment_id is not null/i
  );
});

// ---- expiration regression fix ----

test('MIGRATION-017: expire_pending_orders excludes paid orders from candidates', () => {
  const candidateBlock = sql.slice(
    sql.indexOf('expire_pending_orders'),
    sql.indexOf('foreach')
  );
  assert.ok(candidateBlock.length > 0, 'candidate SELECT block must exist');
  assert.match(candidateBlock, /payment_status is distinct from 'paid'/i);
});

test('MIGRATION-017: expire rewrite keeps SKIP LOCKED and admin_cancel_order reuse', () => {
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /admin_cancel_order/i);
});

// ---- safety of surrounding DDL ----

test('MIGRATION-017: no RLS weakening, no anon/authenticated table grants', () => {
  assert.doesNotMatch(
    sql,
    /grant\s+[^;]*\bon\s+(table\s+)?orders\s+to\s+(anon|authenticated)/i
  );
  assert.doesNotMatch(sql, /disable row level security/i);
});

test('MIGRATION-017: contains NO data writes (DML-free)', () => {
  assert.doesNotMatch(sql, /\binsert\s+into\b/i);
  assert.doesNotMatch(sql, /\bupdate\s+orders\s+set\b/i);
});

test('MIGRATION-017: expires_at behavior unchanged for unpaid pending orders', () => {
  // The fix must ONLY add the paid exclusion — status/expires_at predicates
  // stay intact.
  const candidateBlock = sql.slice(
    sql.indexOf("status = 'pending'"),
    sql.indexOf('foreach')
  );
  assert.match(candidateBlock, /expires_at is not null/i);
  assert.match(candidateBlock, /expires_at < now\(\)/i);
});
