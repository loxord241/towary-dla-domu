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

test('REORDER: staging order change updates sort_order and switches is_main within imported set', () => {
  const existing = [
    img('d1', 'p1', URL1, { sortOrder: 0, isMain: true }),
    img('d2', 'p1', URL2, { sortOrder: 1, isMain: false }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL2, URL1]]]),
    existing
  );
  assert.equal(plan.inserts.length, 0);
  const byId = new Map(plan.updates.map((u) => [u.id, u]));
  assert.deepEqual(byId.get('d1')!.fields, { sort_order: 1, is_main: false });
  assert.deepEqual(byId.get('d2')!.fields, { sort_order: 0, is_main: true });
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
  assert.equal(plan.inserts[0].image_url, URL1);
});

test('REORDER within pure-imported set cannot end up with zero mains', () => {
  const existing = [
    img('d1', 'p1', URL1, { sortOrder: 0, isMain: true }),
    img('d2', 'p1', URL2, { sortOrder: 1 }),
    img('d3', 'p1', URL3, { sortOrder: 2 }),
  ];
  const plan = planImageOps(
    [product('p1', '101')],
    new Map([['101', [URL3, URL1]]]), // d2 disappeared; d3 now first
    existing
  );
  const byId = new Map(plan.updates.map((u) => [u.id, u.fields]));
  // d3 becomes main+first, d1 demoted; d2 reported stale, NOT deleted
  assert.deepEqual(byId.get('d3'), { sort_order: 0, is_main: true });
  assert.deepEqual(byId.get('d1'), { sort_order: 1, is_main: false });
  assert.deepEqual(
    plan.staleImported.map((s) => s.id),
    ['d2']
  );
});
