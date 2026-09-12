/**
 * Yugcontract sync launcher invariants (audit 2026-09-12, P1).
 *
 * Two defects are pinned closed here:
 *   1. NO TIMEOUT: a hung importer used to hold the flock forever while every
 *      later trigger silently exited 0 — each phase must now run under a hard
 *      `timeout` and a timeout must produce an explicit log line + non-zero
 *      exit (124), never a silent success.
 *   2. DISHONEST SUCCESS STAMP: a run skipped by the importer's 48h DB gate
 *      ("skipping (< 48h interval)", exit 0, no work done) must NOT refresh
 *      the last-success stamp, otherwise the real working-sync interval
 *      stretches to ~4 days (47h local gate + 47h DB gate).
 *
 * Source-invariant style (matches the rest of tests/): pins regex markers in
 * scripts/wsl/yugcontract-sync.sh and scripts/windows/yugcontract-sync.ps1.
 * The GitHub Actions workflow pins live in yugcontract-sync-workflow.test.ts;
 * the workflow calls the importer CLI directly (not this launcher), so the
 * launcher's exit-code surface is free to evolve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const sh = readFileSync(join(root, 'scripts/wsl/yugcontract-sync.sh'), 'utf8');
const ps1 = readFileSync(join(root, 'scripts/windows/yugcontract-sync.ps1'), 'utf8');

// ---------------------------------------------------------------------------
// 1. per-phase hard timeout (no more forever-held flock)
// ---------------------------------------------------------------------------

test('sh launcher runs every phase under a hard timeout', () => {
  const invocations = sh.match(/^run_phase [^\n]*node scripts\/[^\n]*$/gm) ?? [];
  assert.deepEqual(
    invocations.map((l) => l.replace(/\s+$/, '')),
    [
      'run_phase "$CAPTURE" node scripts/yugcontract-import-run.ts --run ${FORCE:+--force}',
      'run_phase /dev/null node scripts/yugcontract-content-fetch.ts --stage',
      'run_phase /dev/null node scripts/yugcontract-content-apply.ts --run',
      'run_phase /dev/null node scripts/yugcontract-content-images.ts --run',
    ],
    'every importer phase must go through run_phase (the timeout wrapper); ' +
      'no phase may bypass it'
  );
  // the wrapper itself must apply `timeout`
  assert.match(sh, /timeout "\$SYNC_TIMEOUT_SECS" "\$@" 2>&1 \| log_pipe/);
});

test('sh launcher timeout has a sane default and is overridable', () => {
  // a full sync takes minutes (docs/wsl-sync.md §7); 30m is a wide margin
  assert.match(sh, /SYNC_TIMEOUT_SECS="\$\{YUGCONTRACT_SYNC_TIMEOUT_SECS:-1800\}"/);
});

test('sh launcher: timeout is a loud non-zero failure, not a silent exit 0', () => {
  // explicit message naming the hung phase
  assert.match(sh, /TIMED OUT after \$\{SYNC_TIMEOUT_SECS\}s and was killed/);
  // GNU timeout convention exit code, propagated to the caller
  assert.match(sh, /-eq 124/);
  assert.match(sh, /exit 124/);
});

test('sh launcher documents the timeout exit codes', () => {
  assert.match(sh, /#   7\s+coreutils 'timeout' not found/);
  assert.match(sh, /#   124\s+a phase exceeded its hard timeout/);
});

// ---------------------------------------------------------------------------
// 2. honest success stamp (DB-gate skips never stamp)
// ---------------------------------------------------------------------------

test('sh launcher pins the importer DB-gate skip marker', () => {
  // marker must match what scripts/yugcontract-import-run.ts prints
  const importer = readFileSync(
    join(root, 'scripts/yugcontract-import-run.ts'),
    'utf8'
  );
  const marker = sh.match(/GATE_SKIP_MARKER='([^']+)'/)?.[1] ?? '';
  assert.ok(marker.length > 0, 'GATE_SKIP_MARKER must be defined');
  assert.ok(
    importer.includes(marker),
    'launcher marker must be a substring of the importer gate-skip message'
  );
});

test('sh launcher: DB-gate skip does NOT refresh the success stamp', () => {
  assert.match(sh, /GATE_SKIPPED=0/);
  assert.match(sh, /grep -qF "\$GATE_SKIP_MARKER" "\$CAPTURE"/);
  // the stamp write is gated on GATE_SKIPPED: the gate-skip branch exits
  // BEFORE the stamp line
  const gateSkipIdx = sh.indexOf('GATE_SKIPPED=1');
  const gateSkipExit = sh.indexOf('exit 0', gateSkipIdx);
  const stampIdx = sh.indexOf('date +%s > "$LAST_STAMP"');
  assert.ok(gateSkipIdx !== -1 && gateSkipExit !== -1 && stampIdx !== -1);
  assert.ok(
    gateSkipExit < stampIdx,
    'gate-skip run must exit before reaching the stamp write'
  );
  assert.match(
    sh,
    /products phase was 48h-gate-skipped; last-success stamp NOT updated/
  );
});

test('sh launcher still stamps real successful runs', () => {
  assert.match(sh, /date \+%s > "\$LAST_STAMP"/);
});

test('windows launcher: DB-gate skip does NOT refresh the success stamp', () => {
  // importer gate-skip detection happens on captured output...
  assert.match(ps1, /\$importerOutput -match \[regex\]::Escape\('skipping \(< 48h interval\):'\)/);
  // ...and the stamp write happens only in the final else branch
  const stampIdx = ps1.indexOf("Set-Content -LiteralPath $stampPath");
  const gateSkipIdx = ps1.indexOf("48h DB gate skipped the run - success stamp NOT updated");
  assert.ok(stampIdx !== -1 && gateSkipIdx !== -1);
  assert.ok(
    gateSkipIdx < stampIdx,
    'gate-skip message must come before the stamp write (else-branch ordering)'
  );
  assert.match(ps1, /done \(48h DB gate skipped the run - success stamp NOT updated\)/);
});

// ---------------------------------------------------------------------------
// pre-existing invariants that must survive the changes
// ---------------------------------------------------------------------------

test('sh launcher keeps --force forwarding to the importer', () => {
  assert.match(sh, /--run \$\{FORCE:\+--force\}/);
});

test('sh launcher keeps lock, log scrub and interval gate', () => {
  assert.match(sh, /flock -n 9/);
  assert.match(sh, /redacted env-like line/);
  assert.match(sh, /-lt 47/);
  assert.match(sh, /yugcontract-last-success/);
});
