/**
 * Restock FK cascade (P1 audit fix) — static invariants.
 *
 * Bug: migration 042 declared
 *   product_id uuid not null references products(id)
 * WITHOUT ON DELETE, so hard-deleting a product that has live restock
 * requests failed with an FK violation (23503) → 500 from the admin
 * hard-delete route.
 *
 * Two-layer fix, both pinned here:
 *   1. migration 043 — recreate restock_requests_product_id_fkey with
 *      ON DELETE CASCADE (DDL-only, VERIFY-PRE/POST header, idempotent
 *      guarded DROP + ADD; also registered in additive-migrations.test.ts);
 *   2. DELETE /api/admin/products/[id] — clears this product's
 *      restock_requests rows (service-role client) BEFORE the products
 *      delete, so the hard-delete works even before 043 is applied; with
 *      043 live it is a harmless no-op. A failed cleanup must abort the
 *      deletion (never swallow-and-proceed into a 500).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const stripComments = (sql: string): string => sql.replace(/^\s*--.*$/gm, '');
const stripJsComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const MIGRATION = 'database/migrations/043_restock_requests_fk_cascade.sql';
const ROUTE = 'app/api/admin/products/[id]/route.ts';

// ---------------------------------------------------------------------------
// 1. Migration 043 — static invariants
// ---------------------------------------------------------------------------

test('MIGRATION 043: file exists (next number after 042)', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(files.includes('043_restock_requests_fk_cascade.sql'));
});

test('MIGRATION 043: recreates the 042 FK with ON DELETE CASCADE', () => {
  const body = stripComments(src(MIGRATION));
  // 042 declared REFERENCES inline without an explicit name → the default
  // constraint name is <table>_<column>_fkey; the drop must target exactly it.
  assert.match(
    body,
    /drop\s+constraint\s+if\s+exists\s+restock_requests_product_id_fkey/i
  );
  assert.match(
    body,
    /add\s+constraint\s+restock_requests_product_id_fkey/i
  );
  const fk = body.match(
    /foreign\s+key\s*\(\s*product_id\s*\)\s*references\s+products\s*\(\s*id\s*\)/i
  );
  assert.ok(fk, 'FOREIGN KEY (product_id) REFERENCES products(id) required');
  // The cascade must belong to that ADD CONSTRAINT block.
  const addIdx = body.indexOf('ADD CONSTRAINT restock_requests_product_id_fkey');
  const cascade = /on\s+delete\s+cascade/i;
  const after = body.slice(Math.max(addIdx, 0));
  assert.match(after, cascade, 'the re-added FK must be ON DELETE CASCADE');
});

test('MIGRATION 043: DDL-only — no data writes, no destructive drops', () => {
  const body = stripComments(src(MIGRATION));
  assert.doesNotMatch(body, /insert\s+into|update\s+\w+\s+set|delete\s+from/i);
  assert.doesNotMatch(
    body,
    /drop\s+(table|column|index|policy)|truncate\b|alter\s+table\s+.*\s+drop\s+column/i
  );
  // Table/RLS/privileges contract of 042 stays untouched.
  assert.doesNotMatch(body, /create\s+policy|revoke\s+|enable\s+row\s+level\s+security/i);
});

test('MIGRATION 043: VERIFY-PRE/POST header for the orchestrator', () => {
  const full = src(MIGRATION);
  assert.match(full, /VERIFY-PRE/);
  assert.match(full, /VERIFY-POST/);
  // The live checks pin the confdeltype flip: NO ACTION ('a') → CASCADE ('c').
  assert.match(full, /confdeltype/);
  assert.match(full, /'a'/, 'VERIFY-PRE pins the current NO ACTION state');
  assert.match(full, /'c'/, 'VERIFY-POST pins the CASCADE result');
});

test('MIGRATION 042 target really lacks a cascade (bug precondition intact pre-fix)', () => {
  // The bug precondition: 042's inline FK carries no ON DELETE clause.
  const body042 = stripComments(src('database/migrations/042_restock_requests.sql'));
  const fk042 = body042.match(/product_id\s+uuid\s+not\s+null\s+references\s+products\(id\)/i);
  assert.ok(fk042, '042 inline FK not found');
  assert.doesNotMatch(
    body042,
    /references\s+products\(id\)\s*on\s+delete/i,
    '042 must stay as-is: 043 is the fix, 042 is never edited'
  );
});

// ---------------------------------------------------------------------------
// 2. Admin hard-delete route — restock cleanup before the products delete
// ---------------------------------------------------------------------------

const routeCode = stripJsComments(src(ROUTE));
const deleteFn = routeCode.slice(routeCode.indexOf('export async function DELETE('));

test('ROUTE: DELETE clears restock_requests for the product BEFORE deleting the product', () => {
  const restockIdx = deleteFn.indexOf(".from('restock_requests')");
  const restockDelete = deleteFn.slice(restockIdx);
  assert.match(
    restockDelete.slice(0, 120),
    /\.delete\(\)\s*\.eq\('product_id', id\)/,
    'service-role delete scoped to this product only'
  );
  const productDeleteIdx = deleteFn.indexOf(".from('products')");
  assert.match(
    deleteFn.slice(productDeleteIdx, productDeleteIdx + 80),
    /\.delete\(\)/,
    'products hard-delete present'
  );
  assert.ok(
    restockIdx !== -1 && restockIdx < productDeleteIdx,
    'restock cleanup must run BEFORE the products delete (pre-043 FK violation guard)'
  );
  assert.equal(
    deleteFn.split(".from('restock_requests')").length - 1,
    1,
    'exactly one restock cleanup site in DELETE'
  );
});

test('ROUTE: restock cleanup failure aborts the deletion (no swallow-and-proceed)', () => {
  const restockIdx = deleteFn.indexOf(".from('restock_requests')");
  const cleanupBlock = deleteFn.slice(restockIdx, deleteFn.indexOf(".from('products')"));
  assert.match(cleanupBlock, /restockError/);
  assert.match(cleanupBlock, /console\.error\(/, 'failure is logged');
  assert.match(cleanupBlock, /status: 500/, 'failed cleanup → 500, deletion never proceeds');
  assert.match(cleanupBlock, /Не вдалося підготувати видалення товару/);
  assert.doesNotMatch(
    cleanupBlock,
    /json\(\{ error: [^}]*message/,
    'no DB internals leaked to the response body'
  );
});
