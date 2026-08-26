import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'database/migrations/016_product_categories.sql'),
  'utf8'
);

test('MIGRATION-016: creates junction with composite PK', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS product_categories/i);
  assert.match(
    sql,
    /PRIMARY KEY\s*\(\s*product_id,\s*category_id\s*\)/i
  );
});

test('MIGRATION-016: FKs to products and categories are ON DELETE CASCADE', () => {
  const fks =
    sql.match(
      /REFERENCES\s+(products|categories)\s*\(\s*id\s*\)\s+ON DELETE CASCADE/gi
    ) ?? [];
  assert.equal(fks.length, 2);
});

test('MIGRATION-016: category_id index exists', () => {
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_product_categories_category_id\s+ON product_categories\(category_id\)/i
  );
});

test('MIGRATION-016: RLS enabled with explicit SELECT-only policy', () => {
  assert.match(sql, /ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /FOR SELECT/i);
  assert.match(sql, /is_active\s*=\s*(TRUE|true)/i);
  // No INSERT/UPDATE/DELETE policies — writes go through service role only.
  assert.doesNotMatch(sql, /FOR (INSERT|UPDATE|DELETE)/i);
});

test('MIGRATION-016: contains NO data writes (backfill is a separate op)', () => {
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
});
