/**
 * Unit tests for the Yugcontract category remap pure logic (incident
 * 2026-09: supplier changed category ids). Covers: full-path matching,
 * name normalization, cross-branch duplicate names, ambiguity, unmatched,
 * bijection conflicts, the post-remap importer forecast (buildCategoryPlan
 * reuse), selection draft mapping and apply.sql generation. Pure — no
 * network, no DB.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeNameKey,
  buildSupplierPathIndex,
  buildOurPath,
  buildRemapMapping,
  verifyBijection,
  forecastRemap,
  mapSelectionTree,
  buildApplySql,
  PATH_SEPARATOR,
} = await import('../app/lib/yugcontract/category-remap.ts');
const { SELECTED_CATEGORIES } = await import('../app/lib/yugcontract/selection.ts');
import type { YcCategoryNode } from '../app/lib/yugcontract/types.ts';
import type { OurCategoryRow } from '../app/lib/yugcontract/category-remap.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fresh supplier tree with the SAME name structure but new ids. */
const SUPPLIER_NODES: YcCategoryNode[] = [
  { externalId: '9001', parentId: null, name: 'ПОБУТОВА ТЕХНІКА', levelHint: 0 },
  { externalId: '9002', parentId: '9001', name: 'Кліматична техніка', levelHint: 1 },
  { externalId: '9003', parentId: '9002', name: 'Кондиціонери', levelHint: 2 },
  { externalId: '9004', parentId: '9002', name: 'Вентилятори', levelHint: 2 },
  { externalId: '9005', parentId: '9001', name: 'Вбудована техніка', levelHint: 1 },
  { externalId: '9006', parentId: '9005', name: 'Духові шафи', levelHint: 2 },
  { externalId: '9007', parentId: '9001', name: 'Кухонне приладдя', levelHint: 1 },
  { externalId: '9008', parentId: '9007', name: 'Глечики', levelHint: 2 },
  { externalId: '9009', parentId: '9001', name: 'Питне скло', levelHint: 1 },
  { externalId: '9010', parentId: '9009', name: 'Глечики', levelHint: 2 }, // duplicate leaf name, OTHER branch
  { externalId: '9011', parentId: '9009', name: 'Глечики', levelHint: 2 }, // ambiguous: same path twice
];

/** Our snapshot: OLD ids (2026-08 import), same names/structure. */
const OUR_ROWS: OurCategoryRow[] = [
  { id: 'uuid-root', yugcontract_id: '1186', name: 'ПОБУТОВА ТЕХНІКА', slug: 'pobutova-tehnika-1186', parent_id: null },
  { id: 'uuid-clim', yugcontract_id: '740', name: 'Кліматична техніка', slug: 'klimatychna-tehnika-740', parent_id: 'uuid-root' },
  { id: 'uuid-cond', yugcontract_id: '180', name: 'Кондиціонери', slug: 'kondytsionery-180', parent_id: 'uuid-clim' },
  { id: 'uuid-vent', yugcontract_id: '177', name: 'Вентилятори', slug: 'ventylyatory-177', parent_id: 'uuid-clim' },
  { id: 'uuid-embed', yugcontract_id: '1304', name: 'Вбудована техніка', slug: 'vbudovana-tehnika-1304', parent_id: 'uuid-root' },
  { id: 'uuid-oven', yugcontract_id: '202', name: 'Духові шафи', slug: 'dukhovi-shafy-202', parent_id: 'uuid-embed' },
  { id: 'uuid-kitch', yugcontract_id: '884', name: 'Кухонне приладдя', slug: 'kukhonne-pryladdia-884', parent_id: 'uuid-root' },
  // "Глечики" under Кухонне приладдя -> unique path -> 9008
  { id: 'uuid-jug-k', yugcontract_id: '1347', name: 'Глечики', slug: 'glechyky-1347', parent_id: 'uuid-kitch' },
  // "Глечики" under Питне скло -> path has TWO supplier candidates -> ambiguous
  { id: 'uuid-jug-p', yugcontract_id: '1373', name: 'Глечики', slug: 'glechyky-1373', parent_id: 'uuid-root-pitne' },
  // manual category (no yc id) — participates as a path node only
  { id: 'uuid-root-pitne', yugcontract_id: null, name: 'Питне скло', slug: 'pytne-sklo', parent_id: 'uuid-root' },
  // disappeared from the fresh tree -> unmatched
  { id: 'uuid-gone', yugcontract_id: '5555', name: 'Осушувачі повітря', slug: 'osushuvachi-5555', parent_id: 'uuid-clim' },
];

// ---------------------------------------------------------------------------
// normalizeNameKey
// ---------------------------------------------------------------------------

test('normalizeNameKey collapses whitespace, case and trims', () => {
  assert.equal(normalizeNameKey('  ПОБУТОВА   техніка \t'), 'побутова техніка');
  assert.equal(normalizeNameKey("Краса та  здоров'я"), "краса та здоров'я");
  assert.equal(normalizeNameKey(''), '');
});

// ---------------------------------------------------------------------------
// path index / our path
// ---------------------------------------------------------------------------

test('buildSupplierPathIndex keys nodes by full root->node name path', () => {
  const idx = buildSupplierPathIndex(SUPPLIER_NODES);
  const condPath = ['побутова техніка', 'кліматична техніка', 'кондиціонери'].join(PATH_SEPARATOR);
  assert.deepEqual(idx.get(condPath), ['9003']);
});

test('identical leaf names in DIFFERENT branches stay distinct paths', () => {
  const idx = buildSupplierPathIndex(SUPPLIER_NODES);
  const jugKitchen = ['побутова техніка', 'кухонне приладдя', 'глечики'].join(PATH_SEPARATOR);
  const jugGlass = ['побутова техніка', 'питне скло', 'глечики'].join(PATH_SEPARATOR);
  assert.deepEqual(idx.get(jugKitchen), ['9008']);
  // Питне скло/Глечики exists twice in the fixture -> both candidates under one path
  assert.deepEqual(idx.get(jugGlass), ['9010', '9011']);
  assert.notEqual(jugKitchen, jugGlass);
});

test('buildOurPath walks the uuid parent chain and includes manual rows as names', () => {
  const byId = new Map(OUR_ROWS.map((r) => [r.id, r]));
  const cond = OUR_ROWS.find((r) => r.id === 'uuid-cond')!;
  assert.equal(
    buildOurPath(cond, byId),
    ['побутова техніка', 'кліматична техніка', 'кондиціонери'].join(PATH_SEPARATOR)
  );
  // manual row is a legal path node (Питне скло), even with yugcontract_id = null
  const jug = OUR_ROWS.find((r) => r.id === 'uuid-jug-p')!;
  assert.equal(
    buildOurPath(jug, byId),
    ['побутова техніка', 'питне скло', 'глечики'].join(PATH_SEPARATOR)
  );
});

test('buildOurPath tolerates a parent_id cycle', () => {
  const a: OurCategoryRow = { id: 'a', yugcontract_id: '1', name: 'A', slug: 'a', parent_id: 'b' };
  const b: OurCategoryRow = { id: 'b', yugcontract_id: '2', name: 'B', slug: 'b', parent_id: 'a' };
  const byId = new Map([
    ['a', a],
    ['b', b],
  ]);
  assert.equal(buildOurPath(a, byId), ['b', 'a'].join(PATH_SEPARATOR));
});

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

test('buildRemapMapping matches by full path and never by bare id', () => {
  const res = buildRemapMapping(SUPPLIER_NODES, OUR_ROWS);
  const byOld = new Map(res.mappings.map((m) => [m.old_yc_id, m]));
  assert.equal(byOld.get('1186')?.new_yc_id, '9001');
  assert.equal(byOld.get('180')?.new_yc_id, '9003');
  assert.equal(byOld.get('202')?.new_yc_id, '9006');
  // 1347 ("Глечики" under Кухонне приладдя) must NOT grab 9010/9011 (Питне скло branch)
  assert.equal(byOld.get('1347')?.new_yc_id, '9008');
  // db uuid carried through for apply.sql
  assert.equal(byOld.get('1347')?.db_category_id, 'uuid-jug-k');
});

test('buildRemapMapping: duplicate-name-in-other-branch goes ambiguous, not wrong-branch', () => {
  const res = buildRemapMapping(SUPPLIER_NODES, OUR_ROWS);
  assert.equal(res.mappings.some((m) => m.old_yc_id === '1373'), false);
  const amb = res.ambiguous.find((a) => a.path.includes('глечики') && a.path.includes('питне скло'));
  assert.ok(amb);
  assert.deepEqual(amb.candidate_new_ids, ['9010', '9011']);
  assert.deepEqual(amb.old_yc_ids, ['1373']);
});

test('buildRemapMapping: vanished supplier node -> unmatched with db uuid', () => {
  const res = buildRemapMapping(SUPPLIER_NODES, OUR_ROWS);
  const gone = res.unmatched.find((u) => u.old_yc_id === '5555');
  assert.ok(gone);
  assert.equal(gone.db_category_id, 'uuid-gone');
  assert.equal(gone.path.includes('осушувачі повітря'), true);
});

test('buildRemapMapping: manual rows (yugcontract_id null) are never mapped', () => {
  const res = buildRemapMapping(SUPPLIER_NODES, OUR_ROWS);
  assert.equal(res.mappings.some((m) => m.db_category_id === 'uuid-root-pitne'), false);
  assert.equal(res.unmatched.some((u) => u.db_category_id === 'uuid-root-pitne'), false);
});

test('buildRemapMapping: two our rows on one supplier node -> conflict, both withheld', () => {
  const rows: OurCategoryRow[] = [
    { id: 'u1', yugcontract_id: '100', name: 'Root', slug: 'root-100', parent_id: null },
    { id: 'u2', yugcontract_id: '200', name: 'Root', slug: 'root-200', parent_id: null },
    { id: 'u3', yugcontract_id: '300', name: 'Інша', slug: 'insha-300', parent_id: null },
  ];
  const supplier: YcCategoryNode[] = [
    { externalId: 'n1', parentId: null, name: 'Root', levelHint: 0 },
    { externalId: 'n2', parentId: null, name: 'Інша', levelHint: 0 },
  ];
  const res = buildRemapMapping(supplier, rows);
  // both 100 and 200 want n1 -> neither is mapped
  assert.equal(res.mappings.some((m) => m.old_yc_id === '100'), false);
  assert.equal(res.mappings.some((m) => m.old_yc_id === '200'), false);
  assert.deepEqual(res.conflicts, [{ path: 'root', new_yc_id: 'n1', old_yc_ids: ['100', '200'] }]);
  // untouched row still maps
  assert.equal(res.mappings.length, 1);
  assert.equal(res.mappings[0]?.old_yc_id, '300');
});

// ---------------------------------------------------------------------------
// bijection verification
// ---------------------------------------------------------------------------

test('verifyBijection flags repeated old ids and doubled new ids', () => {
  assert.deepEqual(verifyBijection([
    { old_yc_id: '1', new_yc_id: 'a' },
    { old_yc_id: '2', new_yc_id: 'b' },
  ]), []);
  const errs = verifyBijection([
    { old_yc_id: '1', new_yc_id: 'a' },
    { old_yc_id: '1', new_yc_id: 'b' },
    { old_yc_id: '3', new_yc_id: 'a' },
  ]);
  assert.equal(errs.length, 2);
});

// ---------------------------------------------------------------------------
// forecast (buildCategoryPlan reuse)
// ---------------------------------------------------------------------------

/**
 * Forecast fixtures: internally consistent "remap is complete" world.
 * The mapping tests above keep the ambiguous duplicate pair (9010/9011),
 * but a complete remap over a mapped ROOT expands the whole supplier tree —
 * every supplier node must then have a matching our-row or it is a
 * legitimate create (exactly what buildCategoryPlan would do on Monday).
 * So here "Питне скло" is a yc row (1253 -> 9009) and the Глечики branch
 * has no duplicate path.
 */
const FORECAST_SUPPLIER: YcCategoryNode[] = SUPPLIER_NODES.filter((n) => n.externalId !== '9011');
const FORECAST_OUR_ROWS: OurCategoryRow[] = OUR_ROWS.map((r) =>
  r.id === 'uuid-root-pitne' ? { ...r, yugcontract_id: '1253' } : r
);

test('forecastRemap: zero creates and zero updates when the remap is complete', () => {
  const full = buildRemapMapping(FORECAST_SUPPLIER, FORECAST_OUR_ROWS);
  assert.equal(full.ambiguous.length, 0);
  assert.equal(full.unmatched.length, 1); // only 5555 vanished
  const productsByOld = new Map<string, number>([
    ['1186', 0],
    ['180', 12],
    ['5555', 3],
  ]);
  const fc = forecastRemap(FORECAST_SUPPLIER, FORECAST_OUR_ROWS, full.mappings, productsByOld);
  assert.equal(fc.plan.creates.length, 0, 'mapped subtrees must be recognized as existing');
  assert.equal(fc.plan.updates.length, 0, 'names/parents unchanged -> no updates');
  assert.equal(fc.plan.conflicts.length, 0);
  // unmatched 5555 keeps its products visible in the impact list
  const gone = fc.unmatchedWithProducts.find((u) => u.old_yc_id === '5555');
  assert.ok(gone);
  assert.equal(gone.products, 3);
});

test('forecastRemap: a new supplier subtree inside the selection yields creates', () => {
  // Supplier adds a child under Кліматична техніка that our snapshot lacks.
  const supplier: YcCategoryNode[] = [
    ...FORECAST_SUPPLIER,
    { externalId: '9999', parentId: '9002', name: 'Теплові завіси', levelHint: 2 },
  ];
  const full = buildRemapMapping(FORECAST_SUPPLIER, FORECAST_OUR_ROWS);
  const fc = forecastRemap(supplier, FORECAST_OUR_ROWS, full.mappings, new Map());
  // 9999 is inside the expanded selection (child of mapped 9002) -> create planned
  assert.equal(fc.plan.creates.length, 1);
  assert.equal(fc.plan.creates[0]?.yugcontract_id, '9999');
});

test('forecastRemap: name drift on a mapped category yields an update, not a create', () => {
  const supplier: YcCategoryNode[] = FORECAST_SUPPLIER.map((n) =>
    n.externalId === '9003' ? { ...n, name: 'Кондиціонери та спліт-системи' } : n
  );
  const full = buildRemapMapping(FORECAST_SUPPLIER, FORECAST_OUR_ROWS);
  const fc = forecastRemap(supplier, FORECAST_OUR_ROWS, full.mappings, new Map());
  assert.equal(fc.plan.creates.length, 0);
  const upd = fc.plan.updates.find((u) => u.id === 'uuid-cond');
  assert.ok(upd);
  assert.equal(upd.name, 'Кондиціонери та спліт-системи');
});

// ---------------------------------------------------------------------------
// selection draft
// ---------------------------------------------------------------------------

test('mapSelectionTree rewrites ids in place and reports unresolved', () => {
  const oldToNew = new Map([
    ['1186', '9001'],
    ['740', '9002'],
    ['180', '9003'],
  ]);
  const selection: {
    id: string;
    name: string;
    children: { id: string; name: string; children: { id: string; name: string; children: never[] }[] }[];
  }[] = [
    {
      id: '1186',
      name: 'ПОБУТОВА ТЕХНІКА',
      children: [
        { id: '740', name: 'Кліматична техніка', children: [{ id: '180', name: 'Кондиціонери', children: [] }] },
        { id: '5555', name: 'Осушувачі повітря', children: [] },
      ],
    },
  ];
  const { tree, unresolvedOldIds } = mapSelectionTree(selection, oldToNew);
  assert.equal(tree[0]?.id, '9001');
  assert.equal(tree[0]?.children[0]?.id, '9002');
  assert.equal(tree[0]?.children[0]?.children[0]?.id, '9003');
  // unmapped id kept verbatim and flagged
  assert.equal(tree[0]?.children[1]?.id, '5555');
  assert.deepEqual(unresolvedOldIds, ['5555']);
  assert.equal(tree[0]?.name, 'ПОБУТОВА ТЕХНІКА');
});

test('mapSelectionTree handles the real SELECTED_CATEGORIES shape without throwing', () => {
  const mapAll = new Map<string, string>();
  const collect = (nodes: typeof SELECTED_CATEGORIES): void => {
    for (const n of nodes) {
      mapAll.set(n.id, `new-${n.id}`);
      collect(n.children);
    }
  };
  collect(SELECTED_CATEGORIES);
  const { tree, unresolvedOldIds } = mapSelectionTree(SELECTED_CATEGORIES, mapAll);
  assert.equal(unresolvedOldIds.length, 0);
  assert.equal(tree.length, SELECTED_CATEGORIES.length);
  assert.equal(tree[0]?.id, `new-${SELECTED_CATEGORIES[0]?.id}`);
});

// ---------------------------------------------------------------------------
// apply.sql
// ---------------------------------------------------------------------------

test('buildApplySql emits one guarded UPDATE per mapping inside a transaction', () => {
  const sql = buildApplySql(
    [
      {
        old_yc_id: '740',
        new_yc_id: '9002',
        db_category_id: 'uuid-clim',
        name: 'Кліматична техніка',
        path: 'побутова техніка',
        unchanged: false,
      },
      {
        old_yc_id: '180',
        new_yc_id: '180',
        db_category_id: 'uuid-cond',
        name: 'Кондиціонери',
        path: 'побутова техніка',
        unchanged: true,
      },
    ],
    '2026-09-06T00:00:00.000Z'
  );
  assert.ok(sql.startsWith('--'));
  assert.ok(sql.includes('BEGIN;'));
  assert.ok(sql.includes('COMMIT;'));
  assert.ok(
    sql.includes(
      "UPDATE categories SET yugcontract_id = '9002' WHERE id = 'uuid-clim' AND yugcontract_id = '740';"
    )
  );
  // old-value guard: a second run changes nothing
  assert.ok(sql.includes("AND yugcontract_id = '740'"));
  // unchanged id still emitted (idempotent no-op) with a note
  assert.ok(sql.includes("UPDATE categories SET yugcontract_id = '180' WHERE id = 'uuid-cond' AND yugcontract_id = '180';"));
  assert.ok(sql.includes('(id без змін)'));
  assert.ok(sql.includes('2026-09-06T00:00:00.000Z'));
  const updates = sql.split('\n').filter((l) => l.startsWith('UPDATE ')).length;
  assert.equal(updates, 2);
});
