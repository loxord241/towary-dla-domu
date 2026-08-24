/**
 * Silent-truncation hardening tests.
 *
 * The mock client simulates the REAL Supabase behaviour that caused the
 * production bug: a single response never returns more than `cap` rows,
 * even when .range() asks for a wider window (live-verified: PAGE=5000
 * returned exactly 1000 of 4323 products).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const { fetchAllRows } = await import('../app/lib/yugcontract/import-run.ts');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

interface MockState {
  requests: number;
  windows: [number, number][];
}

/** Chainable mock: server honours the window start but caps rows at `cap`. */
function makeMockClient(rows: unknown[], cap = 1000) {
  const state: MockState = { requests: 0, windows: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    from(_table: string) {
      return {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        select(_select: string) {
          const builder = {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            order(_col: string, _opts?: unknown) {
              return builder;
            },
            range(from: number, to: number) {
              state.requests += 1;
              state.windows.push([from, to]);
              const windowSize = to - from + 1;
              const slice = rows.slice(from, from + Math.min(windowSize, cap));
              return {
                data: slice,
                error: null as { message: string } | null,
                returns<T>() {
                  return { data: slice as T[], error: null };
                },
              };
            },
          };
          return builder;
        },
      };
    },
  };
  return { client, state };
}

function makeRows(n: number): { id: number }[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
}

test('fetchAllRows: 2500 rows → 3 requests → all 2500 returned, no gaps/dups', async () => {
  const rows = makeRows(2500);
  const { client, state } = makeMockClient(rows);
  const out = await fetchAllRows<{ id: number }>(
    client,
    'products',
    'id'
  );
  assert.equal(state.requests, 3);
  assert.equal(out.length, 2500);
  assert.deepEqual(out.map((r) => r.id), rows.map((r) => r.id));
});

test('fetchAllRows: exactly 1000 rows → data complete after the boundary probe', async () => {
  // With cap-semantics a FULL page is indistinguishable from "more data
  // exists", so the loop MUST issue one extra probe returning 0 rows.
  // (A Content-Range header could avoid the probe; supabase-js .range()
  // pattern used project-wide cannot.) Data correctness is what matters.
  const rows = makeRows(1000);
  const { client, state } = makeMockClient(rows);
  const out = await fetchAllRows<{ id: number }>(client, 't', 'id');
  assert.equal(state.requests, 2);
  assert.equal(state.windows[1][0], 1000);
  assert.equal(out.length, 1000);
});

test('fetchAllRows: 1001 rows → 2 requests → 1001 returned', async () => {
  const rows = makeRows(1001);
  const { client, state } = makeMockClient(rows);
  const out = await fetchAllRows<{ id: number }>(client, 't', 'id');
  assert.equal(state.requests, 2);
  assert.equal(out.length, 1001);
  assert.deepEqual(out[out.length - 1], { id: 1001 });
});

test('fetchAllRows: windows are contiguous [0..999],[1000..1999],… (no off-by-one)', async () => {
  const rows = makeRows(2001);
  const { client, state } = makeMockClient(rows);
  await fetchAllRows(client, 't', 'id');
  assert.deepEqual(
    state.windows.map(([f, t]) => [f, t]),
    [
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]
  );
});

test('fetchAllRows: empty table → single request, empty result', async () => {
  const { client, state } = makeMockClient([]);
  const out = await fetchAllRows<unknown>(client, 't', 'id');
  assert.equal(state.requests, 1);
  assert.equal(out.length, 0);
});

// ---- project-wide static invariants -----------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

test('INVARIANT: no PAGE/PAGE_SIZE declaration > 1000 in app/ or scripts/', () => {
  for (const file of [
    ...walk(path.join(root, 'app')),
    ...readdirSync(path.join(root, 'scripts'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(root, 'scripts', f)),
  ]) {
    const src = readFileSync(file, 'utf8');
    // declarations only — comments may legitimately mention old values
    for (const m of src.matchAll(
      /(?:const|let)\s+(PAGE(?:_SIZE)?|PAGE_WINDOW)\s*=\s*(\d+)/g
    )) {
      const v = Number(m[2]);
      assert.ok(
        v <= 1000,
        `${path.relative(root, file)}: ${m[1]}=${v} — PostgREST отдаёт максимум 1000 строк за ответ`
      );
    }
  }
});

test('INVARIANT: preview route pages with PAGE_SIZE=1000 and terminates on it', () => {
  const src = readFileSync(
    path.join(root, 'app/api/admin/yugcontract/preview/route.ts'),
    'utf8'
  );
  assert.match(src, /const PAGE_SIZE = 1000;/);
  assert.match(src, /range\(from, from \+ PAGE_SIZE - 1\)/);
  assert.match(src, /batch\.length < PAGE_SIZE/);
});

test('INVARIANT: admin list queries have an id tiebreaker after created_at', () => {
  for (const rel of [
    'app/api/admin/products/route.ts',
    'app/api/admin/orders/route.ts',
  ]) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    if (!src.includes(".order('created_at'")) continue;
    assert.ok(
      src.includes(".order('id'"),
      `${rel}: offset-paginated created_at sort требует .order('id') tiebreaker`
    );
  }
});

test('INVARIANT: admin products UI no longer masks truncation via rows-length total', () => {
  const ui = readFileSync(
    path.join(root, 'app/admin/(dashboard)/products/page.tsx'),
    'utf8'
  );
  assert.ok(!ui.includes('?? rows.length'));
  assert.match(ui, /page=\$\{page \?\? 1\}/); // always sends explicit paging
});
