/**
 * Yugcontract import — per-row error diagnostics (2026-09-01 audit, #1).
 *
 * Bug: per-row failures only bumped the `errors` counter — the error text
 * and the failing row id were discarded. Products/categories batches then
 * finished `done` + `last_error=null`, content batches `failed` + `last_error=null`,
 * leaving operators with a count and nothing else.
 *
 * Contract under test (retry semantics and status logic UNCHANGED):
 *   - RowErrorCollector keeps the FIRST 5 failures (row id + message),
 *     caps the final last_error string, returns null when nothing failed;
 *   - every per-row failure site records (row id, message);
 *   - finishBatch/finishContentBatch receive collector output:
 *     products/categories stay 'done' (per-row errors never fail a batch),
 *     content batches keep `errors > 0 ? 'failed' : 'done'`;
 *   - the collector is a pure util (no DB access, no architecture change).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const ROW_ERRORS = 'app/lib/yugcontract/row-errors.ts';
const IMPORT_RUN = 'app/lib/yugcontract/import-run.ts';
const CONTENT_IMPORT = 'app/lib/yugcontract/content-import.ts';
const IMPORT_PLAN = 'app/lib/yugcontract/import-plan.ts';

async function loadCollector(): Promise<
  typeof import('../app/lib/yugcontract/row-errors.ts')
> {
  return await import('../app/lib/yugcontract/row-errors.ts');
}

// ---------------- unit: RowErrorCollector ----------------

test('DIAG: collector preserves row id + error text for each failure', async () => {
  const { RowErrorCollector } = await loadCollector();
  const c = new RowErrorCollector();
  c.add('yc-123 (product p-1)', 'FK violation on category_id');
  c.add('yc-456 (product p-2)', 'statement timeout');
  const out = c.toLastError();
  assert.ok(out);
  assert.match(out, /yc-123 \(product p-1\): FK violation on category_id/);
  assert.match(out, /yc-456 \(product p-2\): statement timeout/);
});

test('DIAG: collector records at most the first 5 failures', async () => {
  const { RowErrorCollector } = await loadCollector();
  const c = new RowErrorCollector();
  for (let i = 1; i <= 8; i += 1) c.add(`row-${i}`, `boom ${i}`);
  const out = c.toLastError();
  assert.ok(out);
  for (let i = 1; i <= 5; i += 1) {
    assert.match(out, new RegExp(`row-${i}: boom ${i}`), `row-${i} must be kept`);
  }
  assert.doesNotMatch(out, /row-6|row-7|row-8/, 'failures beyond the cap are dropped');
});

test('DIAG: last_error string is capped at 2000 chars with ellipsis', async () => {
  const { RowErrorCollector } = await loadCollector();
  const c = new RowErrorCollector();
  for (let i = 0; i < 5; i += 1) c.add(`row-${i}`, 'x'.repeat(600));
  const out = c.toLastError();
  assert.ok(out);
  assert.ok(out.length <= 2000, `expected <= 2000 chars, got ${out.length}`);
  assert.ok(out.endsWith('...'), 'truncated output must end with ellipsis');
});

test('DIAG: short diagnostics are stored verbatim (no truncation artifacts)', async () => {
  const { RowErrorCollector } = await loadCollector();
  const c = new RowErrorCollector();
  c.add('yc-1 (product p-1)', 'short failure');
  assert.equal(c.toLastError(), 'yc-1 (product p-1): short failure');
});

test('DIAG: zero failures → last_error stays null', async () => {
  const { RowErrorCollector } = await loadCollector();
  const c = new RowErrorCollector();
  assert.equal(c.toLastError(), null);
});

// ---------------- source invariants: call sites + statuses ----------------

test('DIAG: both products/categories finishBatch(done) calls wire the collector', () => {
  const s = src(IMPORT_RUN);
  const doneCalls = s.match(
    /finishBatch\(client, batch\.id, 'done', [\s\S]{0,60}?rowErrors\.toLastError\(\)\)/g
  );
  assert.equal(
    doneCalls?.length,
    2,
    'runCategoriesBatch and runProductsBatch must both pass rowErrors.toLastError()'
  );
});

test('DIAG: both content finishContentBatch calls wire the collector, status logic unchanged', () => {
  const s = src(CONTENT_IMPORT);
  const calls = s.match(
    /finishContentBatch\(\s*client,\s*batch\.id,\s*errors > 0 \? 'failed' : 'done',\s*counters,\s*rowErrors\.toLastError\(\),?\s*\)/g
  );
  assert.equal(
    calls?.length,
    2,
    'images and description phases must pass rowErrors.toLastError() and keep errors>0 → failed'
  );
});

test('DIAG: every per-row failure site records diagnostics', () => {
  const run = src(IMPORT_RUN);
  const content = src(CONTENT_IMPORT);
  // products update + product_categories upsert + product_categories delete
  // + applyCategoryPlan update = 4 sites
  assert.ok(
    (run.match(/rowErrors\.add\(/g) ?? []).length >= 4,
    'import-run.ts must record diagnostics at every per-row failure site'
  );
  // images update + description update = 2 sites
  assert.ok(
    (content.match(/rowErrors\.add\(/g) ?? []).length >= 2,
    'content-import.ts must record diagnostics at every per-row failure site'
  );
});

test('DIAG: product update ops carry the yugcontract id for diagnostics', () => {
  const plan = src(IMPORT_PLAN);
  assert.match(plan, /yugcontractId: string/, 'ProductUpdateOp must declare yugcontractId');
  assert.match(
    plan,
    /yugcontractId: row\.yugcontract_id/,
    'splitProductWrites must populate yugcontractId on update ops'
  );
  const run = src(IMPORT_RUN);
  assert.match(run, /op\.yugcontractId/, 'products failure site must reference the yc id');
});

test('DIAG: batch status semantics unchanged (products/categories done, content conditional)', () => {
  const run = src(IMPORT_RUN);
  // Per-row errors must NOT flip products/categories batches to 'failed'.
  assert.doesNotMatch(
    run,
    /errors > 0 \? 'failed' : 'done'/,
    'import-run batch statuses must not depend on the per-row error count'
  );
  // Crash/conflict paths still mark 'failed' with a message.
  assert.match(run, /finishBatch\(client, batch\.id, 'failed'/);
  const content = src(CONTENT_IMPORT);
  assert.match(content, /finishContentBatch\(client, batch\.id, 'failed', zero, msg\)/);
});

test('DIAG: retry semantics untouched (failed batches stay claimable in both claim fns)', () => {
  const run = src(IMPORT_RUN);
  const content = src(CONTENT_IMPORT);
  assert.match(run, /b\.status === 'pending' \|\| b\.status === 'failed'\) return true/);
  assert.match(content, /b\.status === 'pending' \|\| b\.status === 'failed'\) return true/);
});

test('DIAG: row-errors.ts is a pure util — no DB, no fetch, no client deps', () => {
  const s = src(ROW_ERRORS);
  assert.doesNotMatch(s, /supabase|createClient|\.from\(|fetch\(/);
  assert.doesNotMatch(s, /^import /m, 'zero imports — pure module');
});
