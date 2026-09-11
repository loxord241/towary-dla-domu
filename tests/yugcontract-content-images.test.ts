/**
 * Unit tests for the images hotlink planner: identity/idempotency,
 * manual-image preservation, reorder reconciliation, security guards.
 * Pure functions — no network, no DB. Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  planImageOps,
  isExternalImportedImage,
  revalidateStagedPictures,
  assertImageUpdateFields,
} = await import('../app/lib/yugcontract/content-images.ts');

const URL1 = 'https://b2b.yugcontract.ua/fileslibrary/products/1/a.jpg';
const URL2 = 'https://b2b.yugcontract.ua/fileslibrary/products/1/b.png';
const URL3 = 'https://b2b.yugcontract.ua/fileslibrary/products/1/c.webp';

function product(dbId: string, ycId: string) {
  return { dbId, yugcontractId: ycId };
}
function img(
  id: string,
  productId: string,
  imageUrl: string,
  opts: { sortOrder?: number; isMain?: boolean } = {}
) {
  return {
    id,
    product_id: productId,
    image_url: imageUrl,
    alt: null,
    sort_order: opts.sortOrder ?? 0,
    is_main: opts.isMain ?? false,
  };
}

test('isExternalImportedImage classifies external vs manual storage rows', () => {
  assert.equal(isExternalImportedImage(URL1), true);
  assert.equal(isExternalImportedImage('products/uuid-1/123-file.jpg'), false);
  assert.equal(isExternalImportedImage('https://evil.io/a.jpg'), false);
});

test('revalidateStagedPictures rejects junk even inside staging JSONB', () => {
  const { urls, rejected } = revalidateStagedPictures([
    URL1,
    'javascript:alert(1)',
    'https://evil.io/x.jpg',
    'https://b2b.yugcontract.ua/docs/f.pdf',
    42,
  ]);
  assert.deepEqual(urls, [URL1]);
  assert.equal(rejected, 4);
});

test('fresh product: staging order → sort_order=index, first is_main, alt=null', () => {
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL1, URL2, URL3]]]),
    []
  );
  assert.equal(plan.inserts.length, 3);
  assert.deepEqual(
    plan.inserts.map((i) => [i.sort_order, i.is_main, i.alt]),
    [
      [0, true, null],
      [1, false, null],
      [2, false, null],
    ]
  );
  assert.equal(plan.updates.length, 0);
});

test('IDEMPOTENCY: same data twice → second run produces zero ops', () => {
  const first = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL1, URL2]]]),
    []
  );
  const persisted = first.inserts.map((i, idx) =>
    img(`db${idx}`, i.product_id, i.image_url, {
      sortOrder: i.sort_order,
      isMain: i.is_main,
    })
  );
  const second = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL1, URL2]]]),
    persisted
  );
  assert.equal(second.inserts.length, 0);
  assert.equal(second.updates.length, 0);
  assert.equal(second.noops, 2);
});

test('ORDER-INSENSITIVE: same URL set in a different feed order → zero write ops, DB order kept', () => {
  const existing = [
    img('d1', 'p1', URL1, { sortOrder: 0, isMain: true }),
    img('d2', 'p1', URL2, { sortOrder: 1 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL2, URL1]]]), // feed shuffled vs DB order
    existing
  );
  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.updates.length, 0); // no sort_order rewrites, main kept by URL
  assert.equal(plan.noops, 2);
});

test('CHURN FIX: same set in two different feed orders → each subsequent plan = 0 write ops', () => {
  const first = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL1, URL2, URL3]]]),
    []
  );
  const persisted = first.inserts.map((i, idx) =>
    img(`db${idx}`, i.product_id, i.image_url, {
      sortOrder: i.sort_order,
      isMain: i.is_main,
    })
  );
  for (const shuffled of [
    [URL3, URL1, URL2],
    [URL2, URL3, URL1],
    [URL3, URL2, URL1],
  ]) {
    const plan = planImageOps([product('p1', '101')], new Map([['101', shuffled]]), persisted);
    assert.equal(plan.inserts.length, 0, `inserts for feed ${shuffled.join()}`);
    assert.equal(plan.updates.length, 0, `updates for feed ${shuffled.join()}`);
    assert.equal(plan.noops, 3);
  }
});

test('DETERMINISM: LCG-shuffled pictures[] fixture — second plan totals zero write-ops', () => {
  const URL4 = 'https://b2b.yugcontract.ua/fileslibrary/products/1/d.jpg';
  const feed = [URL1, URL2, URL3, URL4];
  // Deterministic LCG shuffle (same seed → same permutation) so the test
  // never flakes but genuinely permutes the fixture.
  const shuffled = (seed: number): string[] => {
    const out = [...feed];
    let s = seed;
    for (let i = out.length - 1; i > 0; i -= 1) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const j = s % (i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const first = planImageOps([product('p1', '101')], new Map([['101', feed]]), []);
  const persisted = first.inserts.map((i, idx) =>
    img(`db${idx}`, i.product_id, i.image_url, {
      sortOrder: i.sort_order,
      isMain: i.is_main,
    })
  );
  let secondRunWrites = 0;
  for (const seed of [7, 99, 12345]) {
    const plan = planImageOps(
      [product('p1', '101')],
      new Map([['101', shuffled(seed)]]),
      persisted
    );
    secondRunWrites += plan.inserts.length + plan.updates.length;
  }
  assert.equal(secondRunWrites, 0);
});

test('MAIN URL CHANGE: main left the feed → exactly one demote + one promote, zero sort writes', () => {
  const existing = [
    img('dA', 'p1', URL1, { sortOrder: 0, isMain: true }),
    img('dB', 'p1', URL2, { sortOrder: 1 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL3, URL2]]]), // URL1 (main) gone; URL3 new
    existing
  );
  // new URL appended at the end, non-main (existing dB is next in line)
  assert.deepEqual(
    plan.inserts.map((i) => [i.image_url, i.sort_order, i.is_main]),
    [[URL3, 2, false]]
  );
  assert.equal(plan.updates.length, 2);
  const byId = new Map(plan.updates.map((u) => [u.id, u.fields]));
  assert.deepEqual(byId.get('dA'), { is_main: false }); // demote, no sort_order key
  assert.deepEqual(byId.get('dB'), { is_main: true }); // promote, no sort_order key
  assert.deepEqual(plan.staleImported.map((s) => s.id), ['dA']);
});

test('ADD URL: one INSERT appended at the end; existing order and main untouched', () => {
  const existing = [
    img('d1', 'p1', URL1, { sortOrder: 0, isMain: true }),
    img('d2', 'p1', URL2, { sortOrder: 1 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL2, URL3, URL1]]]), // URL3 added anywhere in the feed
    existing
  );
  assert.deepEqual(
    plan.inserts.map((i) => [i.image_url, i.sort_order, i.is_main]),
    [[URL3, 2, false]]
  );
  assert.equal(plan.updates.length, 0); // d1 stays main, no renumbering
  assert.equal(plan.noops, 2);
});

test('MANUAL PRESERVATION: manual main kept; imports appended after max foreign sort_order, all non-main', () => {
  const existing = [
    img('m1', 'p1', 'products/p1/manual-photo.jpg', { sortOrder: 3, isMain: true }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL1, URL2]]]),
    existing
  );
  assert.equal(plan.inserts.length, 2);
  assert.deepEqual(
    plan.inserts.map((i) => [i.sort_order, i.is_main]),
    [
      [4, false],
      [5, false],
    ]
  );
  assert.equal(plan.updates.length, 0); // manual row untouched
  assert.equal(plan.productsWithManualImages, 1);
  assert.equal(plan.manualMainPreserved, 1);
});

test('MANUAL WITHOUT MAIN: vacant main slot may be taken — manual row still untouched', () => {
  // Admin uploads default to is_main=false, so zero-main products are legal.
  // Setting ONLY the imported first image as main keeps the ≤1-main
  // invariant and never modifies the manual row itself.
  const existing = [img('m1', 'p1', 'products/p1/manual.jpg', { sortOrder: 0 })];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL1]]]),
    existing
  );
  assert.ok(plan.inserts[0] !== undefined);
  assert.equal(plan.inserts[0].is_main, true);
  assert.equal(plan.inserts[0].sort_order, 1);
  assert.equal(plan.updates.length, 0); // manual row untouched
});

test('STALE imported rows are reported but NEVER deleted or updated', () => {
  const existing = [
    img('d-old', 'p1', 'https://b2b.yugcontract.ua/fileslibrary/products/1/old.gif', {
      sortOrder: 2,
    }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL1]]]),
    existing
  );
  assert.deepEqual(plan.staleImported, [
    { id: 'd-old', product_id: 'p1', image_url: 'https://b2b.yugcontract.ua/fileslibrary/products/1/old.gif' },
  ]);
  assert.equal(plan.updates.length, 0);
});

test('ISOLATION: update fields may only be sort_order/is_main', () => {
  for (const forbidden of ['image_url', 'alt', 'product_id', 'id']) {
    assert.throws(() => assertImageUpdateFields({ [forbidden]: 1 }), /заборонене поле/);
  }
  assert.doesNotThrow(() => assertImageUpdateFields({ sort_order: 1, is_main: false }));
});

test('invalid URLs inside staging are dropped by revalidation BEFORE planning (executor flow)', () => {
  const raw = [URL1, 'javascript:x', 'https://evil.io/z.jpg'];
  const { urls } = revalidateStagedPictures(raw); // executor calls this first
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', urls]]),
    []
  );
  assert.equal(plan.inserts.length, 1);
  assert.ok(plan.inserts[0] !== undefined);
  assert.equal(plan.inserts[0].image_url, URL1);
});

test('ZERO-MAIN GUARD: promotion picks next-in-line by EXISTING sort_order, not feed position', () => {
  const existing = [
    img('d1', 'p1', URL1, { sortOrder: 5, isMain: true }),
    img('d2', 'p1', URL2, { sortOrder: 6 }),
    img('d3', 'p1', URL3, { sortOrder: 7 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL3, URL2]]]), // main URL1 gone from the feed
    existing
  );
  const byId = new Map(plan.updates.map((u) => [u.id, u.fields]));
  assert.deepEqual(byId.get('d1'), { is_main: false }); // stale main demoted
  assert.deepEqual(byId.get('d2'), { is_main: true }); // next-in-line (sort 6), NOT feed-first URL3
  assert.ok(!byId.has('d3'));
  assert.deepEqual(plan.staleImported.map((s) => s.id), ['d1']);
  // F12 sequence: demote strictly before promote
  const order = plan.updates.map((u) => u.id);
  assert.ok(order.indexOf('d1') < order.indexOf('d2'));
});

// ---- F12: demote-before-promote ordering vs partial unique (product_id) WHERE is_main ----

/**
 * Simulates the LIVE database constraint during sequential executor
 * application: at most ONE row per product may hold is_main=true.
 * Throws 23505 exactly like PostgreSQL would.
 */
function applyWithPartialUnique(
  rows: ReturnType<typeof img>[],
  updates: { id: string; fields: Record<string, unknown> }[]
): void {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const assertSingleMain = () => {
    const mains = [...store.values()].filter((r) => r.is_main === true).length;
    if (mains > 1) throw Object.assign(new Error('duplicate main'), { code: '23505' });
  };
  for (const u of updates) {
    const row = store.get(u.id);
    if (!row) throw new Error(`missing row ${u.id}`);
    Object.assign(row, u.fields);
    assertSingleMain();
  }
}

/** Global sequence invariant: every demote precedes every promote. */
function assertDemotesBeforePromotes(
  plan: ReturnType<typeof planImageOps>
): void {
  let promoteSeen = false;
  for (const u of plan.updates) {
    if (u.fields.is_main === true) promoteSeen = true;
    if (u.fields.is_main === false && promoteSeen) {
      assert.fail(
        `demote после promote: ${u.id} — partial unique даст 23505`
      );
    }
  }
}

test('F12 SEQUENCE main replacement: old main demoted BEFORE new main promoted', () => {
  // A(main,0) B(1) C(2) → feed drops A: B promoted (next-in-line), A demoted.
  const existing = [
    img('dA', 'p1', URL1, { sortOrder: 0, isMain: true }),
    img('dB', 'p1', URL2, { sortOrder: 1 }),
    img('dC', 'p1', URL3, { sortOrder: 2 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL3, URL2]]]),
    existing
  );
  assert.equal(plan.inserts.length, 0);
  const order = plan.updates.map((u) => u.id);
  assert.ok(
    order.indexOf('dA') < order.indexOf('dB'),
    `ожидается dA(demote) раньше dB(promote), получено: ${order.join(',')}`
  );
  assert.doesNotThrow(() => applyWithPartialUnique(existing, plan.updates));
  assertDemotesBeforePromotes(plan);
});

test('F12 PARTIAL UNIQUE: set-match with shuffled feed emits zero ops (churn regression)', () => {
  const existing = [
    img('d1', 'p1', URL1, { sortOrder: 0, isMain: true }),
    img('d2', 'p1', URL2, { sortOrder: 1 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL2, URL1]]]),
    existing
  );
  // Pre-sticky-fix this exact feed produced [promote d2, demote d1] → 23505
  // risk + wholesale churn; now the set matches and the main URL persists,
  // so nothing is written at all.
  assert.equal(plan.updates.length, 0);
  assert.doesNotThrow(() => applyWithPartialUnique(existing, plan.updates));
});

test('F12 ZERO-MAIN edge: vacant main repaired by a single flag promote, order untouched', () => {
  const existing = [
    img('d1', 'p1', URL1, { sortOrder: 5 }), // admin cleared the flag
    img('d2', 'p1', URL2, { sortOrder: 6 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL2, URL1]]]), // any feed order — sticky ignores it
    existing
  );
  // next-in-line by existing sort_order (d1) is promoted; no sort rewrites
  assert.deepEqual(plan.updates, [
    { id: 'd1', product_id: 'p1', fields: { is_main: true } },
  ]);
  assert.doesNotThrow(() => applyWithPartialUnique(existing, plan.updates));
});

test('F12 MANUAL MAIN: shuffled imported set next to manual main → zero ops at all', () => {
  const existing = [
    img('m1', 'p1', 'products/p1/manual.jpg', { sortOrder: 9, isMain: true }),
    img('d1', 'p1', URL1, { sortOrder: 10 }),
    img('d2', 'p1', URL2, { sortOrder: 11 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL2, URL1]]]),
    existing
  );
  assert.equal(plan.manualMainPreserved, 1);
  assert.ok(
    plan.updates.every((u) => u.fields.is_main !== true),
    'imported image не должен претендовать на main при живом manual main'
  );
  assert.equal(plan.updates.length, 0); // sticky: set matches → nothing to write
  assert.doesNotThrow(() => applyWithPartialUnique(existing, plan.updates));
});

test('F12 SAME-MAIN reorder: main unchanged → zero ops (sort_order is sticky)', () => {
  const existing = [
    img('d1', 'p1', URL1, { sortOrder: 0, isMain: true }),
    img('d2', 'p1', URL2, { sortOrder: 1 }),
    img('d3', 'p1', URL3, { sortOrder: 2 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL1, URL3, URL2]]]), // main stays URL1, rest shuffled
    existing
  );
  assert.equal(plan.inserts.length, 0);
  assert.ok(
    plan.updates.every((u) => !('is_main' in u.fields)),
    'main не менялся — is_main операций быть не должно'
  );
  assert.equal(plan.updates.length, 0); // feed shuffle больше не переписывает порядок
  assert.equal(plan.noops, 3);
});

test('F12 STALE MAIN: full photo replacement demotes stale main before inserting new main', () => {
  const OLD = 'https://b2b.yugcontract.ua/fileslibrary/products/1/old.gif';
  const NEW = 'https://b2b.yugcontract.ua/fileslibrary/products/1/new.jpg';
  const existing = [img('d-old', 'p1', OLD, { sortOrder: 0, isMain: true })];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [NEW]]]),
    existing
  );
  // stale reported AND flag-only demoted (never deleted)
  assert.deepEqual(plan.staleImported.map((s) => s.id), ['d-old']);
  assert.deepEqual(plan.updates, [
    { id: 'd-old', product_id: 'p1', fields: { is_main: false } },
  ]);
  // new URL appended AFTER max(existing sort_order), promoted (no remaining rows)
  assert.deepEqual(plan.inserts, [
    {
      product_id: 'p1',
      image_url: NEW,
      alt: null,
      sort_order: 1,
      is_main: true,
    },
  ]);
  // executor applies UPDATES before INSERTS → demote lands first
  assert.doesNotThrow(() => applyWithPartialUnique(existing, plan.updates));
});

test('F12 IDEMPOTENCY under feed shuffle: applying a plan makes every reshuffled plan a NO-OP', () => {
  const first = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL1, URL2, URL3]]]),
    []
  );
  const store = new Map(
    first.inserts.map((i, idx) => [
      `db${idx}`,
      img(`db${idx}`, i.product_id, i.image_url, {
        sortOrder: i.sort_order,
        isMain: i.is_main,
      }),
    ])
  );
  for (const u of first.updates) Object.assign(store.get(u.id)!, u.fields);
  const persisted = [...store.values()];
  let totalWrites = 0;
  for (const order of [
    [URL2, URL3, URL1],
    [URL3, URL2, URL1],
    [URL1, URL2, URL3],
  ]) {
    const plan = planImageOps([product('p1', '101')], new Map([['101', order]]), persisted);
    totalWrites += plan.inserts.length + plan.updates.length;
    assert.equal(plan.noops, 3);
  }
  assert.equal(totalWrites, 0);
});
