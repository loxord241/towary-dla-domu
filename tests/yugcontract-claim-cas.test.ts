/**
 * Yugcontract import — atomic batch claiming (2026-09-01 audit, #3).
 *
 * Bug: claimNextBatch / claimNextContentBatch selected a batch, then ran an
 * UNCONDITIONAL `.update({ status: 'running' }).eq('id', ...)` — two parallel
 * POST /api/admin/yugcontract/import/run calls both read the same claimable
 * batch, both updates succeed, and both runners execute the same batch.
 *
 * Fix contract (no architecture / retry / idempotency changes):
 *   - compare-and-swap: the claim UPDATE carries `.eq('status', seenStatus)`;
 *   - stale-running reclaim additionally pins `.eq('started_at', seen)`;
 *   - the update uses `.select('id')` — an EMPTY result means another runner
 *     won the race, and the claimant moves on to the NEXT candidate;
 *   - identical protection in import-run.ts and content-import.ts.
 *
 * The tests drive an in-memory Supabase simulation that evaluates the eq()
 * conditions against LIVE row state at update-execution time, so a lost race
 * behaves exactly like PostgREST: 0 matched rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const { claimNextBatch, STALE_RUNNING_MS } = await import(
  '../app/lib/yugcontract/import-run.ts'
);
const { claimNextContentBatch } = await import(
  '../app/lib/yugcontract/content-import.ts'
);

const IMPORT_RUN = 'app/lib/yugcontract/import-run.ts';
const CONTENT_IMPORT = 'app/lib/yugcontract/content-import.ts';

// ---------------------------------------------------------------------------
// In-memory Supabase simulation (subset used by the claim path)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

interface Db {
  rows: Map<string, Row>;
  /** fired before each update's conditions are evaluated (race interleaving) */
  onBeforeUpdate?: (() => void) | null;
}

function makeClient(db: Db): SupabaseClient {
  const client = {
    from(_table: string) {
      const selectChain = {
        _eqs: [] as [string, unknown][],
        eq(col: string, val: unknown) {
          selectChain._eqs.push([col, val]);
          return selectChain;
        },
        order(_col: string, _opts?: unknown) {
          return selectChain;
        },
        range(_from: number, _to: number) {
          return selectChain;
        },
        returns<T>() {
          return selectChain as unknown as Promise<{ data: T[]; error: null }>;
        },
        then(
          resolve: (v: { data: Row[]; error: null }) => unknown,
          reject: (e: unknown) => unknown
        ) {
          const rows = [...db.rows.values()].filter((r) =>
            selectChain._eqs.every(([c, v]) => r[c] === v)
          );
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return {
        select: () => selectChain,
        update(fields: Partial<Row>) {
          const eqs: [string, unknown][] = [];
          const builder = {
            eq(col: string, val: unknown) {
              eqs.push([col, val]);
              return builder;
            },
            select(_cols: string) {
              return builder.exec(true);
            },
            then(
              resolve: (v: { data: { id: string }[] | null; error: null }) => unknown,
              reject: (e: unknown) => unknown
            ) {
              return builder.exec(false).then(resolve, reject);
            },
            exec(withData: boolean) {
              return Promise.resolve().then(() => {
                db.onBeforeUpdate?.();
                const matched: { id: string }[] = [];
                for (const r of db.rows.values()) {
                  if (eqs.every(([c, v]) => r[c] === v)) {
                    Object.assign(r, fields);
                    matched.push({ id: r.id });
                  }
                }
                return { data: withData ? matched : null, error: null };
              });
            },
          };
          return builder;
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

function importDb(batches: Array<Partial<Row> & { id: string }>): Db {
  return {
    rows: new Map(
      batches.map((b) => [
        b.id,
        {
          run_id: 'run-1',
          phase: 'products',
          batch_no: 1,
          status: 'pending',
          started_at: null,
          last_error: null,
          ...b,
        } as Row,
      ])
    ),
  };
}

const STALE_TS = new Date(Date.now() - STALE_RUNNING_MS - 60_000).toISOString();
const FRESH_TS = new Date().toISOString();

// ---------------- functional: import-run claim ----------------

test('CLAIM: import — the same pending batch is never claimed twice; claimants advance', async () => {
  const db = importDb([
    { id: 'cat-1', phase: 'categories', batch_no: 1, status: 'done' },
    { id: 'p1', batch_no: 1 },
    { id: 'p2', batch_no: 2 },
    { id: 'p3', batch_no: 3 },
  ]);
  const client = makeClient(db);
  const a = await claimNextBatch(client, 'run-1');
  assert.equal(a?.id, 'p1');
  assert.equal(a?.status, 'running');
  // CAS fields actually landed
  assert.equal(db.rows.get('p1')!.status, 'running');
  assert.ok(db.rows.get('p1')!.started_at);
  assert.equal(db.rows.get('p1')!.last_error, null);
  const b = await claimNextBatch(client, 'run-1');
  assert.equal(b?.id, 'p2', 'second runner must get a DIFFERENT batch');
  const c = await claimNextBatch(client, 'run-1');
  assert.equal(c?.id, 'p3');
  const d = await claimNextBatch(client, 'run-1');
  assert.equal(d, null, 'nothing claimable left');
});

test('CLAIM: import — losing the race on one batch moves the claimant to the next', async () => {
  const db = importDb([
    { id: 'cat-1', phase: 'categories', batch_no: 1, status: 'done' },
    { id: 'p1', batch_no: 1 },
    { id: 'p2', batch_no: 2 },
  ]);
  // Simulate a concurrent winner: p1 flips to 'running' between our SELECT
  // and our UPDATE, so the CAS on status='pending' matches 0 rows.
  let fired = false;
  db.onBeforeUpdate = () => {
    if (!fired) {
      fired = true;
      db.rows.get('p1')!.status = 'running';
    }
  };
  const got = await claimNextBatch(makeClient(db), 'run-1');
  assert.equal(got?.id, 'p2', 'claimant must skip the batch it lost and claim the next');
  // Our update must NOT have touched the batch we lost.
  assert.equal(db.rows.get('p1')!.started_at, null, 'lost batch must keep the winner’s started_at');
});

test('CLAIM: import — stale running is reclaimable, and a re-claimed batch cannot be intercepted', async () => {
  // 1) reclaim works: running + stale started_at is claimable again
  const db1 = importDb([
    { id: 'cat-1', phase: 'categories', batch_no: 1, status: 'done' },
    { id: 'r1', status: 'running', started_at: STALE_TS },
  ]);
  const reclaimed = await claimNextBatch(makeClient(db1), 'run-1');
  assert.equal(reclaimed?.id, 'r1', 'stale running must be reclaimable');
  assert.notEqual(db1.rows.get('r1')!.started_at, STALE_TS, 'reclaim refreshes started_at');

  // 2) the started_at pin: another runner re-claims the stale batch between
  //    our SELECT and our UPDATE — our started_at guard now misses → we lose.
  const db2 = importDb([
    { id: 'cat-1', phase: 'categories', batch_no: 1, status: 'done' },
    { id: 'r1', status: 'running', started_at: STALE_TS },
  ]);
  db2.onBeforeUpdate = () => {
    // the concurrent winner restarts the batch with a FRESH started_at
    db2.rows.get('r1')!.started_at = FRESH_TS;
  };
  const lost = await claimNextBatch(makeClient(db2), 'run-1');
  assert.equal(lost, null, 'a re-claimed (fresh started_at) batch must not be intercepted');
  assert.equal(db2.rows.get('r1')!.started_at, FRESH_TS, 'the winner’s restart stands');
});

// ---------------- functional: content claim ----------------

test('CLAIM: content — same CAS protection (no double claim, lost race → next candidate)', async () => {
  const db = importDb([{ id: 'c1', batch_no: 1 }, { id: 'c2', batch_no: 2 }]);
  const client = makeClient(db);
  const a = await claimNextContentBatch(client, 'run-1');
  assert.equal(a?.id, 'c1');
  const b = await claimNextContentBatch(client, 'run-1');
  assert.equal(b?.id, 'c2', 'content claim must also advance past claimed batches');
  const c = await claimNextContentBatch(client, 'run-1');
  assert.equal(c, null);

  // lost race: c1 flips to running between select and update
  const db2 = importDb([{ id: 'c1', batch_no: 1 }, { id: 'c2', batch_no: 2 }]);
  db2.onBeforeUpdate = () => {
    db2.rows.get('c1')!.status = 'running';
  };
  const got = await claimNextContentBatch(makeClient(db2), 'run-1');
  assert.equal(got?.id, 'c2');
  assert.equal(db2.rows.get('c1')!.started_at, null, 'lost batch untouched');
});

// ---------------- source invariants ----------------

test('CLAIM: both claim fns use status CAS + started_at pin + select + empty-result skip', () => {
  for (const [file, table] of [
    [IMPORT_RUN, 'yc_import_batches'],
    [CONTENT_IMPORT, 'yc_content_batches'],
  ] as const) {
    const s = src(file);
    const claimStart = s.indexOf(`from('${table}')`);
    const updateStart = s.indexOf('.update({', claimStart);
    const segment = s.slice(updateStart, updateStart + 900);
    assert.match(segment, /\.eq\('status', next\.status\)/, `${file}: status CAS guard missing`);
    assert.match(segment, /\.eq\('started_at'/, `${file}: started_at pin for stale reclaim missing`);
    assert.match(segment, /\.select\('id'\)/, `${file}: update must select to detect the race`);
    assert.match(
      segment,
      /data\.length === 0\)?\s*continue;|!data \|\| data\.length === 0\)?\s*continue;/,
      `${file}: empty select result must skip to the next candidate`
    );
  }
});

test('CLAIM: retry semantics and staleness window unchanged', () => {
  const run = src(IMPORT_RUN);
  const content = src(CONTENT_IMPORT);
  assert.match(run, /b\.status === 'pending' \|\| b\.status === 'failed'\) return true/);
  assert.match(content, /b\.status === 'pending' \|\| b\.status === 'failed'\) return true/);
  assert.match(run, /STALE_RUNNING_MS = 10 \* 60 \* 1000/);
  assert.doesNotMatch(run, /STALE_RUNNING_MS = (?!10 \* 60 \* 1000)/);
});
