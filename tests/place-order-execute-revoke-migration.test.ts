/**
 * Migration 036 (place_order EXECUTE revoke) — static invariants.
 *
 * The checkout audit (2026-09) showed the order-creation rate limit
 * (3/min + 10/h) lives only in app/api/orders/route.ts, while place_order
 * carried EXECUTE for anon/authenticated (migration 030) and the anon key
 * is publishable — a direct-RPC spam bypass (stock-holding DoS). 036
 * revokes anon/authenticated EXECUTE; the route now calls the SECURITY
 * DEFINER RPC with the service-role key. These tests pin the migration
 * content so the hardening cannot silently regress (014/033/035 pattern).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/036_place_order_revoke_anon_execute.sql';

const stripComments = (sql: string): string => sql.replace(/^\s*--.*$/gm, '');

test('PLACE-ORDER-REVOKE: migration file exists', () => {
  const m = src(MIGRATION);
  assert.ok(m.length > 0, `${MIGRATION} must exist and be non-empty`);
});

test('PLACE-ORDER-REVOKE: revokes EXECUTE from anon AND authenticated', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /revoke\s+execute\s+on\s+function\s+(public\.)?place_order\(jsonb,\s*text\)\s+from\s+anon,\s*authenticated/,
    'both roles that could bypass the route rate limit must lose EXECUTE'
  );
});

test('PLACE-ORDER-REVOKE: service_role keeps EXECUTE (the route is the only caller)', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /grant\s+execute\s+on\s+function\s+(public\.)?place_order\(jsonb,\s*text\)\s+to\s+service_role/,
    'self-contained grant so replaying the file alone yields a working setup'
  );
});

test('PLACE-ORDER-REVOKE: no remaining grant of place_order to anon/authenticated', () => {
  const m = stripComments(src(MIGRATION));
  for (const line of m.split('\n')) {
    if (/grant\s+execute/i.test(line) && /place_order/i.test(line)) {
      assert.match(line, /service_role\s*;?\s*$/,
        'the only EXECUTE grant in the file must target service_role');
    }
  }
});

test('PLACE-ORDER-REVOKE: owner-applied discipline + deploy-order warning in the header', () => {
  const m = src(MIGRATION);
  assert.match(m, /NOT APPLIED AUTOMATICALLY/,
    'must warn that the owner applies it via SQL Editor (no DDL from code)');
  assert.match(m, /DEPLOY ORDER/,
    'must warn to deploy the service-role route change BEFORE applying 036');
});

test('PLACE-ORDER-REVOKE: idempotent privilege statements only, no data writes', () => {
  const m = stripComments(src(MIGRATION));
  assert.doesNotMatch(m, /insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+policy|alter\s+table/i,
    'privilege-only migration — nothing else may sneak in');
  // Every non-comment statement is a revoke/grant of place_order EXECUTE.
  const statements = m.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  assert.ok(statements.length >= 2, 'expected the revoke and the grant statements');
  for (const s of statements) {
    assert.match(s, /^(revoke|grant)\s+execute/i,
      `unexpected statement in a privilege-only migration: ${s.slice(0, 60)}`);
  }
});
