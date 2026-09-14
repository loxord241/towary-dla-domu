/**
 * product_description_drafts (migration 050) — static SQL invariants.
 *
 * Contract (spec 2026-09-14 Phase 2):
 *  - one draft per product (UNIQUE product_id), FK cascade on product delete;
 *  - status restricted to pending/approved/rejected, default pending;
 *  - RLS enabled with NO policies and ALL privileges revoked from
 *    anon/authenticated — the ONLY access paths are the service-role CLI
 *    and the guarded /api/admin/descriptions route;
 *  - the (status, created_at) index serves the pending-queue listing;
 *  - approve_product_description_draft() is the SINGLE writer of
 *    products.description in this feature: it writes ONLY that column and
 *    only for a pending draft, atomically, and is not executable by the
 *    public roles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/050_description_drafts.sql';
const m = src(MIGRATION);

test('DRAFTS-MIGRATION: migration file exists as 050_description_drafts.sql', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('050_description_drafts.sql'),
    `expected ${MIGRATION}; found: ${files.join(', ')}`
  );
});

test('DRAFTS-MIGRATION: table shape — id/product_id/lead/description_text/status/source/timestamps', () => {
  assert.match(m, /create\s+table\s+if\s+not\s+exists\s+public\.product_description_drafts/i);
  assert.match(m, /id\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\(\)/i);
  assert.match(
    m,
    /product_id\s+uuid\s+not\s+null\s+references\s+public\.products\(id\)\s+on\s+delete\s+cascade/i
  );
  assert.match(m, /lead\s+text\s+not\s+null/i);
  assert.match(m, /description_text\s+text\s+not\s+null/i);
  assert.match(m, /source\s+text\s+not\s+null\s+default\s+'spec-generator-v1'/i);
  assert.match(m, /created_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
  assert.match(m, /reviewed_at\s+timestamptz/i);
});

test('DRAFTS-MIGRATION: status CHECK restricted to pending|approved|rejected, default pending', () => {
  assert.match(m, /status\s+text\s+not\s+null\s+default\s+'pending'/i);
  const check = m.match(/status\s+text[^;]*?check\s*\(([^)]*)\)/i);
  assert.ok(check, 'status CHECK constraint missing');
  assert.ok(check[1] !== undefined);
  for (const t of ['pending', 'approved', 'rejected']) {
    assert.match(check[1], new RegExp(`'${t}'`), `status option '${t}' missing`);
  }
});

test('DRAFTS-MIGRATION: exactly one draft per product (UNIQUE product_id)', () => {
  assert.match(m, /unique\s*\(product_id\)/i);
});

test('DRAFTS-MIGRATION: RLS enabled, no policies at all (deny-all for non-service roles)', () => {
  assert.match(
    m,
    /alter\s+table\s+public\.product_description_drafts\s+enable\s+row\s+level\s+security/i
  );
  const policies = m.match(/create\s+policy[^;]*;/gi) ?? [];
  assert.equal(policies.length, 0, `unexpected policies: ${policies.join('\n')}`);
});

test('DRAFTS-MIGRATION: ALL privileges revoked from anon/authenticated (incl. SELECT)', () => {
  assert.match(
    m,
    /revoke\s+all\s+on\s+table\s+public\.product_description_drafts\s+from\s+anon,\s*authenticated/i
  );
});

test('DRAFTS-MIGRATION: (status, created_at) index exists for the pending queue', () => {
  assert.match(
    m,
    /create\s+index\s+if\s+not\s+exists\s+idx_product_description_drafts_status_created\s+on\s+public\.product_description_drafts\s*\(\s*status,\s*created_at\s*\)/i
  );
});

test('DRAFTS-MIGRATION: approve RPC exists and writes ONLY products.description', () => {
  const fn = m.match(
    /create\s+or\s+replace\s+function\s+public\.approve_product_description_draft[\s\S]*?begin([\s\S]*?)end;/i
  );
  assert.ok(fn, 'approve_product_description_draft function missing');
  const body = fn[1] ?? '';
  // The only products UPDATE in the function sets description — no other
  // column of products is ever touched.
  const productsUpdates = body.match(/update\s+public\.products[\s\S]*?;/gi) ?? [];
  assert.equal(productsUpdates.length, 1, 'function must update products exactly once');
  assert.match(productsUpdates[0] ?? '', /set\s+description\s*=/i);
  assert.doesNotMatch(
    productsUpdates[0] ?? '',
    /name|sku|slug|price|is_active|updated_at/i,
    'products update must touch ONLY description'
  );
  // Draft flip to approved + reviewed_at happens in the same function.
  assert.match(body, /status\s*=\s*'approved'/);
  assert.match(body, /reviewed_at\s*=\s*now\(\)/i);
  // Only a pending draft converts (double-click / re-approve → error).
  assert.match(body, /status\s*=\s*'pending'/);
});

test('DRAFTS-MIGRATION: approve RPC not executable by public roles, no broad grants', () => {
  assert.match(
    m,
    /revoke\s+all\s+on\s+function\s+public\.approve_product_description_draft\(uuid\)\s+from\s+public,\s*anon,\s*authenticated/i
  );
  const grants = m.match(/grant\s+[\s\S]*?;/gi) ?? [];
  for (const g of grants) {
    assert.match(g, /service_role/i, `grant not restricted to service_role: ${g}`);
    assert.doesNotMatch(g, /\bto\s+(anon|authenticated)\b/i);
  }
  assert.doesNotMatch(m, /grant\s+all/i);
  assert.doesNotMatch(m, /bypassrls/i);
  assert.doesNotMatch(m, /force\s+row\s+level\s+security/i);
});
