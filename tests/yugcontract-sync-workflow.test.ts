/**
 * Yugcontract GitHub Actions sync workflow invariants (OPS stage 3).
 *
 * The workflow is a scheduler wrapper around the canonical importer CLI
 * (scripts/yugcontract-import-run.ts) — no DB access, no payments, and
 * production writes stay gated behind an explicit GO until the repository
 * variable YUGCONTRACT_SYNC_ENABLED is set. These checks pin that contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yml = readFileSync('.github/workflows/yugcontract-sync.yml', 'utf8');

test('workflow exists with expected name', () => {
  assert.match(yml, /^name: Yugcontract scheduled sync$/m);
});

test('concurrency lock: group yugcontract-sync, no cancel-in-progress', () => {
  assert.match(yml, /concurrency:\n\s+group: yugcontract-sync\n\s+cancel-in-progress: false\n/);
});

test('manual workflow_dispatch is available', () => {
  assert.match(yml, /^\s{2}workflow_dispatch:\s*$/m);
});

test('schedule is the agreed every-6-hours cron', () => {
  assert.match(yml, /^\s+- cron: "17 \*\/6 \* \* \*"\s*$/m);
});

test('schedule is GO-gated behind YUGCONTRACT_SYNC_ENABLED repo variable', () => {
  assert.match(yml, /if: vars\.YUGCONTRACT_SYNC_ENABLED == 'true'/);
});

test('minimal permissions only', () => {
  const permBlock = yml.match(/^permissions:\n(?:  .+\n)+/m)?.[0] ?? '';
  assert.match(permBlock, /contents: read/);
  for (const over of ['write', 'packages', 'id-token', 'deployments']) {
    assert.doesNotMatch(permBlock, new RegExp(over), `permission "${over}" not allowed`);
  }
});

test('only the canonical importer command is invoked', () => {
  assert.match(
    yml,
    /run: node scripts\/yugcontract-import-run\.ts --run\s*$/m,
    'must call the canonical CLI in --run mode'
  );
});

test('no nonexistent or dangerous CLI flags', () => {
  assert.doesNotMatch(yml, /--apply|--fix|--repair|--plan\b.*&&|--force/);
});

test('only the real env vars are passed as secrets', () => {
  const used = [...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(used)], [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'YUGCONTRACT_SECRET',
    'YUGCONTRACT_USER_KEY',
  ]);
});

test('no direct DB mutations or payment credentials in workflow', () => {
  assert.doesNotMatch(yml, /psql|supabase db|yugcontract-import-batches|LIQPAY/i);
});

test('no secret leakage vectors', () => {
  assert.doesNotMatch(yml, /set -x|set -v\b|-x\b.*echo|echo \$\{|env:.*-\$|tee |artifacts?/i);
});
