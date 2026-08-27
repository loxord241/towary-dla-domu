/**
 * Migration 024 (TRUNCATE grant hardening) — static invariants.
 *
 * The 2026-08-27 live audit proved anon AND authenticated hold TRUNCATE on
 * every public table (orders, admin_users, feedback, products, ...). TRUNCATE
 * bypasses RLS entirely (it is not a row-level operation), so the
 * "RLS enabled + no policies" defense that blocks anon writes does NOT
 * protect against it. Migration 024 revokes TRUNCATE from anon/authenticated
 * across the whole public schema while leaving service_role/postgres intact.
 * These tests pin the migration content so the hardening cannot silently
 * regress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/024_revoke_truncate_anon_authenticated.sql';

test('TRUNCATE-REVOKE: migration file exists', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('024_revoke_truncate_anon_authenticated.sql'),
    `expected ${MIGRATION}; found: ${files.join(', ')}`
  );
});

test('TRUNCATE-REVOKE: revokes TRUNCATE from anon AND authenticated schema-wide', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /revoke\s+truncate\s+on\s+all\s+tables\s+in\s+schema\s+public\s+from\s+anon,\s*authenticated/,
    'missing schema-wide REVOKE TRUNCATE from anon, authenticated'
  );
});

test('TRUNCATE-REVOKE: never touches service_role or postgres grants', () => {
  const statements = src(MIGRATION)
    .replace(/^\s*--.*$/gm, '') // strip prose comments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    assert.ok(
      !/service_role|postgres/i.test(stmt),
      `statement must not mention privileged roles: ${stmt}`
    );
  }
  assert.ok(statements.length >= 1, 'migration must contain statements');
});

test('TRUNCATE-REVOKE: is revoke-only (no DDL/policy/data changes)', () => {
  const code = src(MIGRATION).replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(code, /create\s+policy/i);
  assert.doesNotMatch(code, /grant\s+/i);
  assert.doesNotMatch(code, /insert\s+into|update\s+\w+\s+set|delete\s+from/i);
  assert.doesNotMatch(code, /alter\s+table/i);
});
