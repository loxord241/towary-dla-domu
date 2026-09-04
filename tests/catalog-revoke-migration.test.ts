/**
 * Migration 033 (catalog write revokes) — static invariants.
 *
 * Migration 014 revoked write grants on the order surface and 024 revoked
 * TRUNCATE schema-wide; 033 closes the remaining gap: anon/authenticated
 * must hold no INSERT/UPDATE/DELETE on the catalog tables (today the only
 * defense is RLS-with-no-policy, which silently fails on any future RLS
 * disable or broad policy). These tests pin the migration content so the
 * hardening cannot silently regress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/033_revokes_catalog_write.sql';

const CATALOG_TABLES = [
  'products',
  'product_variants',
  'product_images',
  'categories',
  'brands',
  'attributes',
  'attribute_values',
  'attribute_values_translations',
  'products_translations',
  'categories_translations',
  'brands_translations',
  'attributes_translations',
  'product_categories',
  'product_reviews',
  'store_announcements',
] as const;

const stripComments = (sql: string): string => sql.replace(/^\s*--.*$/gm, '');

test('CATALOG-REVOKE: migration file exists', () => {
  const m = src(MIGRATION);
  assert.ok(m.length > 0, `${MIGRATION} must exist and be non-empty`);
});

test('CATALOG-REVOKE: every catalog table has INSERT/UPDATE/DELETE revoked from anon AND authenticated', () => {
  const m = src(MIGRATION);
  for (const table of CATALOG_TABLES) {
    assert.match(
      m,
      new RegExp(
        `revoke\\s+insert,\\s*update,\\s*delete\\s+on\\s+table\\s+(public\\.)?${table}\\s+from\\s+anon,\\s*authenticated`
      ),
      `missing REVOKE INSERT, UPDATE, DELETE for ${table}`
    );
  }
});

test('CATALOG-REVOKE: grants nothing (no GRANT statements)', () => {
  const m = stripComments(src(MIGRATION));
  assert.doesNotMatch(m, /\bgrant\b/i, 'migration must contain no GRANT statements');
});

test('CATALOG-REVOKE: only REVOKE statements (no other DDL/DML)', () => {
  const m = stripComments(src(MIGRATION));
  // every non-empty statement line is a revoke
  for (const line of m.split('\n')) {
    if (line.trim() === '') continue;
    assert.match(line, /^\s*revoke\s/i, `unexpected non-revoke statement: ${line.trim()}`);
  }
  // no data writes, no schema edits
  assert.doesNotMatch(m, /insert\s+into|update\s+\w+\s+set|delete\s+from/i);
  assert.doesNotMatch(m, /alter\s+table|drop\s+table|create\s+(table|policy|index)/i);
});

test('CATALOG-REVOKE: does not edit final_* or earlier migrations 003..032', () => {
  const m = src(MIGRATION);
  // The migration must not reference or touch other migration files
  // (final_001, final_002, 003..032) in any executable statement.
  const body = stripComments(m);
  assert.doesNotMatch(body, /final_/i, 'must not touch final_* migrations');
  assert.doesNotMatch(
    body,
    /0(?:0[3-9]|1\d|2\d|3[0-2])_/,
    'must not reference earlier migrations 003..032'
  );
});
