/**
 * Unit tests for the stage-2B import planning (pure modules only —
 * no network, no DB, no env). Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  slugifyText,
  slugWithId,
} = await import('../app/lib/yugcontract/translit.ts');
const {
  collectExpandedIds,
} = await import('../app/lib/yugcontract/selection.ts');
const {
  buildCategoryPlan,
  buildBrandPlan,
  mapFeedProducts,
  splitProductWrites,
  isBrandExcluded,
  EXCLUDED_BRAND_KEYS,
} = await import('../app/lib/yugcontract/import-plan.ts');

// ---------------- translit ----------------

test('slugifyText: uk→latin, apostrophes dropped, junk collapsed', () => {
  assert.equal(slugifyText("М'ясорубки"), 'miasorubky');
  assert.equal(slugifyText('СВЧ печі 20Л'), 'svch-pechi-20l');
  assert.equal(slugifyText('Тарілки, салатники / блюда'), 'tarilky-salatnyky-bliuda');
  assert.equal(slugifyText('---'), '');
});

test('slugWithId appends the external id → globally unique', () => {
  const a = slugWithId('Холодильник ATLANT ХМ', '490123');
  const b = slugWithId('Холодильник ATLANT ХМ', '490124');
  assert.notEqual(a, b);
  assert.ok(a.endsWith('-490123'));
});

// ---------------- selection expansion ----------------

test('collectExpandedIds expands subtrees and reports unknown ids', () => {
  const nodes = [
    { externalId: '1', parentId: null },
    { externalId: '2', parentId: '1' },
    { externalId: '3', parentId: '2' },
    { externalId: '9', parentId: null },
  ];
  const { expanded, unknownSelected } = collectExpandedIds(nodes, ['1', '999']);
  assert.deepEqual([...expanded].sort(), ['1', '2', '3']);
  assert.deepEqual(unknownSelected, ['999']);
});

// ---------------- categories plan ----------------

function node(id: string, parent: string | null, name = `Категорія ${id}`) {
  return { externalId: id, parentId: parent, name, levelHint: null };
}

test('buildCategoryPlan: creates are depth-sorted parents-first; updates minimal', () => {
  const nodes = [node('1', null), node('2', '1'), node('3', '2')];
  const plan = buildCategoryPlan(nodes, new Set(['1', '2', '3']), []);
  assert.equal(plan.creates.length, 3);
  assert.ok(plan.creates[0] !== undefined && plan.creates[1] !== undefined);
  assert.deepEqual(
    plan.creates.map((c) => c.yugcontract_id),
    ['1', '2', '3']
  );
  assert.equal(plan.creates[0].parentYcId, null);
  assert.equal(plan.creates[1].parentYcId, '1');

  // existing row with an old name + stale parent → one update
  const existing = [
    {
      id: 'uuid-1',
      parent_id: null,
      name: 'Стара назва',
      slug: 'stara-nazva-1',
      yugcontract_id: '1',
    },
  ];
  const plan2 = buildCategoryPlan(nodes, new Set(['1', '2', '3']), existing);
  assert.equal(plan2.updates.length, 1);
  assert.ok(plan2.updates[0] !== undefined);
  assert.equal(plan2.updates[0].id, 'uuid-1');
  assert.equal(plan2.updates[0].name, 'Категорія 1');
  // children of existing id=1 still created with correct parent link
  assert.equal(plan2.creates.length, 2);
});

test('buildCategoryPlan: parent outside selection becomes root', () => {
  const nodes = [node('50', null), node('884', '50')];
  const plan = buildCategoryPlan(nodes, new Set(['884']), []);
  assert.equal(plan.creates.length, 1);
  assert.ok(plan.creates[0] !== undefined);
  assert.equal(plan.creates[0].parentYcId, null);
});

// ---------------- brands plan ----------------

test('buildBrandPlan links case/trim-insensitively and creates only missing', () => {
  const ours = [
    { id: 'b1', name: 'Samsung', slug: 'samsung' },
    { id: 'b2', name: '  LUMINARC ', slug: 'luminarc' },
  ];
  const plan = buildBrandPlan(['SAMSUNG', 'luminarc ', 'Remington'], ours);
  assert.equal(plan.links.get('samsung'), 'b1');
  assert.equal(plan.links.get('luminarc'), 'b2');
  assert.deepEqual(plan.creates, [{ name: 'Remington', slug: 'remington' }]);
});

test('buildBrandPlan keeps bare-key lookalikes separate but reports them', () => {
  const plan = buildBrandPlan(['Electro Lux'], [
    { id: 'b1', name: 'Electrolux', slug: 'electrolux' },
  ]);
  assert.equal(plan.links.size, 0);
  assert.equal(plan.creates.length, 1);
  assert.deepEqual(plan.nearMatches, [{ ycBrand: 'Electro Lux', ourBrand: 'Electrolux' }]);
});

// ---------------- products mapping & split ----------------

function ycProduct(overrides: Record<string, unknown> = {}) {
  return {
    externalId: '100',
    nameUkr: 'Товар Тест',
    brand: 'BRAND A',
    catTop: null,
    cat2l: null,
    cat: null,
    catTopId: '1186',
    catId: '498',
    price: 999.444,
    rrp: 1200,
    statusMain: null,
    qtyMain: 5,
    ...overrides,
  };
}

test('mapFeedProducts: EXCLUDED_BRAND_KEYS drops owner-banned brands with a skip reason', () => {
  // Власник 2026-09-12/13: VIOLET HOUSE знятий з вітрини повністю — sync не
  // має ні створювати, ні оновлювати його позиції (вони живуть у живих
  // категоріях, тому category-gate їх не зупиняє).
  assert.deepEqual([...EXCLUDED_BRAND_KEYS], ['violet house']);
  assert.equal(isBrandExcluded('VIOLET HOUSE'), true);
  assert.equal(isBrandExcluded('  violet   house '), true, 'та сама нормалізація, що і звязка бренду');
  assert.equal(isBrandExcluded('Bosch'), false);

  const { rows, skipped } = mapFeedProducts([
    ycProduct({ externalId: '200', brand: 'VIOLET HOUSE' }),
    ycProduct({ externalId: '201', brand: 'violet house' }),
    ycProduct({ externalId: '202', brand: 'Bosch' }),
  ] as never[]);
  assert.deepEqual(rows.map((r: { yugcontract_id: string }) => r.yugcontract_id), ['202']);
  const vh = skipped.find((s: { id: string }) => s.id === '200');
  assert.ok(vh !== undefined, 'excluded row must be reported as skipped');
  assert.match(vh.reason, /бренд виключений/);
});

test('mapFeedProducts applies rrp-as-price/stock rules and skips broken rows', () => {
  const rows = [
    ycProduct(),
    ycProduct({ externalId: '101', rrp: 500 }), // rrp valid → price=500 (rrp is THE price)
    ycProduct({ externalId: '102', qtyMain: -3 }), // clamped to 0
    ycProduct({ externalId: '103', brand: null }),
    ycProduct({ externalId: '106', rrp: null }), // no RRP → price null, row kept
  ];
  const bad = [
    ycProduct({ externalId: '', }),
    ycProduct({ externalId: '104', price: null, rrp: null }),
    ycProduct({ externalId: '105', catId: null }),
  ];
  const { rows: mapped, skipped } = mapFeedProducts([...rows, ...bad] as never[]);
  assert.equal(mapped.length, 5);
  assert.equal(skipped.length, 3);

  const first = mapped[0];
  assert.ok(first !== undefined);
  assert.equal(first.price, 1200); // price = rrp
  assert.equal(first.old_price, null); // no proven discounts — always null
  assert.equal(first.availability_status, 'in_stock');
  assert.equal(first.sku, 'YC-100');
  const rrpWins = mapped[1];
  assert.ok(rrpWins !== undefined);
  assert.equal(rrpWins.price, 500);
  assert.equal(rrpWins.old_price, null);
  const zeroStock = mapped[2];
  assert.ok(zeroStock !== undefined);
  assert.equal(zeroStock.stock_quantity, 0);
  assert.equal(zeroStock.availability_status, 'out_of_stock');
  assert.ok(mapped[3] !== undefined);
  assert.equal(mapped[3].brandKey, null);
  const noRrp = mapped[4];
  assert.ok(noRrp !== undefined);
  assert.equal(noRrp.price, null);
  assert.equal(noRrp.old_price, null);
});

test('splitProductWrites without RRP: inserts blocked, existing price untouched', () => {
  const { rows } = mapFeedProducts([
    ycProduct({ externalId: '400', rrp: null }), // new product without RRP
    ycProduct({ externalId: '401', rrp: null }), // existing product without RRP
    ycProduct({ externalId: '402' }), // existing with RRP → normal update
  ] as never[]);
  const existing = [
    {
      id: 'uuid-e1',
      yugcontract_id: '401',
      sku: 'YC-401',
      name: 'Товар Тест',
      slug: 'tovar-test-401',
      price: 333,
      old_price: 399,
      stock_quantity: 5,
      availability_status: 'in_stock',
      category_id: 'c',
    },
    {
      id: 'uuid-e2',
      yugcontract_id: '402',
      sku: 'YC-402',
      name: 'Товар Тест',
      slug: 'tovar-test-402',
      price: 999.44,
      old_price: null,
      stock_quantity: 5,
      availability_status: 'in_stock',
      category_id: 'c',
    },
  ];
  const split = splitProductWrites(rows as never[], existing, () => ({
    brand_id: 'b',
    category_id: 'c',
  }));
  // 400: cannot create a product without a price
  assert.equal(split.inserts.length, 0);
  assert.deepEqual(
    split.unresolvedRefs.find((r) => r.id === '400')?.reason ?? '',
    'немає коректної RRP у фіді (новий товар не створено)'
  );
  // 401: update exists but must NOT touch price; old_price cleared
  const upd401 = split.updates.find((u) => u.id === 'uuid-e1');
  assert.ok(upd401);
  assert.equal(upd401.fields.price, undefined); // keep existing correct price
  assert.equal(upd401.fields.old_price, null); // discount display removed
  // 402: price follows new RRP mapping (1200), old_price already null → untouched
  const upd402 = split.updates.find((u) => u.id === 'uuid-e2');
  assert.ok(upd402);
  assert.equal(upd402.fields.price, 1200);
  assert.equal(upd402.fields.old_price, undefined);
});

const EXISTING_ROW = {
  id: 'uuid-p1',
  yugcontract_id: '100',
  sku: 'YC-100',
  name: 'Стара назва',
  slug: 'stara-nazva-100',
  price: 900,
  old_price: null,
  stock_quantity: 4,
  availability_status: 'in_stock',
  // same as what resolveRefs below returns → no recategorization in this diff
  category_id: 'cat-uuid',
};

test('splitProductWrites: diff-only updates, stable slug, history flag', () => {
  const { rows } = mapFeedProducts([ycProduct()] as never[]);
  const split = splitProductWrites(rows as never[], [EXISTING_ROW], () => ({
    brand_id: 'brand-uuid',
    category_id: 'cat-uuid',
  }));
  assert.equal(split.inserts.length, 0);
  assert.equal(split.updates.length, 1);
  const upd = split.updates[0];
  assert.ok(upd !== undefined);
  assert.equal(upd.id, 'uuid-p1');
  assert.deepEqual(Object.keys(upd.fields).sort(), [
    'name',
    'price',
    'stock_quantity',
  ]);
  assert.equal(upd.fields.price, 1200); // rrp becomes the storefront price
  assert.equal(upd.fields.slug, undefined); // slug frozen
  assert.equal(upd.fields.is_active, undefined); // never auto-deactivate
  assert.equal(upd.stockChanged, true);
  assert.equal(upd.oldStock, 4);
  assert.equal(upd.newStock, 5);
});

test('splitProductWrites blocks on manual sku squatters, resolves refs', () => {
  const { rows } = mapFeedProducts([
    ycProduct({ externalId: '200' }),
    ycProduct({ externalId: '300' }),
  ] as never[]);
  const manualSquat = {
    id: 'uuid-manual',
    yugcontract_id: null,
    sku: 'YC-200',
    name: 'Ручний товар',
    slug: 'ruchnyi-tovar',
    price: 10,
    old_price: null,
    stock_quantity: 1,
    availability_status: 'in_stock',
    category_id: null,
  };
  const split = splitProductWrites(rows as never[], [manualSquat], (row) =>
    row.yugcontract_id === '300'
      ? { brand_id: null, category_id: null } // категорія не знайдена
      : { brand_id: 'b', category_id: 'c' }
  );
  assert.equal(split.inserts.length, 0); // 200 blocked, 300 unresolved
  assert.equal(split.hardConflicts.length, 1);
  assert.equal(split.unresolvedRefs.length, 1);
  assert.ok(split.unresolvedRefs[0] !== undefined);
  assert.equal(split.unresolvedRefs[0].id, '300');
});
