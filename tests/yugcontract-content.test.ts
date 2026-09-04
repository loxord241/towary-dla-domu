/**
 * Unit tests for get-content-goods pure normalization and dry-run stats.
 * Pure functions — no network, no env. Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  extractContentGoods,
  normalizeContentGood,
  dedupeContentGoods,
  matchContentGoodsToProducts,
  buildDescriptionStats,
  buildParamsStats,
  buildImagesStats,
} = await import('../app/lib/yugcontract/content-dry-run.ts');

function makeGood(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '101',
    categoryId: 55,
    name: 'Товар',
    brand: 'Brand',
    EAN: '2000000000017',
    artikul: 'A-1',
    description: '<p>Опис</p>',
    pictures: ['https://b2b.yugcontract.ua/fileslibrary/products/a.jpg'],
    params: [{ name: 'Колір', value: 'синій', id: 9, rozetka_id: 88 }],
    foto: [],
    video: [],
    ...overrides,
  };
}

test('extractContentGoods reads content.goods', () => {
  const { goods } = extractContentGoods({ content: { goods: [{ id: 1 }] } });
  assert.deepEqual(goods, [{ id: 1 }]);
});

test('extractContentGoods tolerates a top-level goods array', () => {
  const { goods } = extractContentGoods({ goods: [{ id: 2 }] });
  assert.deepEqual(goods, [{ id: 2 }]);
});

test('extractContentGoods throws on missing/not-array goods with diagnostics', () => {
  for (const parsed of [null, {}, { content: {} }, { content: { goods: 'nope' } }, { content: [] }]) {
    assert.throws(() => extractContentGoods(parsed), TypeError);
  }
  assert.throws(() => extractContentGoods({ foo: 1 }), /верхньорівневі ключі: foo/);
});

test('normalizeContentGood maps all documented fields through coercion', () => {
  const { good, issues } = normalizeContentGood(makeGood());
  assert.equal(issues.length, 0);
  assert.ok(good);
  assert.equal(good!.externalId, '101');
  assert.equal(good!.categoryId, '55');
  assert.equal(good!.ean, '2000000000017');
  assert.equal(good!.description, '<p>Опис</p>');
  assert.deepEqual(good!.params, [{ name: 'Колір', value: 'синій' }]);
  assert.deepEqual(good!.pictures, ['https://b2b.yugcontract.ua/fileslibrary/products/a.jpg']);
});

test('normalizeContentGood drops rows without id but keeps counting others', () => {
  const missing = normalizeContentGood(makeGood({ id: '' }));
  assert.equal(missing.good, null);
  assert.ok(missing.issues[0] !== undefined);
  assert.match(missing.issues[0].reason, /id/);

  const junk = normalizeContentGood(makeGood({ id: null }));
  assert.equal(junk.good, null);
});

test('normalizeContentGood survives malformed params/pictures/description', () => {
  const { good, issues } = normalizeContentGood(
    makeGood({
      params: 'not-array',
      pictures: 42,
      description: 12345,
    })
  );
  assert.ok(good);
  assert.deepEqual(good!.params, []);
  assert.deepEqual(good!.pictures, []);
  assert.equal(good!.description, null);
  const reasons = issues.map((i) => i.reason).join('; ');
  assert.match(reasons, /params не масив/);
  assert.match(reasons, /pictures не масив/);
  assert.match(reasons, /description не рядок/);
});

test('normalizeContentGood filters junk param entries without dropping the row', () => {
  const { good, issues } = normalizeContentGood(
    makeGood({
      params: [
        { name: 'A', value: '1' },
        { name: '', value: 'x' },
        { value: 'y' },
        'junk',
        null,
        { name: 'B', value: '' },
      ],
    })
  );
  assert.ok(good);
  assert.deepEqual(good!.params, [{ name: 'A', value: '1' }]);
  assert.equal(issues.filter((i) => i.reason === 'param без name/value').length, 3);
  assert.equal(issues.filter((i) => i.reason === 'param не є об’єктом').length, 2);
});

test('dedupeContentGoods keeps first occurrence and reports duplicates', () => {
  const a = normalizeContentGood(makeGood()).good!;
  const b = normalizeContentGood(makeGood({ name: 'Інша назва' })).good!;
  const c = normalizeContentGood(makeGood({ id: '102' })).good!;
  const res = dedupeContentGoods([a, b, c]);
  assert.equal(res.unique.length, 2);
  assert.equal(res.duplicateRowCount, 1);
  assert.deepEqual(res.duplicateIds, [{ externalId: '101', count: 2 }]);
  // first wins
  assert.equal(res.unique.find((g) => g.externalId === '101')!.name, 'Товар');
});

test('matchContentGoodsToProducts splits matched/unmatched/manual/unused', () => {
  const g1 = normalizeContentGood(makeGood({ id: '101' })).good!;
  const g2 = normalizeContentGood(makeGood({ id: '102' })).good!;
  const byId = new Map([
    ['101', g1],
    ['102', g2],
  ]);
  const ours = [
    { id: 'u1', yugcontract_id: '101', sku: 'YC-101', name: 'A', description: null },
    { id: 'u2', yugcontract_id: '999', sku: 'YC-999', name: 'B', description: 'старий' },
    { id: 'u3', yugcontract_id: null, sku: 'MAN-1', name: 'C', description: null },
  ];
  const m = matchContentGoodsToProducts(byId, ours);
  assert.equal(m.matchedLocal.length, 1);
  assert.equal(m.unmatchedLocal.length, 1);
  assert.ok(m.unmatchedLocal[0] !== undefined);
  assert.equal(m.unmatchedLocal[0].sku, 'YC-999');
  assert.equal(m.manualLocal.length, 1);
  assert.deepEqual(m.ycUnusedIds, ['102']);
});

test('buildDescriptionStats counts html/plain and scans danger patterns only', () => {
  const pairs = [
    { externalId: 'a', description: '<p>ok</p>' },
    {
      externalId: 'b',
      description:
        '<script>alert(1)</script><iframe src="javascript:x"></iframe><img src="data:image/png;base64,x" onerror="go()" style="color:red">',
    },
    { externalId: 'c', description: 'простий текст' },
    { externalId: 'd', description: null },
  ];
  const s = buildDescriptionStats(pairs);
  assert.equal(s.total, 4);
  assert.equal(s.withDescription, 3);
  assert.equal(s.emptyDescription, 1);
  assert.equal(s.htmlCount, 2);
  assert.equal(s.plainTextCount, 1);
  const second = pairs[1];
  assert.ok(second !== undefined);
  assert.equal(s.maxDescriptionLength, second.description!.length);
  assert.equal(s.danger.scriptTag, 1);
  assert.equal(s.danger.iframeTag, 1);
  assert.equal(s.danger.eventHandlers, 1);
  assert.equal(s.danger.javascriptUrl, 1);
  assert.equal(s.danger.styleTagOrAttr, 1);
  assert.equal(s.danger.dataUrl, 1);
});

test('buildDescriptionStats empty input is safe', () => {
  const s = buildDescriptionStats([]);
  assert.equal(s.avgDescriptionLength, null);
  assert.equal(s.maxDescriptionLength, null);
});

test('buildParamsStats aggregates names, dup pairs and conflicts', () => {
  const g1 = normalizeContentGood(
    makeGood({
      id: '1',
      params: [
        { name: 'Колір', value: 'синій' },
        { name: 'Колір', value: 'синій' }, // duplicate pair
        { name: 'Колір', value: 'червоний' }, // same name different value
      ],
    })
  ).good!;
  const g2 = normalizeContentGood(makeGood({ id: '2', params: [] })).good!;
  const s = buildParamsStats([g1, g2]);
  assert.equal(s.total, 2);
  assert.equal(s.withParams, 1);
  assert.equal(s.withoutParams, 1);
  assert.equal(s.totalParams, 3);
  assert.equal(s.maxParamsPerProduct, 3);
  assert.equal(s.uniqueParamNames, 1);
  assert.deepEqual(s.topNames, [{ name: 'Колір', count: 3 }]);
  assert.equal(s.goodsWithDuplicatePairs, 1);
  assert.equal(s.goodsWithNameRepeated, 1);
  assert.equal(s.goodsWithConflictingValues, 1);
});

test('buildParamsStats repeated name with SAME value is not a conflict', () => {
  const g = normalizeContentGood(
    makeGood({
      params: [
        { name: 'X', value: '1' },
        { name: 'X', value: '1' },
      ],
    })
  ).good!;
  const s = buildParamsStats([g]);
  assert.equal(s.goodsWithNameRepeated, 1);
  assert.equal(s.goodsWithConflictingValues, 0);
  // identical (name,value) seen twice still counts as a duplicate pair
  assert.equal(s.goodsWithDuplicatePairs, 1);
});

test('buildImagesStats counts hosts, extensions, dup URLs and suspicious entries', () => {
  const g1 = normalizeContentGood(
    makeGood({
      id: '1',
      pictures: [
        'https://b2b.yugcontract.ua/fileslibrary/products/a.jpg',
        'https://b2b.yugcontract.ua/fileslibrary/products/b.webp',
        'https://b2b.yugcontract.ua/fileslibrary/products/a.jpg', // duplicate URL
        'ftp://old.example/x.png', // suspicious protocol
        'not a url at all',
      ],
    })
  ).good!;
  const g2 = normalizeContentGood(makeGood({ id: '2', pictures: [] })).good!;
  const s = buildImagesStats([g1, g2]);
  assert.equal(s.total, 2);
  assert.equal(s.productsWithPictures, 1);
  assert.equal(s.productsWithoutPictures, 1);
  assert.equal(s.totalPictureUrls, 5);
  assert.equal(s.uniquePictureUrls, 4); // ftp + junk are counted as rows but not hosts
  assert.equal(s.duplicateUrlRows, 1);
  assert.ok(s.duplicateExamples[0] !== undefined);
  assert.deepEqual(s.duplicateExamples[0].count, 2);
  assert.deepEqual(s.hosts.map((h) => h.host), ['b2b.yugcontract.ua']);
  assert.ok(s.extensions.some((e) => e.ext === '.jpg' && e.count === 2));
  assert.ok(s.extensions.some((e) => e.ext === '.webp' && e.count === 1));
  assert.equal(s.suspiciousUrls.length, 2);
  assert.equal(s.maxPicturesPerProduct, 5);
});
