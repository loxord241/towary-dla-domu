/**
 * Regression tests for the CRITICAL parent-resolution fix in
 * applyCategoryPlan (app/lib/yugcontract/import-run.ts).
 *
 * Bug: parent_id was resolved from a PER-CHUNK extToUuid snapshot taken
 * BEFORE the chunk INSERT returned, so a child whose parent sat in the
 * SAME chunk was inserted with parent_id = NULL (extToUuid only learns
 * new uuids after insertChunked returns for the whole chunk). Deep trees
 * silently lost parent links.
 *
 * Fix contract (confirmed scheme, nothing else changes):
 *   1. creates are inserted WITHOUT parent_id;
 *   2. after ALL create chunks are inserted, the FULL extToUuid exists;
 *   3. a separate update pass sets parent_id;
 *   4. depth order of creates is untouched;
 *   5. invariant: after applyCategoryPlan there is no NULL parent_id
 *      where the parent row exists.
 *
 * The tests drive an in-memory Supabase simulation (insert/update/select
 * chain subset used by applyCategoryPlan) — no network, no DB, no env.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

const { applyCategoryPlan } = await import('../app/lib/yugcontract/import-run.ts');
const { buildCategoryPlan } = await import('../app/lib/yugcontract/import-plan.ts');
type CategoryPlan = import('../app/lib/yugcontract/import-plan.ts').CategoryPlan;
type CategoryCreateOp = import('../app/lib/yugcontract/import-plan.ts').CategoryCreateOp;
type CategoryUpdateOp = import('../app/lib/yugcontract/import-plan.ts').CategoryUpdateOp;

// ---------------------------------------------------------------------------
// In-memory Supabase simulation (subset used by applyCategoryPlan)
// ---------------------------------------------------------------------------

interface CatRow {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  yugcontract_id: string | null;
}

function makeClient(seed: CatRow[] = []) {
  const rows = new Map<string, CatRow>();
  for (const r of seed) rows.set(r.id, { ...r });
  let nextSeq = 1;
  /** every insert() payload, in call order — pins scheme point 1 */
  const insertPayloads: Record<string, unknown>[][] = [];

  const client = {
    from(table: string) {
      assert.equal(table, 'categories', 'applyCategoryPlan must only touch categories');
      return {
        select(_cols: string) {
          const chain = {
            _range: null as [number, number] | null,
            order() {
              return chain;
            },
            range(from: number, to: number) {
              chain._range = [from, to];
              return chain;
            },
            returns<T>() {
              const all = [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
              const [f, t] = chain._range ?? [0, 0];
              return Promise.resolve({ data: all.slice(f, t + 1) as T[], error: null });
            },
            then(
              resolve: (v: unknown) => unknown,
              reject: (e: unknown) => unknown
            ) {
              return chain.returns().then(resolve, reject);
            },
          };
          return chain;
        },
        insert(part: Record<string, unknown>[]) {
          insertPayloads.push(part.map((r) => ({ ...r })));
          const exec = () =>
            Promise.resolve().then(() => {
              const out: { id: string; yugcontract_id: unknown }[] = [];
              for (const r of part) {
                const id = `new-${nextSeq}`;
                nextSeq += 1;
                rows.set(id, {
                  id,
                  parent_id: (r.parent_id as string | null) ?? null,
                  name: r.name as string,
                  slug: r.slug as string,
                  yugcontract_id: r.yugcontract_id as string | null,
                });
                out.push({ id, yugcontract_id: r.yugcontract_id });
              }
              return { data: out, error: null };
            });
          return {
            select() {
              return exec();
            },
            then(
              resolve: (v: { data: { id: string }[] | null; error: null }) => unknown,
              reject: (e: unknown) => unknown
            ) {
              return exec().then(resolve, reject);
            },
          };
        },
        update(fields: Record<string, unknown>) {
          const eqs: [string, unknown][] = [];
          const builder = {
            eq(col: string, val: unknown) {
              eqs.push([col, val]);
              return builder;
            },
            then(
              resolve: (v: { data: { id: string }[] | null; error: null }) => unknown,
              reject: (e: unknown) => unknown
            ) {
              return Promise.resolve().then(() => {
                let n = 0;
                for (const r of rows.values()) {
                  if (eqs.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v)) {
                    Object.assign(r, fields);
                    n += 1;
                  }
                }
                return { data: n > 0 ? [{ id: 'ok' }] : null, error: null };
              }).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rows,
    insertPayloads,
    byYc(ycId: string): CatRow | undefined {
      return [...rows.values()].find((r) => r.yugcontract_id === ycId);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createOp(
  ycId: string,
  parentYcId: string | null,
  name = `Категорія ${ycId}`
): CategoryCreateOp {
  return { yugcontract_id: ycId, name, slug: `slug-${ycId}`, parentYcId };
}

function planOf(
  creates: CategoryCreateOp[],
  updates: CategoryUpdateOp[] = []
): CategoryPlan {
  return { creates, updates, conflicts: [] };
}

function seed(overrides: Partial<CatRow> & { id: string; yugcontract_id: string | null }): CatRow {
  return {
    parent_id: null,
    name: `Категорія ${overrides.yugcontract_id ?? overrides.id}`,
    slug: `slug-${overrides.yugcontract_id ?? overrides.id}`,
    ...overrides,
  } as CatRow;
}

/** invariant: every expected child row must carry its parent's uuid */
function assertNoOrphans(db: ReturnType<typeof makeClient>, childToParent: [string, string][]) {
  for (const [childYc, parentYc] of childToParent) {
    const parentRow = db.byYc(parentYc);
    assert.ok(parentRow, `parent ${parentYc} must exist`);
    const childRow = db.byYc(childYc);
    assert.ok(childRow, `child ${childYc} must exist`);
    assert.equal(
      childRow.parent_id,
      parentRow.id,
      `child ${childYc} has NULL/wrong parent_id while parent ${parentYc} exists`
    );
  }
}

// ---------------- core bug: parent + child in the SAME chunk ----------------

test('APPLY: parent + child in one chunk — child gets parent_id (was NULL)', async () => {
  const db = makeClient();
  // Both ops land in the SAME chunk (CHUNK=200): depth-sorted, parent first.
  const plan = planOf([createOp('1', null), createOp('2', '1')]);

  const res = await applyCategoryPlan(db.client, plan);

  assert.equal(res.inserted, 2);
  assert.equal(res.errors, 0);
  const parent = db.byYc('1');
  const child = db.byYc('2');
  assert.ok(parent && child);
  assert.equal(child.parent_id, parent.id, 'child must link to the parent uuid');

  // Scheme point 1: creates were inserted WITHOUT parent_id...
  assert.equal(db.insertPayloads.length, 1);
  for (const payload of db.insertPayloads.flat()) {
    assert.equal(payload.parent_id, null, 'insert payload must carry parent_id: null');
  }
  // ...and scheme point 3: the separate update pass wired the parent.
  assertNoOrphans(db, [['2', '1']]);
});

// ---------------- chunk boundary (regression: must keep working) ------------

test('APPLY: parent on the last row of a chunk, child on the first of the next', async () => {
  const db = makeClient();
  const creates: CategoryCreateOp[] = [];
  for (let i = 0; i < 199; i += 1) creates.push(createOp(`f${i}`, null, `Наповнювач ${i}`));
  creates.push(createOp('100', null)); // index 199 → last row of chunk 1
  creates.push(createOp('101', '100')); // index 200 → first row of chunk 2
  const plan = planOf(creates);

  const res = await applyCategoryPlan(db.client, plan);

  assert.equal(res.inserted, 201);
  const parent = db.byYc('100');
  const child = db.byYc('101');
  assert.ok(parent && child);
  assert.equal(child.parent_id, parent.id);
  assertNoOrphans(db, [['101', '100']]);
});

// ---------------- existing parent ----------------

test('APPLY: existing parent + new child — child links to the existing uuid', async () => {
  const db = makeClient([seed({ id: 'p-uuid', yugcontract_id: '10' })]);
  const plan = planOf([createOp('11', '10')]);

  const res = await applyCategoryPlan(db.client, plan);

  assert.equal(res.inserted, 1);
  assert.equal(res.errors, 0);
  const child = db.byYc('11');
  assert.ok(child);
  assert.equal(child.parent_id, 'p-uuid');
});

test('APPLY: existing parent + existing child — update pass reparents', async () => {
  const db = makeClient([
    seed({ id: 'p-uuid', yugcontract_id: '10' }),
    seed({ id: 'c-uuid', yugcontract_id: '11', parent_id: null }),
  ]);
  const plan = planOf([], [{ id: 'c-uuid', parentYcId: '10' }]);

  const res = await applyCategoryPlan(db.client, plan);

  assert.equal(res.inserted, 0);
  assert.equal(res.updated, 1);
  assert.equal(res.errors, 0);
  assert.equal(db.byYc('11')?.parent_id, 'p-uuid');
});

// ---------------- idempotent re-run ----------------

test('APPLY: repeated run is idempotent and repairs legacy NULL parents', async () => {
  const nodes = [
    { externalId: '1', parentId: null, name: 'Корінь', levelHint: null },
    { externalId: '2', parentId: '1', name: 'Дитина', levelHint: null },
  ];
  const expanded = new Set(['1', '2']);

  // Legacy broken state: both rows exist (a previous run crashed after the
  // inserts), the child's parent link was lost — parent_id NULL.
  const db = makeClient([
    seed({ id: 'r-uuid', yugcontract_id: '1', name: 'Корінь' }),
    seed({ id: 'c-uuid', yugcontract_id: '2', name: 'Дитина', parent_id: null }),
  ]);
  const toExisting = () =>
    [...db.rows.values()].map((r) => ({
      id: r.id,
      parent_id: r.parent_id,
      name: r.name,
      slug: r.slug,
      yugcontract_id: r.yugcontract_id,
    }));

  const plan1 = buildCategoryPlan(nodes, expanded, toExisting());
  assert.equal(plan1.creates.length, 0);
  assert.equal(plan1.updates.length, 1, 'broken parent link must be planned as an update');

  const res1 = await applyCategoryPlan(db.client, plan1);
  assert.equal(res1.inserted, 0);
  assert.equal(res1.updated, 1);
  assert.equal(res1.errors, 0);
  assert.equal(db.byYc('2')?.parent_id, 'r-uuid');

  // Second (idempotent) run: nothing to do, state stays put.
  const plan2 = buildCategoryPlan(nodes, expanded, toExisting());
  assert.equal(plan2.creates.length, 0);
  assert.equal(plan2.updates.length, 0);
  const res2 = await applyCategoryPlan(db.client, plan2);
  assert.equal(res2.inserted, 0);
  assert.equal(res2.updated, 0);
  assert.equal(res2.errors, 0);
  assert.equal(db.byYc('2')?.parent_id, 'r-uuid');
});

// ---------------- roots stay roots ----------------

test('APPLY: root creates and existing root categories keep parent_id = NULL', async () => {
  const db = makeClient([
    seed({ id: 'yc-root-uuid', yugcontract_id: '70' }), // existing YC root
    seed({ id: 'manual-root-uuid', yugcontract_id: null, slug: 'ruchna', name: 'Ручна' }), // manual root
  ]);
  const plan = planOf([createOp('71', null), createOp('72', '71')]);

  const res = await applyCategoryPlan(db.client, plan);

  assert.equal(res.inserted, 2);
  assert.equal(db.byYc('70')?.parent_id, null, 'existing YC root must stay a root');
  assert.equal(
    db.rows.get('manual-root-uuid')?.parent_id,
    null,
    'manual root must stay a root'
  );
  assert.equal(db.byYc('71')?.parent_id, null, 'new root must stay a root');
  assert.equal(db.byYc('72')?.parent_id, db.byYc('71')?.id);
});
