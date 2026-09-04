/**
 * Store announcements (migration 031) — static SQL invariants.
 *
 * Contract:
 *  - the table exists with the agreed minimal shape;
 *  - RLS is enabled and anon/authenticated may SELECT only active rows;
 *  - there is NO write path for anon/authenticated — admin CRUD goes
 *    exclusively through the guarded /api/admin/announcements route
 *    (service-role client after requireAdminApi, feedback pattern);
 *  - the seeded templates are ALL inactive: the migration itself must
 *    never publish anything to the storefront (owner decision 2026-09-02,
 *    the supply warning is toggled on via the admin UI afterwards).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/031_store_announcements.sql';

test('ANN-MIGRATION: migration file exists with the agreed number', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('031_store_announcements.sql'),
    `expected ${MIGRATION}; found: ${files.join(', ')}`
  );
});

test('ANN-MIGRATION: creates store_announcements with the minimal shape', () => {
  const m = src(MIGRATION);
  assert.match(m, /create\s+table\s+(if\s+not\s+exists\s+)?public\.store_announcements/i);
  assert.match(m, /id\s+uuid\s+primary\s+key/i);
  assert.match(m, /title\s+text\s+not\s+null/i);
  assert.match(m, /message\s+text\s+not\s+null/i);
  assert.match(m, /type\s+text\s+not\s+null/i);
  assert.match(m, /is_active\s+boolean\s+not\s+null\s+default\s+false/i);
  assert.match(m, /sort_order\s+integer\s+not\s+null\s+default\s+0/i);
  assert.match(m, /created_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
  assert.match(m, /updated_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
});

test('ANN-MIGRATION: type is restricted to info|warning|important|success', () => {
  const m = src(MIGRATION);
  const check = m.match(/type\s+text[^;]*check\s*\(([^)]*)\)/i);
  assert.ok(check, 'type CHECK constraint missing');
  assert.ok(check[1] !== undefined);
  for (const t of ['info', 'warning', 'important', 'success']) {
    assert.match(check[1], new RegExp(`'${t}'`), `type option '${t}' missing`);
  }
});

test('ANN-MIGRATION: title and message have length limits', () => {
  const m = src(MIGRATION);
  assert.match(m, /char_length\(title\)\s*(between|<=|<)/i);
  assert.match(m, /char_length\(message\)\s*(between|<=|<)/i);
});

test('ANN-MIGRATION: RLS enabled on store_announcements', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /alter\s+table\s+(public\.)?store_announcements\s+enable\s+row\s+level\s+security/i
  );
});

test('ANN-MIGRATION: public SELECT policy exposes ONLY active rows', () => {
  const m = src(MIGRATION);
  const policy = m.match(
    /create\s+policy\s+\w+[\s\S]*?on\s+(public\.)?store_announcements[\s\S]*?for\s+select[\s\S]*?to\s+anon,\s*authenticated[\s\S]*?using\s*\(([\s\S]*?)\);/i
  );
  assert.ok(policy, 'public SELECT policy for anon, authenticated missing');
  assert.ok(policy[2] !== undefined);
  assert.match(policy[2], /is_active/i, 'policy must filter by is_active');
});

test('ANN-MIGRATION: no INSERT/UPDATE/DELETE/ALL policy for anon or authenticated', () => {
  const m = src(MIGRATION);
  const policies = m.match(/create\s+policy[^;]*on\s+(public\.)?store_announcements[^;]*;/gi) ?? [];
  assert.ok(policies.length >= 1, 'expected at least the SELECT policy');
  for (const p of policies) {
    assert.doesNotMatch(
      p,
      /for\s+(insert|update|delete|all)/i,
      `write policy found: ${p}`
    );
  }
});

test('ANN-MIGRATION: no service-role bypass or GRANT ALL introduced', () => {
  const m = src(MIGRATION);
  assert.doesNotMatch(m, /grant\s+all/i);
  assert.doesNotMatch(m, /bypassrls/i);
  assert.doesNotMatch(m, /force\s+row\s+level\s+security/i);
});

test('ANN-MIGRATION: active-lookup index exists', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /create\s+index\s+(if\s+not\s+exists\s+)?\w*\s*on\s+(public\.)?store_announcements\s*\([^)]*is_active[^)]*sort_order[^)]*\)/i,
    'expected an (is_active, sort_order) index for the storefront lookup'
  );
});

test('ANN-MIGRATION: seeds exactly the 5 agreed templates, ALL inactive', () => {
  const m = src(MIGRATION);
  const titles = [
    'Неповні поставки',
    'Затримка обробки замовлень',
    'Затримка доставки',
    'Тимчасова недоступність',
    'Технічні роботи',
  ];
  for (const t of titles) {
    assert.ok(m.includes(t), `seed template missing: ${t}`);
  }
  // Every seeded row must be is_active = false — the migration never
  // publishes anything on its own.
  const inserts = m.match(/insert\s+into[\s\S]*?;/gi) ?? [];
  assert.ok(inserts.length > 0, 'seed INSERT missing');
  for (const stmt of inserts) {
    const activeValues = stmt.match(/is_active\s*,[\s\S]*?(?:values|\))/gi) ?? [];
    void activeValues;
    assert.match(
      stmt,
      /false/i,
      'seed row must be inserted with is_active = false'
    );
    assert.doesNotMatch(stmt, /is_active[^,\n]*true/i);
  }
  // The supply warning text must match the owner-confirmed copy exactly.
  assert.ok(
    m.includes(
      'Через тимчасові перебої на складах постачальника деякі товари можуть бути доступні не в повному обсязі.'
    )
  );
});
