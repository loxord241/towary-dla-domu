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
  analyzeDuDrift,
  analyzeImportBatches,
  analyzeNewestOos,
  analyzeCategoriesBatch,
  analyzeFeedLiveness,
  buildCatalogChecks,
  overallResult,
  CONTENT_STUCK_RUNNING_MS,
  DU_EXPECTED_ORPHANS,
  FEED_LIVENESS_BASELINE_PATH,
  FEED_LIVENESS_FAIL_SHARE,
  FEED_LIVENESS_WARN_SHARE,
  NEWEST_MIN_SAMPLE,
  NEWEST_SAMPLE_SIZE,
  OOS_FAIL_SHARE,
  OOS_WARN_SHARE,
  type CatalogHealthInput,
  type DuAllowlistSnapshot,
  type DuProductRow,
  type FeedLivenessAck,
  type ImportBatchInfo,
  type NewestProductRow,
} from '../app/lib/monitoring/catalog-health.ts';
import {
  DU_PRICE_DIFF_PAIRS,
  DU_REDIRECT_BY_YC,
  DU_REDIRECT_PAIRS,
} from '../app/lib/du-redirects.ts';

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

test('HEALTH: products without images stay visible but advisory (expected import backlog)', () => {
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
  // Imageless active products are the documented import backlog (storefront
  // eligibility = product_images!inner): reported with items, never escalate
  // the overall status — the image backlog must not hold health at WARN.
  assert.equal(noImages.affectsStatus, false);
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
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
  assert.match(installer, /ExecStart="?\$ROOT\/scripts\/wsl\/yugcontract-health\.sh"?/);
  // WARN=1 is an expected classification, not a systemd failure.
  assert.match(installer, /SuccessExitStatus=1/);
  // The importer script is NOT referenced by any monitoring unit.
  assert.ok(!installer.includes('yugcontract-import-run'));
});

// ---- pagination correctness (audit 2026-08-31, issue #2) ----

test('HEALTH: yc_import_batches read pages with .range(from, from+limit-1)', () => {
  const s = src('scripts/catalog-health-check.ts');
  const batchesStart = s.indexOf("from('yc_import_batches')");
  assert.ok(batchesStart !== -1, 'batches query must exist');
  const batchesEnd = s.indexOf('as unknown as ImportBatchInfo', batchesStart);
  assert.ok(batchesEnd !== -1);
  // The fetchAll callback must consume (from, limit) — a callback that
  // ignores them loops forever once the table reaches the 1000-row cap.
  assert.match(
    s.slice(batchesStart, batchesEnd),
    /\.range\(from, from \+ limit - 1\)/,
    'yc_import_batches query must page via .range(from, from + limit - 1)'
  );
});

test('HEALTH: pending orders read pages with .range(from, from+limit-1)', () => {
  const s = src('scripts/catalog-health-check.ts');
  const start = s.indexOf('const pendingOrders = await fetchAll(');
  assert.ok(start !== -1, 'pending orders fetchAll call must exist');
  const end = s.indexOf(');', start);
  const segment = s.slice(start, end);
  assert.match(segment, /\(from, limit\)/, 'callback must consume (from, limit)');
  assert.match(
    segment,
    /\.range\(from, from \+ limit - 1\)/,
    'pending orders query must page via .range(from, from + limit - 1)'
  );
});

test('HEALTH: every fetchAll callback consumes (from, limit) — no range-less callbacks left', () => {
  const s = src('scripts/catalog-health-check.ts');
  const params = [...s.matchAll(/await fetchAll\(\s*\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(params.length >= 7, 'expected the 7 existing fetchAll call sites');
  for (const p of params) {
    assert.equal(p, 'from, limit', `fetchAll callback must take (from, limit), got (${p})`);
  }
});

// ---- _du allowlist drift (2026-09-01 audit: 96 redirect + 10 price-diff + 24 orphans) ----

const TEST_ALLOWLIST: DuAllowlistSnapshot = {
  duIds: new Set(['1_du', '2_du']),
  priceDiffIds: new Set(['2_du']),
  expectedOrphans: 1,
};

function duRow(id: string, slug: string, price: number | null): DuProductRow {
  return { yugcontract_id: id, slug, price };
}

/**
 * Healthy fixture mirroring the audit shape: '1_du' is a same-price
 * redirect pair, '2_du' a documented price-diff pair, '3_du' the single
 * expected orphan (no base '3' in baseRows).
 */
function healthyDu(): { duRows: DuProductRow[]; baseRows: DuProductRow[] } {
  return {
    duRows: [
      duRow('1_du', 'p-1_du', 100),
      duRow('2_du', 'q-2_du', 100),
      duRow('3_du', 'r-3_du', 50),
    ],
    baseRows: [duRow('1', 'p-1', 100), duRow('2', 'q-2', 200)],
  };
}

function inputWithDu(duPartial: Partial<{ duRows: DuProductRow[]; baseRows: DuProductRow[] }> = {}): CatalogHealthInput {
  const healthy = healthyDu();
  return input({
    du: {
      duRows: duPartial.duRows ?? healthy.duRows,
      baseRows: duPartial.baseRows ?? healthy.baseRows,
      allowlist: TEST_ALLOWLIST,
    },
  });
}

test('DU-DRIFT: analyzeDuDrift on the healthy fixture reports zero drift', () => {
  const { duRows, baseRows } = healthyDu();
  const a = analyzeDuDrift({ duRows, baseRows, allowlist: TEST_ALLOWLIST });
  assert.equal(a.duTotal, 3);
  assert.equal(a.orphanCount, 1);
  assert.deepEqual(a.unknownDu, []);
  assert.deepEqual(a.missingDu, []);
  assert.deepEqual(a.brokenPairs, []);
  assert.deepEqual(a.priceDrift, []);
});

test('DU-DRIFT: healthy fixture passes all four du checks (overall PASS)', () => {
  const checks = buildCatalogChecks(inputWithDu());
  for (const id of ['du-unknown-new', 'du-pairs-integrity', 'du-price-drift', 'du-orphans']) {
    assert.equal(byId(checks, id).level, 'pass', `check ${id} expected pass`);
  }
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('DU-DRIFT: a new _du with a base but absent from the allowlist is FAIL', () => {
  const { duRows, baseRows } = healthyDu();
  duRows.push(duRow('9_du', 'x-9_du', 80));
  baseRows.push(duRow('9', 'x-9', 80));
  const checks = buildCatalogChecks(inputWithDu({ duRows, baseRows }));
  const unknown = byId(checks, 'du-unknown-new');
  assert.equal(unknown.level, 'fail');
  assert.equal(unknown.count, 1);
  assert.ok(unknown.items?.some((i) => i.includes('9_du')));
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('DU-DRIFT: a vanished allowlisted _du is FAIL', () => {
  const { duRows, baseRows } = healthyDu();
  const checks = buildCatalogChecks(inputWithDu({ duRows: duRows.filter((r) => r.yugcontract_id !== '1_du'), baseRows }));
  const pairs = byId(checks, 'du-pairs-integrity');
  assert.equal(pairs.level, 'fail');
  assert.ok(pairs.items?.some((i) => i.includes('1_du')));
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('DU-DRIFT: slug derivation break in a known pair is FAIL', () => {
  const checks = buildCatalogChecks(inputWithDu({ baseRows: [duRow('1', 'renamed-1', 100), duRow('2', 'q-2', 200)] }));
  const pairs = byId(checks, 'du-pairs-integrity');
  assert.equal(pairs.level, 'fail');
  assert.ok(pairs.items?.some((i) => i.includes('1_du')));
});

test('DU-DRIFT: a known pair whose base disappeared is FAIL and raises the orphan count', () => {
  const { duRows } = healthyDu();
  const checks = buildCatalogChecks(inputWithDu({ duRows, baseRows: [duRow('2', 'q-2', 200)] }));
  assert.equal(byId(checks, 'du-pairs-integrity').level, 'fail');
  assert.equal(byId(checks, 'du-orphans').level, 'warn');
  assert.equal(byId(checks, 'du-orphans').count, 2);
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('DU-DRIFT: price-equality flip on known pairs is WARN only (regenerate signal)', () => {
  const { baseRows } = healthyDu();
  // '1_du' (redirect pair) now differs in price; '2_du' (price-diff) now equal.
  const duRows = [duRow('1_du', 'p-1_du', 150), duRow('2_du', 'q-2_du', 200), duRow('3_du', 'r-3_du', 50)];
  const checks = buildCatalogChecks(inputWithDu({ duRows, baseRows }));
  const price = byId(checks, 'du-price-drift');
  assert.equal(price.level, 'warn');
  assert.equal(price.count, 2);
  assert.equal(byId(checks, 'du-unknown-new').level, 'pass');
  assert.equal(byId(checks, 'du-pairs-integrity').level, 'pass');
  assert.deepEqual(overallResult(checks), { status: 'WARN', exitCode: 1 });
});

test('DU-DRIFT: orphan count drift (new _du without base) is WARN', () => {
  const { duRows, baseRows } = healthyDu();
  duRows.push(duRow('4_du', 's-4_du', 10));
  const checks = buildCatalogChecks(inputWithDu({ duRows, baseRows }));
  const orphans = byId(checks, 'du-orphans');
  assert.equal(orphans.level, 'warn');
  assert.equal(orphans.count, 2);
  assert.equal(byId(checks, 'du-unknown-new').level, 'pass');
  assert.deepEqual(overallResult(checks), { status: 'WARN', exitCode: 1 });
});

test('DU-DRIFT: null prices on both sides of a pair are equal (no drift)', () => {
  const duRows = [duRow('1_du', 'p-1_du', null), duRow('2_du', 'q-2_du', 100), duRow('3_du', 'r-3_du', 50)];
  const baseRows = [duRow('1', 'p-1', null), duRow('2', 'q-2', 200)];
  const a = analyzeDuDrift({ duRows, baseRows, allowlist: TEST_ALLOWLIST });
  assert.deepEqual(a.priceDrift, []);
  assert.deepEqual(a.brokenPairs, []);
});

test('DU-DRIFT: du checks are omitted when no du input is provided (backward compatible)', () => {
  const checks = buildCatalogChecks(input());
  assert.ok(!checks.some((c) => c.id.startsWith('du-')));
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('DU-DRIFT: real allowlist snapshot has 293 ids, 93 price-diff, expectedOrphans=38', () => {
  assert.equal(DU_EXPECTED_ORPHANS, 38);
  // 2026-09-12 policy change: ALL verified pairs redirect — the price-diff
  // subset is part of the redirect set (no second live page per product).
  // 2026-09-16 regeneration: 10 pairs + 1 orphan deleted from the DB
  // outside the importer, 6895802_du promoted, 7220883_du equalized.
  // 2026-09-18 regeneration: pair/orphan sets unchanged (same 293 ids,
  // same 38 orphan rows), the 2026-09-18 sync repricing wave (run
  // yc-2026-09-18-13-28-09: 762 updated) drifted 74 pairs from equal
  // prices to differing; none of the previous 19 equalized, 7220883_du
  // drifted apart again -> PRICE_DIFF_YC 19 -> 93 (verified live,
  // read-only re-audit before regeneration).
  const all = new Set([
    ...DU_REDIRECT_PAIRS.map((p) => p.duYc),
    ...DU_PRICE_DIFF_PAIRS.map((p) => p.duYc),
  ]);
  assert.equal(all.size, 293);
  assert.equal(DU_PRICE_DIFF_PAIRS.length, 93);
  assert.equal(DU_REDIRECT_PAIRS.length, 293);
  for (const p of DU_PRICE_DIFF_PAIRS) {
    assert.ok(DU_REDIRECT_BY_YC.has(p.duYc), `${p.duYc} must redirect`);
  }
});

test('DU-DRIFT: production script wires the generated allowlist with read-only selects', () => {
  const s = src('scripts/catalog-health-check.ts');
  assert.match(s, /from ['"]\.\.\/app\/lib\/du-redirects\.ts['"]/);
  assert.match(s, /DU_REDIRECT_PAIRS/);
  assert.match(s, /DU_PRICE_DIFF_PAIRS/);
  assert.match(s, /\.like\('yugcontract_id'/);
  assert.ok(!s.includes('writeFile'), 'drift check must never write the allowlist');
});

test('DU-DRIFT: classifier stays decoupled — the lib never imports the generated allowlist', () => {
  const lib = src('app/lib/monitoring/catalog-health.ts');
  assert.ok(!/import\s+[^;]*du-redirects/.test(lib), 'lib must receive the allowlist as plain data');
});

// ---- newest-products OOS skew (2026-09-05: live top-100 = 86% OOS) ----

function newestRows(oos: number, total: number): NewestProductRow[] {
  return Array.from({ length: total }, (_, i) => ({
    availability_status: i < oos ? 'out_of_stock' : 'in_stock',
  }));
}

test('NEWEST-OOS: all in stock classifies as PASS', () => {
  const a = analyzeNewestOos(newestRows(0, 100));
  assert.equal(a.sampleSize, 100);
  assert.equal(a.oosCount, 0);
  assert.equal(a.oosShare, 0);
  assert.equal(a.smallSample, false);
  const checks = buildCatalogChecks(input({ newestProducts: newestRows(0, 100) }));
  const check = byId(checks, 'newest-oos-skew');
  assert.equal(check.level, 'pass');
  assert.equal(check.affectsStatus, true);
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('NEWEST-OOS: exactly 20% of 100 is WARN (threshold inclusive)', () => {
  const checks = buildCatalogChecks(input({ newestProducts: newestRows(20, 100) }));
  const check = byId(checks, 'newest-oos-skew');
  assert.equal(check.level, 'warn');
  assert.equal(check.count, 20);
  assert.deepEqual(overallResult(checks), { status: 'WARN', exitCode: 1 });
});

test('NEWEST-OOS: exactly 50% of 100 is FAIL (threshold inclusive)', () => {
  const checks = buildCatalogChecks(input({ newestProducts: newestRows(50, 100) }));
  const check = byId(checks, 'newest-oos-skew');
  assert.equal(check.level, 'fail');
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('NEWEST-OOS: 86% of 100 (live 2026-09-05 shape) is FAIL with exit 2', () => {
  const checks = buildCatalogChecks(input({ newestProducts: newestRows(86, 100) }));
  const check = byId(checks, 'newest-oos-skew');
  assert.equal(check.level, 'fail');
  assert.equal(check.count, 86);
  assert.match(check.description, /86%/);
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('NEWEST-OOS: sample of 10 with 50% OOS is advisory WARN — reported, never escalates', () => {
  const a = analyzeNewestOos(newestRows(5, 10));
  assert.equal(a.smallSample, true);
  const checks = buildCatalogChecks(input({ newestProducts: newestRows(5, 10) }));
  const check = byId(checks, 'newest-oos-skew');
  // Not worse than WARN even though the share hits the FAIL threshold.
  assert.equal(check.level, 'warn');
  assert.match(check.description, /Вибірка мала/);
  // Advisory: the small-sample result must not hold the overall status.
  assert.equal(check.affectsStatus, false);
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('NEWEST-OOS: 0 active products is a skip (pass, non-escalating)', () => {
  const a = analyzeNewestOos([]);
  assert.equal(a.sampleSize, 0);
  assert.equal(a.oosShare, null);
  const checks = buildCatalogChecks(input({ newestProducts: [] }));
  const check = byId(checks, 'newest-oos-skew');
  assert.equal(check.level, 'pass');
  assert.match(check.description, /Пропущено/);
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('NEWEST-OOS: thresholds and sample-size constants match the contract', () => {
  assert.equal(NEWEST_SAMPLE_SIZE, 100);
  assert.equal(NEWEST_MIN_SAMPLE, 20);
  assert.equal(OOS_WARN_SHARE, 0.2);
  assert.equal(OOS_FAIL_SHARE, 0.5);
});

test('NEWEST-OOS: the newest check is omitted when the script provides no slice (backward compatible)', () => {
  const checks = buildCatalogChecks(input());
  assert.ok(!checks.some((c) => c.id === 'newest-oos-skew'));
});

test('NEWEST-OOS: production script reads the newest slice with a single range query', () => {
  const s = src('scripts/catalog-health-check.ts');
  const start = s.indexOf('const newestRes = await db');
  assert.ok(start !== -1, 'newest products query must exist');
  const end = s.indexOf('as unknown as NewestProductRow', start);
  assert.ok(end !== -1);
  const segment = s.slice(start, end);
  assert.match(segment, /\.select\('availability_status'\)/);
  assert.match(segment, /\.eq\('is_active', true\)/);
  assert.match(segment, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(segment, /\.range\(0, NEWEST_SAMPLE_SIZE - 1\)/);
  // Fixed-size window: the paged fetchAll helper must not be used here.
  assert.ok(!segment.includes('fetchAll'), 'single range read must not use fetchAll');
  // The slice is fed into the classifier.
  assert.match(s, /newestProducts,/);
});

// ---- content/images phases (2026-09-06, yc_content_batches) ----

function contentBatch(partial: Partial<ImportBatchInfo>): ImportBatchInfo {
  return batch({ phase: 'description', ...partial });
}

test('CONTENT: running content batch older than the 10-min window is stuck, fresh one is not', () => {
  const stuck = analyzeImportBatches(
    [contentBatch({ status: 'running', started_at: new Date(NOW.getTime() - 15 * 60 * 1000).toISOString(), finished_at: null })],
    NOW,
    CONTENT_STUCK_RUNNING_MS
  );
  assert.equal(stuck.stuckCount, 1);
  assert.equal(stuck.failedCount, 0);
  const fresh = analyzeImportBatches(
    [contentBatch({ status: 'running', started_at: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(), finished_at: null })],
    NOW,
    CONTENT_STUCK_RUNNING_MS
  );
  assert.equal(fresh.stuckCount, 0);
  assert.equal(CONTENT_STUCK_RUNNING_MS, 10 * 60 * 1000);
});

test('CONTENT: healthy content/images batches pass (overall PASS)', () => {
  const checks = buildCatalogChecks(
    input({
      contentBatches: [
        contentBatch({ phase: 'description', finished_at: new Date(NOW.getTime() - 5 * HOUR).toISOString() }),
        contentBatch({ phase: 'images', finished_at: new Date(NOW.getTime() - 4 * HOUR).toISOString() }),
      ],
    })
  );
  assert.equal(byId(checks, 'content-failed-batches').level, 'pass');
  assert.equal(byId(checks, 'content-stuck-batches').level, 'pass');
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('CONTENT: a failed content batch is FAIL (exit 2)', () => {
  const checks = buildCatalogChecks(
    input({
      contentBatches: [
        contentBatch({ phase: 'images', status: 'failed', last_error: 'hotlink boom' }),
      ],
    })
  );
  const failed = byId(checks, 'content-failed-batches');
  assert.equal(failed.level, 'fail');
  assert.equal(failed.count, 1);
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('CONTENT: a stuck running content batch is FAIL (exit 2)', () => {
  const checks = buildCatalogChecks(
    input({
      contentBatches: [
        contentBatch({ status: 'running', started_at: new Date(NOW.getTime() - 2 * HOUR).toISOString(), finished_at: null }),
      ],
    })
  );
  const stuck = byId(checks, 'content-stuck-batches');
  assert.equal(stuck.level, 'fail');
  assert.equal(stuck.count, 1);
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('CONTENT: freshness is max(products, content, images) last done', () => {
  // Products phase stale (90h) but images done 5h ago ⇒ freshness is fresh.
  const fresh = buildCatalogChecks(
    input({
      batches: [batch({ finished_at: new Date(NOW.getTime() - 90 * HOUR).toISOString() })],
      contentBatches: [
        contentBatch({ phase: 'images', finished_at: new Date(NOW.getTime() - 5 * HOUR).toISOString() }),
      ],
    })
  );
  assert.equal(byId(fresh, 'import-last-success').level, 'pass');
  assert.deepEqual(overallResult(fresh), { status: 'PASS', exitCode: 0 });
  // max() semantics: a stale content phase does NOT fail freshness while a
  // products run succeeded recently (the sync itself is alive).
  const staleContent = buildCatalogChecks(
    input({
      batches: [batch({ finished_at: new Date(NOW.getTime() - 10 * HOUR).toISOString() })],
      contentBatches: [
        contentBatch({ phase: 'images', finished_at: new Date(NOW.getTime() - 100 * HOUR).toISOString() }),
      ],
    })
  );
  assert.equal(byId(staleContent, 'import-last-success').level, 'pass');
  // Freshness FAILs only when EVERY phase's last done is stale/missing.
  const allStale = buildCatalogChecks(
    input({
      batches: [batch({ finished_at: new Date(NOW.getTime() - 100 * HOUR).toISOString() })],
      contentBatches: [
        contentBatch({ phase: 'images', finished_at: new Date(NOW.getTime() - 100 * HOUR).toISOString() }),
      ],
    })
  );
  assert.equal(byId(allStale, 'import-last-success').level, 'fail');
  assert.deepEqual(overallResult(allStale), { status: 'FAIL', exitCode: 2 });
});

test('CONTENT: content checks are omitted when no contentBatches input (backward compatible)', () => {
  const checks = buildCatalogChecks(input());
  assert.ok(!checks.some((c) => c.id.startsWith('content-')));
});

test('CONTENT: production script reads yc_content_batches with the same columns and paging', () => {
  const s = src('scripts/catalog-health-check.ts');
  const start = s.indexOf("from('yc_content_batches')");
  assert.ok(start !== -1, 'content batches query must exist');
  const end = s.indexOf('as unknown as ImportBatchInfo', start);
  assert.ok(end !== -1);
  const segment = s.slice(start, end);
  assert.match(segment, /run_id, phase, batch_no, status, started_at, finished_at, last_error/);
  assert.match(segment, /\.range\(from, from \+ limit - 1\)/);
  // Wired into the classifier.
  assert.match(s, /contentBatches,/);
});

// ---- feed-liveness (2026-09-06) ----

test('FEED: 3.3% in_stock without ack is FAIL (live incident shape, exit 2)', () => {
  const a = analyzeFeedLiveness({ total: 3000, inStock: 100 });
  assert.equal(a.share, 100 / 3000);
  assert.equal(a.acked, false);
  assert.equal(a.level, 'fail');
  const checks = buildCatalogChecks(input({ feedLiveness: { total: 3000, inStock: 100 } }));
  const check = byId(checks, 'feed-liveness');
  assert.equal(check.level, 'fail');
  assert.equal(check.count, 100);
  // The unacked FAIL tells the owner how to ack.
  assert.match(check.description, new RegExp(FEED_LIVENESS_BASELINE_PATH));
  assert.deepEqual(overallResult(checks), { status: 'FAIL', exitCode: 2 });
});

test('FEED: thresholds are strict "below" — exactly 50% passes, exactly 20% only warns', () => {
  assert.equal(analyzeFeedLiveness({ total: 100, inStock: 50 }).level, 'pass');
  assert.equal(analyzeFeedLiveness({ total: 100, inStock: 49 }).level, 'warn');
  assert.equal(analyzeFeedLiveness({ total: 100, inStock: 20 }).level, 'warn');
  assert.equal(analyzeFeedLiveness({ total: 100, inStock: 19 }).level, 'fail');
  assert.equal(analyzeFeedLiveness({ total: 100, inStock: 100 }).level, 'pass');
});

test('FEED: 45% without ack is WARN (exit 1)', () => {
  const checks = buildCatalogChecks(input({ feedLiveness: { total: 100, inStock: 45 } }));
  assert.equal(byId(checks, 'feed-liveness').level, 'warn');
  assert.deepEqual(overallResult(checks), { status: 'WARN', exitCode: 1 });
});

test('FEED: 0 base products is a skip (pass)', () => {
  const a = analyzeFeedLiveness({ total: 0, inStock: 0 });
  assert.equal(a.skip, true);
  assert.equal(a.share, null);
  assert.equal(a.level, 'pass');
  const checks = buildCatalogChecks(input({ feedLiveness: { total: 0, inStock: 0 } }));
  assert.equal(byId(checks, 'feed-liveness').level, 'pass');
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('FEED: ack with share >= acknowledged baseline suspends the absolute floors', () => {
  const ack: FeedLivenessAck = { acknowledgedAt: '2026-09-08T09:00:00.000Z', acknowledgedShare: 0.033 };
  // Even 1% in_stock would FAIL unacked — acked, at the baseline share
  // (99/3000 = 0.033), it is a known incident and passes.
  const a = analyzeFeedLiveness({ total: 3000, inStock: 99, ack });
  assert.equal(a.acked, true);
  assert.equal(a.degradedFromAck, false);
  assert.equal(a.level, 'pass');
  const checks = buildCatalogChecks(input({ feedLiveness: { total: 3000, inStock: 99, ack } }));
  const check = byId(checks, 'feed-liveness');
  assert.equal(check.level, 'pass');
  assert.match(check.description, /інцидент визнано/);
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('FEED: acked share dropping below the baseline is WARN (further degradation)', () => {
  const ack: FeedLivenessAck = { acknowledgedAt: '2026-09-08T09:00:00.000Z', acknowledgedShare: 0.033 };
  // 50/3000 ≈ 1.7% < 3.3% baseline.
  const a = analyzeFeedLiveness({ total: 3000, inStock: 50, ack });
  assert.equal(a.degradedFromAck, true);
  assert.equal(a.level, 'warn');
  const checks = buildCatalogChecks(input({ feedLiveness: { total: 3000, inStock: 50, ack } }));
  const check = byId(checks, 'feed-liveness');
  assert.equal(check.level, 'warn');
  assert.equal(check.affectsStatus, true);
  assert.deepEqual(overallResult(checks), { status: 'WARN', exitCode: 1 });
});

test('FEED: high share with an ack still passes (ack never worsens the result)', () => {
  const ack: FeedLivenessAck = { acknowledgedAt: '2026-09-08T09:00:00.000Z', acknowledgedShare: 0.033 };
  assert.equal(analyzeFeedLiveness({ total: 100, inStock: 90, ack }).level, 'pass');
});

test('FEED: constants match the contract', () => {
  assert.equal(FEED_LIVENESS_WARN_SHARE, 0.5);
  assert.equal(FEED_LIVENESS_FAIL_SHARE, 0.2);
  assert.equal(FEED_LIVENESS_BASELINE_PATH, 'logs/feed-liveness-baseline.json');
});

test('FEED: production script computes the base (non-_du) share and reads the ack file', () => {
  const s = src('scripts/catalog-health-check.ts');
  // availability_status is selected for the feed share.
  assert.match(s, /select\('id, yugcontract_id, sku, slug, name, price, availability_status'\)/);
  // Base products only: non-empty yugcontract_id that does not end with _du.
  assert.match(s, /endsWith\('_du'\)/);
  // The ack file is read (never written) and wired into the classifier.
  assert.match(s, new RegExp(FEED_LIVENESS_BASELINE_PATH.replace('/', '\\/')));
  assert.match(s, /feedLiveness: \{/);
  assert.ok(!s.includes('writeFile'), 'health-check must never write the baseline file');
});

// ---- category drift (2026-09-06) ----

test('CATEGORIES: inserted_count > 0 in the newest categories batch is WARN', () => {
  const a = analyzeCategoriesBatch([
    batch({ phase: 'categories', batch_no: 0, inserted_count: 4, finished_at: new Date(NOW.getTime() - 5 * HOUR).toISOString() }),
  ]);
  assert.equal(a.lastInsertedCount, 4);
  const checks = buildCatalogChecks(
    input({ batches: [batch({ phase: 'categories', batch_no: 0, inserted_count: 4 })] })
  );
  const check = byId(checks, 'categories-drift');
  assert.equal(check.level, 'warn');
  assert.equal(check.count, 4);
  assert.deepEqual(overallResult(checks), { status: 'WARN', exitCode: 1 });
});

test('CATEGORIES: inserted_count 0 in the newest categories batch is PASS', () => {
  const checks = buildCatalogChecks(
    input({ batches: [batch({ phase: 'categories', batch_no: 0, inserted_count: 0 })] })
  );
  assert.equal(byId(checks, 'categories-drift').level, 'pass');
  assert.deepEqual(overallResult(checks), { status: 'PASS', exitCode: 0 });
});

test('CATEGORIES: the NEWEST categories batch decides (older inserts do not warn)', () => {
  const checks = buildCatalogChecks(
    input({
      batches: [
        batch({ run_id: 'old', phase: 'categories', batch_no: 0, inserted_count: 7, finished_at: new Date(NOW.getTime() - 96 * HOUR).toISOString() }),
        batch({ run_id: 'new', phase: 'categories', batch_no: 0, inserted_count: 0, finished_at: new Date(NOW.getTime() - 5 * HOUR).toISOString() }),
      ],
    })
  );
  assert.equal(byId(checks, 'categories-drift').level, 'pass');
  assert.equal(byId(checks, 'categories-drift').count, 0);
});

test('CATEGORIES: no categories batch at all is PASS (skip)', () => {
  const a = analyzeCategoriesBatch([batch({})]);
  assert.equal(a.lastInsertedCount, null);
  const checks = buildCatalogChecks(input());
  assert.equal(byId(checks, 'categories-drift').level, 'pass');
});

test('CATEGORIES: production script reads inserted_count from yc_import_batches', () => {
  const s = src('scripts/catalog-health-check.ts');
  assert.match(s, /finished_at, last_error, inserted_count/);
  assert.match(s, /categoriesDrift|categories-drift|analyzeCategoriesBatch/);
});
