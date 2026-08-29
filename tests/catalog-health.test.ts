/**
 * Tests for the read-only catalog health check (monitoring stage
 * 2026-08-28). All classification tests run on MOCK data — production DB is
 * never touched. Static pins guarantee the production script performs only
 * read-only selects and exits with systemd-friendly codes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  analyzeImportBatches,
  buildCatalogChecks,
  overallResult,
  type CatalogHealthInput,
  type ImportBatchInfo,
} from '../app/lib/monitoring/catalog-health.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const NOW = new Date('2026-08-28T18:45:00Z');
const HOUR = 3600 * 1000;

function batch(partial: Partial<ImportBatchInfo>): ImportBatchInfo {
  return {
    run_id: 'run-1',
    phase: 'products',
    batch_no: 1,
    status: 'done',
    started_at: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
    finished_at: new Date(NOW.getTime() - 1 * HOUR).toISOString(),
    last_error: null,
    ...partial,
  };
}

function input(partial: Partial<CatalogHealthInput> = {}): CatalogHealthInput {
  return {
    now: NOW,
    counts: {
      activeTotal: 4721,
      noYcId: 3,
      noCategory: 0,
      noImages: 0,
      noPrice: 0,
      nonPositivePrice: 0,
    },
    batches: [batch({})],
    pendingOrdersOlderThan24h: 0,
    ...partial,
  };
}

const byId = (checks: ReturnType<typeof buildCatalogChecks>, id: string) =>
  checks.find((c) => c.id === id)!;

// ---- PASS / WARN / FAIL classification ----

test('HEALTH: healthy input classifies as PASS with exit 0', () => {
  const checks = buildCatalogChecks(input());
  const { status, exitCode } = overallResult(checks);
  assert.equal(status, 'PASS');
  assert.equal(exitCode, 0);
  for (const c of checks) {
    assert.equal(c.level, 'pass', `check ${c.id} expected pass`);
  }
});

test('HEALTH: products without images escalate to WARN (exit 1) and carry items', () => {
  const checks = buildCatalogChecks(
    input({
      counts: { activeTotal: 4721, noYcId: 0, noCategory: 0, noImages: 591, noPrice: 0, nonPositivePrice: 0 },
      noImageItems: ['24010/106 | ABC-1 | slug-x | Name X'],
    })
  );
  const noImages = byId(checks, 'products-no-images');
  assert.equal(noImages.level, 'warn');
  assert.equal(noImages.count, 591);
  assert.deepEqual(noImages.items, ['24010/106 | ABC-1 | slug-x | Name X']);
  assert.deepEqual(overallResult(checks), { status: 'WARN', exitCode: 1 });
});

test('HEALTH: no category / no price / non-positive price are WARN, not FAIL', () => {
  const checks = buildCatalogChecks(
    input({
      counts: { activeTotal: 10, noYcId: 0, noCategory: 2, noImages: 0, noPrice: 1, nonPositivePrice: 4 },
    })
  );
  assert.equal(byId(checks, 'products-no-category').level, 'warn');
  assert.equal(byId(checks, 'products-no-price').level, 'warn');
  assert.equal(byId(checks, 'products-nonpositive-price').level, 'warn');
  assert.deepEqual(overallResult(checks), { status: 'WARN', exitCode: 1 });
});

test('HEALTH: manual products (no yugcontract_id) never escalate the status', () => {
  const checks = buildCatalogChecks(input({ counts: { activeTotal: 10, noYcId: 10, noCategory: 0, noImages: 0, noPrice: 0, nonPositivePrice: 0 } }));
  assert.equal(byId(checks, 'products-manual').level, 'pass');
  assert.equal(byId(checks, 'products-manual').affectsStatus, false);
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

// ---- failed / stuck run detection ----

test('HEALTH: a failed import batch escalates to FAIL (exit 2)', () => {
  const checks = buildCatalogChecks(
    input({ batches: [batch({}), batch({ run_id: 'run-2', status: 'failed', last_error: 'boom' })] })
  );
  const failed = byId(checks, 'import-failed-batches');
  assert.equal(failed.level, 'fail');
  assert.equal(failed.count, 1);
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('HEALTH: a running batch older than the stuck window is detected as stuck', () => {
  const stuck = analyzeImportBatches(
    [batch({ status: 'running', started_at: new Date(NOW.getTime() - 2 * HOUR).toISOString(), finished_at: null })],
    NOW
  );
  assert.equal(stuck.stuckCount, 1);
  // Fresh in-flight batches are NOT stuck.
  const fresh = analyzeImportBatches(
    [batch({ status: 'running', started_at: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(), finished_at: null })],
    NOW
  );
  assert.equal(fresh.stuckCount, 0);
  const checks = buildCatalogChecks(input({ batches: [batch({ status: 'running', started_at: new Date(NOW.getTime() - 2 * HOUR).toISOString(), finished_at: null })] }));
  assert.equal(byId(checks, 'import-stuck-batches').level, 'fail');
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('HEALTH: last-success age thresholds (fresh/56h/96h/never)', () => {
  const fresh = analyzeImportBatches([batch({ finished_at: new Date(NOW.getTime() - 10 * HOUR).toISOString() })], NOW);
  assert.equal(fresh.lastSuccessAt, new Date(NOW.getTime() - 10 * HOUR).toISOString());
  const warn = buildCatalogChecks(input({ batches: [batch({ finished_at: new Date(NOW.getTime() - 60 * HOUR).toISOString() })] }));
  assert.equal(byId(warn, 'import-last-success').level, 'warn');
  assert.deepEqual(overallResult(warn), { status: 'WARN', exitCode: 1 });
  const fail = buildCatalogChecks(input({ batches: [batch({ finished_at: new Date(NOW.getTime() - 100 * HOUR).toISOString() })] }));
  assert.equal(byId(fail, 'import-last-success').level, 'fail');
  assert.deepEqual(overallResult(fail), { status: 'FAIL', exitCode: 2 });
  const never = buildCatalogChecks(input({ batches: [] }));
  assert.equal(byId(never, 'import-last-success').level, 'fail');
});

test('HEALTH: last success picks the NEWEST done batch', () => {
  const a = analyzeImportBatches(
    [
      batch({ run_id: 'old', finished_at: new Date(NOW.getTime() - 90 * HOUR).toISOString() }),
      batch({ run_id: 'new', finished_at: new Date(NOW.getTime() - 5 * HOUR).toISOString() }),
    ],
    NOW
  );
  assert.equal(a.lastSuccessAt, new Date(NOW.getTime() - 5 * HOUR).toISOString());
});

// ---- advisory checks ----

test('HEALTH: pending orders >24h are advisory and never escalate the status', () => {
  const checks = buildCatalogChecks(input({ pendingOrdersOlderThan24h: 11 }));
  const pending = byId(checks, 'orders-pending-24h');
  assert.equal(pending.level, 'warn');
  assert.equal(pending.affectsStatus, false);
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('HEALTH: FAIL wins over WARN when both are present', () => {
  const checks = buildCatalogChecks(
    input({
      counts: { activeTotal: 10, noYcId: 0, noCategory: 0, noImages: 591, noPrice: 0, nonPositivePrice: 0 },
      batches: [batch({ status: 'failed' })],
    })
  );
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

// ---- read-only guarantees ----

test('HEALTH: production script performs no write operations', () => {
  const s = src('scripts/catalog-health-check.ts');
  for (const banned of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(', '--run', 'import-run']) {
    assert.ok(!s.includes(banned), `health-check must not contain ${banned}`);
  }
  // Only selects, and the header pins the READ-ONLY contract.
  assert.match(s, /\.select\(/);
  assert.match(s, /READ-ONLY/);
});

test('HEALTH: exit codes are 0/1/2 and the script exits with the classification', () => {
  const lib = src('app/lib/monitoring/catalog-health.ts');
  assert.match(lib, /exitCode: 0 \| 1 \| 2/);
  const s = src('scripts/catalog-health-check.ts');
  assert.match(s, /process\.exit\(exitCode\)/);
});

test('HEALTH: classifier is pure — the lib contains no DB imports', () => {
  const lib = src('app/lib/monitoring/catalog-health.ts');
  assert.ok(!lib.includes('@supabase'), 'classifier must not touch the DB client');
  assert.ok(!lib.includes('createClient'));
});

test('HEALTH: failure-notify never leaks secrets and never fails the chain', () => {
  const n = src('scripts/wsl/yugcontract-failure-notify.sh');
  // No secrets in payload: only unit name + timestamp are sent.
  assert.match(n, /yugcontract-sync FAILED: unit=/);
  assert.ok(!/YUGCONTRACT_SECRET|SERVICE_ROLE|PRIVATE_KEY/.test(n.replace(/YUGCONTRACT_ALERT_WEBHOOK_URL/g, '')));
  assert.match(n, /exit 0/);
});

test('HEALTH: installer wires OnFailure + post-sync health units, importer untouched', () => {
  const installer = src('scripts/wsl/install-yugcontract-timer.sh');
  assert.match(installer, /OnFailure=yugcontract-sync-failure\.service/);
  assert.match(installer, /yugcontract-health\.service/);
  assert.match(installer, /yugcontract-health\.timer/);
  assert.match(installer, /ExecStart=\$ROOT\/scripts\/wsl\/yugcontract-health\.sh/);
  // WARN=1 is an expected classification, not a systemd failure.
  assert.match(installer, /SuccessExitStatus=1/);
  // The importer script is NOT referenced by any monitoring unit.
  assert.ok(!installer.includes('yugcontract-import-run'));
});
