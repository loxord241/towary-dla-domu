/**
 * Additive-migration invariants for migrations 033+.
 *
 * Migrations added after the final_* baseline sweep must stay ADDITIVE and
 * IDEMPOTENT: they may never attempt to rewrite the final_* baseline files
 * or earlier migrations' content, and every DDL statement must be safely
 * re-runnable (IF [NOT] EXISTS / plain REVOKE). These tests pin the newest
 * migrations so a future edit cannot silently break a re-run or a fresh
 * deploy on top of final_001 + final_002.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const stripComments = (sql: string): string => sql.replace(/^\s*--.*$/gm, '');

const ADDITIVE_MIGRATIONS: {
  file: string;
  idempotentMarkers: RegExp[];
}[] = [
  {
    // 033: REVOKE statements are idempotent by nature — pin that only
    // revokes exist (the per-table coverage is pinned in
    // catalog-revoke-migration.test.ts).
    file: 'database/migrations/033_revokes_catalog_write.sql',
    idempotentMarkers: [/revoke\s+insert,\s*update,\s*delete\s+on\s+table\s+public\./i],
  },
  {
    file: 'database/migrations/034_unique_liqpay_payment_id.sql',
    idempotentMarkers: [
      /create unique index concurrently if not exists/i,
      /drop index concurrently if exists/i,
    ],
  },
  {
    // 035: REVOKE statements are idempotent by nature — pin that only
    // revokes exist (the per-table coverage is pinned in
    // anon-dml-revoke-migration.test.ts).
    file: 'database/migrations/035_revoke_anon_dml_defense_in_depth.sql',
    idempotentMarkers: [
      /revoke\s+insert,\s*update,\s*delete,\s*trigger,\s*references\s+on\s+table\s+public\./i,
    ],
  },
  {
    // 043: FK redefinition — guarded DROP CONSTRAINT IF EXISTS + ADD
    // CONSTRAINT makes the pair rerunnable (cascade semantics themselves
    // are pinned in restock-fk-cascade.test.ts).
    file: 'database/migrations/043_restock_requests_fk_cascade.sql',
    idempotentMarkers: [
      /drop\s+constraint\s+if\s+exists\s+restock_requests_product_id_fkey/i,
      /on\s+delete\s+cascade/i,
    ],
  },
];

test('ADDITIVE: migrations 033+ exist', () => {
  for (const m of ADDITIVE_MIGRATIONS) {
    assert.ok(src(m.file).length > 0, `${m.file} must exist and be non-empty`);
  }
});

test('ADDITIVE: 033+ never reference or edit final_* migrations', () => {
  for (const m of ADDITIVE_MIGRATIONS) {
    const body = stripComments(src(m.file));
    assert.doesNotMatch(
      body,
      /final_/i,
      `${m.file}: final_* baselines must never be touched by additive migrations`
    );
  }
});

test('ADDITIVE: 033+ carry their idempotency markers', () => {
  for (const m of ADDITIVE_MIGRATIONS) {
    const body = stripComments(src(m.file));
    for (const marker of m.idempotentMarkers) {
      assert.match(
        body,
        marker,
        `${m.file}: expected idempotent statement matching ${marker}`
      );
    }
  }
});

test('ADDITIVE: 033+ contain no destructive schema changes', () => {
  for (const m of ADDITIVE_MIGRATIONS) {
    const body = stripComments(src(m.file));
    assert.doesNotMatch(
      body,
      /drop\s+(table|column)|alter\s+table\s+.*\s+drop\s+column|truncate\b/i,
      `${m.file}: additive migrations must not drop tables/columns or truncate`
    );
  }
});

test('ADDITIVE: 034 does not reuse the retired 017 index name', () => {
  const body = stripComments(src('database/migrations/034_unique_liqpay_payment_id.sql'));
  assert.doesNotMatch(
    body,
    /index\s+(if\s+not\s+exists\s+)?idx_orders_liqpay_payment_id\s/i,
    'the old non-unique index name must never be re-created'
  );
});
