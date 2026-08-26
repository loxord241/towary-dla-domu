/**
 * Migration 014 (orders P2 hardening) — static invariants.
 *
 * The audit (2026-08) proved anon reads on orders/order_items/customers are
 * currently denied ONLY by RLS-with-no-policy (invisible-table semantics):
 * the SELECT grant itself is still present, so a future RLS disable or an
 * overly broad policy would silently expose all PII. Migration 014 adds the
 * same belt-and-suspenders defense product_stock_history already has
 * (explicit REVOKE SELECT). These tests pin the migration content so the
 * hardening cannot silently regress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/014_orders_revoke_anon_select.sql';

test('ORDERS-REVOKE: migration file exists', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('014_orders_revoke_anon_select.sql'),
    `expected ${MIGRATION}; found: ${files.join(', ')}`
  );
});

test('ORDERS-REVOKE: revokes SELECT from anon AND authenticated on all three tables', () => {
  const m = src(MIGRATION);
  for (const table of ['orders', 'order_items', 'customers']) {
    assert.match(
      m,
      new RegExp(
        `revoke\\s+select\\s+on\\s+table\\s+(public\\.)?${table}\\s+from\\s+anon,\\s*authenticated`
      ),
      `missing REVOKE SELECT for ${table}`
    );
  }
});

test('ORDERS-REVOKE: does not touch grants that checkout depends on', () => {
  const m = src(MIGRATION);
  // place_order EXECUTE must stay granted to anon — it is the only write path.
  // Line-based check: no single statement line may combine revoke+place_order
  // (prose comments may mention both words in different sentences).
  for (const line of m.split('\n')) {
    if (!/^\s*--/.test(line)) {
      assert.ok(
        !(/revoke/i.test(line) && /place_order/i.test(line)),
        'must never revoke place_order execute'
      );
    }
  }
  // no policy DDL here — policies are out of scope for this hardening
  assert.doesNotMatch(m.replace(/^\s*--.*$/gm, ''), /create\s+policy/i);
  // idempotent-friendly: only revoke statements, no data writes
  assert.doesNotMatch(m.replace(/^\s*--.*$/gm, ''), /insert\s+into|update\s+\w+\s+set|delete\s+from/i);
});
