/**
 * Migration 035 (anon DML revokes on import-staging + feedback) — static
 * invariants.
 *
 * 033 closed the write-grant gap on the catalog surface; the live audit
 * still showed anon/authenticated holding INSERT/UPDATE/DELETE on
 * yc_import_batches, yc_content_goods, yc_content_batches and feedback
 * (Supabase platform default privileges at table creation). With RLS
 * deny-all there is no exploitation path today, but a future RLS disable
 * or broad policy would silently expose these tables to anyone with a
 * publishable key. These tests pin the migration content so the
 * hardening cannot silently regress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/035_revoke_anon_dml_defense_in_depth.sql';

const TABLES = [
  'yc_import_batches',
  'yc_content_goods',
  'yc_content_batches',
  'feedback',
] as const;

const stripComments = (sql: string): string => sql.replace(/^\s*--.*$/gm, '');

test('ANON-DML-REVOKE: migration file exists', () => {
  const m = src(MIGRATION);
  assert.ok(m.length > 0, `${MIGRATION} must exist and be non-empty`);
});

test('ANON-DML-REVOKE: every table has INSERT/UPDATE/DELETE/TRIGGER/REFERENCES revoked from anon AND authenticated', () => {
  const m = src(MIGRATION);
  for (const table of TABLES) {
    assert.match(
      m,
      new RegExp(
        `revoke\\s+insert,\\s*update,\\s*delete,\\s*trigger,\\s*references\\s+on\\s+table\\s+(public\\.)?${table}\\s+from\\s+anon,\\s*authenticated`
      ),
      `missing REVOKE INSERT, UPDATE, DELETE, TRIGGER, REFERENCES for ${table}`
    );
  }
});

test('ANON-DML-REVOKE: SELECT is not revoked (reads stay RLS-governed)', () => {
  const m = stripComments(src(MIGRATION));
  assert.doesNotMatch(
    m,
    /revoke\s+(?:\w+,\s*)*select\b/i,
    'migration must not revoke SELECT'
  );
});

test('ANON-DML-REVOKE: grants nothing (no GRANT statements)', () => {
  const m = stripComments(src(MIGRATION));
  assert.doesNotMatch(m, /\bgrant\b/i, 'migration must contain no GRANT statements');
});

test('ANON-DML-REVOKE: only REVOKE statements (no other DDL/DML)', () => {
  const m = stripComments(src(MIGRATION));
  for (const line of m.split('\n')) {
    if (line.trim() === '') continue;
    assert.match(line, /^\s*revoke\s/i, `unexpected non-revoke statement: ${line.trim()}`);
  }
  assert.doesNotMatch(m, /insert\s+into|update\s+\w+\s+set|delete\s+from/i);
  assert.doesNotMatch(m, /alter\s+table|drop\s+table|create\s+(table|policy|index)/i);
});

test('ANON-DML-REVOKE: documents that it is applied manually (no DDL from code)', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /MANUALLY/i,
    'header must state explicitly that the owner applies this migration manually'
  );
});
