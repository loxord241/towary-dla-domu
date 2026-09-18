/**
 * Лінолеум: pure-планировщик консолідованої моделі
 * app/lib/linoleum/import-plan.ts (рішення власника C2, 2026-09-18:
 * ОДНА карточка = ДИЗАЙН, ширини — product_variants; було: картка =
 * дизайн×ширина, план L3 2026-09-17 — тести переписані під нову модель,
 * бо змінився сам інваріант рішенням власника).
 *
 * Повністю чисті тести: ніяких БД/Next/секретів — тільки pure-модуль
 * + тип LinoleumRow з app/lib/linoleum/parse.ts + константа кореневого slug'а
 * з app/lib/catalog/shared.ts (cross-pin: імпортер і вітрина про один slug).
 *
 * Контракт (C2):
 *  - група = дизайн по name з CSV (designKey: trim+lowercase+без пробілів);
 *  - product sku = `ln-x<нормкод>` БЕЗ width-токена; код — від САМОЇ ВУЗЬКОЇ
 *    ширини групи; normalizeCode: charset [a-z0-9-] проходить як є,
 *    кирилиця → digits-only фолбэк; колізія → суфікс -2;
 *  - variant sku = `{productSku}-w<ширина×10>` (UNIQUE у product_variants);
 *  - products.name = ім'я дизайну БЕЗ ширини; price = MIN грн/пог.м;
 *    stock_quantity = СУМА метражів варіантів (обмеження v1: після продажів
 *    розсинхрон з варіантами — реальні залишки в product_variants);
 *  - specifications: «Ціна за м²» (MIN price_sqm) + ПО ОДНІЙ «Ширина» на
 *    кожну ширину (jsonb contains фільтра хаба матчить елемент масиву);
 *  - варіант: name = formatWidthM, price = грн/пог.м, stock = qty_m,
 *    availability по qty, is_active true;
 *  - updates diff-aware: product (price/specifications/stock_quantity),
 *    варіант (price/stock_quantity); список ширин у specs — ДАНІ карточки;
 *    L12: тех-записи сайту в існуючих specs («Виробник», «Клас…») не
 *    здаються — імпортер оновлює лише канон 1С;
 *  - missing ширина → варіант 0; missing дизайн → product 0 + варіанти 0;
 *    DELETE ніколи; conflicts завжди [].
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINOLEUM_ROOT_CATEGORY,
  PRICE_SQM_SPEC_NAME,
  WIDTH_SPEC_NAME,
  buildConsolidatedSpecifications,
  designKey,
  findSpecValue,
  formatPriceSqmValue,
  formatWidthM,
  linoleumSku,
  linoleumVariantSku,
  planLinoleumImport,
  planRootCategory,
  preservedTechSpecCount,
  runningMeterPrice,
  specificationListsEqual,
  type ExistingProduct,
  type ExistingVariant,
  type LinoleumPlan,
} from '../app/lib/linoleum/import-plan.ts';
import type { LinoleumRow } from '../app/lib/linoleum/parse.ts';

// catalog/shared.ts creates its anon Supabase client at module load; provide
// the publishable-env placeholders BEFORE the dynamic import (no network).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';

function lrow(over: Partial<LinoleumRow> & { code: string; name?: string }): LinoleumRow {
  return {
    name: over.name ?? `Дизайн ${over.code}`,
    widthM: 2,
    priceSqm: 350,
    qtyM: 3,
    ...over,
  };
}

function prod(
  over: Partial<ExistingProduct> & { id: string; sku: string }
): ExistingProduct {
  return {
    name: over.sku,
    price: 700,
    stockQuantity: 5,
    isActive: false,
    specifications: [
      { name: PRICE_SQM_SPEC_NAME, value: '350,00' },
      { name: WIDTH_SPEC_NAME, value: '2' },
    ],
    ...over,
  };
}

function variant(
  over: Partial<ExistingVariant> & { id: string; sku: string; productId: string }
): ExistingVariant {
  return {
    name: '2',
    price: 700,
    stockQuantity: 5,
    ...over,
  };
}

function emptyVariants(): Map<string, ExistingVariant> {
  return new Map();
}

function emptyMap(
  entries: Array<[string, ExistingProduct]> = []
): Map<string, ExistingProduct> {
  return new Map(entries);
}

/** Имитирует исполнение плана: создаёт продукты+варианты, применяет
 *  обновления, сводит missing (products и variants) в qty=0. */
function simulateApply(
  existing: Map<string, ExistingProduct>,
  rows: LinoleumRow[],
  existingVariants: Map<string, ExistingVariant>
): { products: Map<string, ExistingProduct>; variants: Map<string, ExistingVariant> } {
  const plan: LinoleumPlan = planLinoleumImport(existing, rows, existingVariants);
  const products = new Map(existing);
  const variants = new Map(existingVariants);
  let i = 0;
  for (const c of plan.creates) {
    i += 1;
    const productId = `new-${i}`;
    products.set(c.sku, {
      id: productId,
      sku: c.sku,
      name: c.name,
      price: c.price,
      stockQuantity: c.stockQuantity,
      isActive: c.isActive,
      specifications: c.specifications,
    });
    for (const v of c.variants) {
      variants.set(v.sku, {
        id: `newv-${productId}-${v.sku}`,
        sku: v.sku,
        productId,
        name: v.name,
        price: v.price,
        stockQuantity: v.stockQuantity,
      });
    }
  }
  const byId = new Map([...products].map(([sku, p]) => [p.id, sku] as const));
  for (const u of plan.updates) {
    const sku = byId.get(u.id);
    if (sku === undefined) throw new Error(`update для неизвестного id ${u.id}`);
    const p = products.get(sku);
    if (p === undefined) throw new Error(`нет товара ${sku}`);
    products.set(sku, {
      ...p,
      price: u.fields.price ?? p.price,
      stockQuantity: u.fields.stock_quantity ?? p.stockQuantity,
      specifications: u.fields.specifications ?? p.specifications,
    });
  }
  const variantById = new Map([...variants].map(([sku, v]) => [v.id, sku] as const));
  for (const vu of plan.variantCreates) {
    const v = vu.variant;
    variants.set(v.sku, {
      id: `newv-${vu.productId}-${v.sku}`,
      sku: v.sku,
      productId: vu.productId,
      name: v.name,
      price: v.price,
      stockQuantity: v.stockQuantity,
    });
  }
  for (const vu of plan.variantUpdates) {
    const sku = variantById.get(vu.id);
    const v = sku === undefined ? undefined : variants.get(sku);
    if (v === undefined) throw new Error(`variant update для неизвестного id ${vu.id}`);
    variants.set(v.sku, {
      ...v,
      price: vu.fields.price ?? v.price,
      stockQuantity: vu.fields.stock_quantity ?? v.stockQuantity,
    });
  }
  const missingIds = new Set(plan.missingProducts.map((m) => m.id));
  for (const [sku, p] of products) {
    if (missingIds.has(p.id)) products.set(sku, { ...p, stockQuantity: 0 });
  }
  const missingVariantIds = new Set(plan.missingVariants.map((m) => m.id));
  for (const [sku, v] of variants) {
    if (missingVariantIds.has(v.id)) variants.set(sku, { ...v, stockQuantity: 0 });
  }
  return { products, variants };
}

// ---------------------------------------------------------------------------
// форматтеры: ширина, цена за м², погонный метр (без изменений в C2)
// ---------------------------------------------------------------------------

test('FORMAT: formatWidthM — українська кома, цілі без дробу (канон для спецификацій і фільтра ширин хаба)', () => {
  assert.equal(formatWidthM(1.5), '1,5');
  assert.equal(formatWidthM(2), '2');
  assert.equal(formatWidthM(2.5), '2,5');
  assert.equal(formatWidthM(3), '3');
  assert.equal(formatWidthM(3.5), '3,5');
  assert.equal(formatWidthM(4), '4');
});

test('FORMAT: formatPriceSqmValue — рівно 2 знаки, кома (канон NUMERIC(12,2))', () => {
  assert.equal(formatPriceSqmValue(350), '350,00');
  assert.equal(formatPriceSqmValue(350.5), '350,50');
  assert.equal(formatPriceSqmValue(410), '410,00');
  assert.equal(formatPriceSqmValue(99.95), '99,95');
});

test('FORMAT: runningMeterPrice — грн/пог.м = price_sqm × width, HALF-UP до копійки (як Postgres NUMERIC)', () => {
  assert.equal(runningMeterPrice(350, 2), 700);
  assert.equal(runningMeterPrice(350.5, 2.5), 876.25);
  assert.equal(runningMeterPrice(99.95, 1.5), 149.93);
  // 10.15 × 1.5 = 15.225 → HALF-UP → 15.23 (наивный Math.round(float) дал бы 15.22)
  assert.equal(runningMeterPrice(10.15, 1.5), 15.23);
  assert.equal(runningMeterPrice(123.45, 2.5), 308.63); // 308.625 → 308.63
  assert.equal(runningMeterPrice(200, 4), 800);
});

// ---------------------------------------------------------------------------
// sku: продукт без width-токена, вариант = {productSku}-w{token}
// ---------------------------------------------------------------------------

test('SKU: linoleumSku(code) — продукт-дизайн БЕЗ width-токена, нормализация кода', () => {
  assert.equal(linoleumSku('1234'), 'ln-x1234');
  assert.equal(linoleumSku('  A 100 '), 'ln-xa100');
  assert.equal(linoleumSku('ЛІН-01160049'), 'ln-x01160049', 'кириллица → digits-only');
  assert.equal(linoleumSku('лІН 01160049'), 'ln-x01160049', 'регистр/пробелы не меняют ядро');
  assert.match(linoleumSku('ЛІН-01160049'), /^[a-z0-9-]+$/);
});

test('SKU: linoleumVariantSku — {productSku}-w{ширина×10}, 1:1 на (продукт, ширина)', () => {
  assert.equal(linoleumVariantSku('ln-x1234', 1.5), 'ln-x1234-w15');
  assert.equal(linoleumVariantSku('ln-x1234', 2), 'ln-x1234-w20');
  assert.equal(linoleumVariantSku('ln-x1234', 2.5), 'ln-x1234-w25');
  assert.equal(linoleumVariantSku('ln-x1234', 3), 'ln-x1234-w30');
  assert.equal(linoleumVariantSku('ln-x1234', 3.5), 'ln-x1234-w35');
  assert.equal(linoleumVariantSku('ln-x1234', 4), 'ln-x1234-w40');
  const widths = [1.5, 2, 2.5, 3, 3.5, 4] as const;
  const tokens = widths.map((w) => linoleumVariantSku('ln-xl-1', w));
  assert.equal(new Set(tokens).size, 6, 'разные ширины — разные variant sku');
  for (const sku of tokens) assert.match(sku, /^[a-z0-9-]+$/);
});

test('SKU: designKey — групування за іменем дизайну: case-insensitive, пробіли вирізані', () => {
  assert.equal(designKey('SUGAR OAK 997L Лінолеум BEAUFLOUR SMARTEX'), 'sugaroak997lлінолеумbeaufloursmartex');
  assert.equal(designKey('  Helsinki  582 '), designKey('helsinki 582'));
});

// ---------------------------------------------------------------------------
// спецификации: helpers
// ---------------------------------------------------------------------------

test('SPECS: findSpecValue — находка, отсутствие → undefined', () => {
  const stored = [{ name: PRICE_SQM_SPEC_NAME, value: '300,00' }];
  assert.equal(findSpecValue(stored, PRICE_SQM_SPEC_NAME), '300,00');
  assert.equal(findSpecValue(stored, WIDTH_SPEC_NAME), undefined);
});

test('SPECS: buildConsolidatedSpecifications (L12) — канон 1С ПЕРШИЙ блоком («Ціна за м²» + ширини в канонічному порядку), тех-записи сайту — після, як є', () => {
  const stored = [
    { name: 'Клас зносостійкості', value: '23' },
    { name: PRICE_SQM_SPEC_NAME, value: '300,00' },
    { name: 'Виробник', value: 'Beauflor' },
    { name: WIDTH_SPEC_NAME, value: '4' },
  ];
  assert.deepEqual(buildConsolidatedSpecifications(stored, '410,00', [2.5, 1.5, 2]), [
    { name: PRICE_SQM_SPEC_NAME, value: '410,00' },
    { name: WIDTH_SPEC_NAME, value: '1,5' },
    { name: WIDTH_SPEC_NAME, value: '2' },
    { name: WIDTH_SPEC_NAME, value: '2,5' },
    { name: 'Клас зносостійкості', value: '23' },
    { name: 'Виробник', value: 'Beauflor' },
  ]);
});

test('SPECS: buildConsolidatedSpecifications — збережений «Ширина»-запис не виживає (канон перемагає), idempotentний перевипуск без дублів', () => {
  const stored = [
    { name: PRICE_SQM_SPEC_NAME, value: '410,00' },
    { name: WIDTH_SPEC_NAME, value: '1,5' },
    { name: WIDTH_SPEC_NAME, value: '2' },
    { name: 'Товщина', value: '2,5 мм' },
    { name: WIDTH_SPEC_NAME, value: '2,5 м' }, // «extra» з канонічним іменем
  ];
  const once = buildConsolidatedSpecifications(stored, '410,00', [1.5, 2]);
  assert.deepEqual(once, [
    { name: PRICE_SQM_SPEC_NAME, value: '410,00' },
    { name: WIDTH_SPEC_NAME, value: '1,5' },
    { name: WIDTH_SPEC_NAME, value: '2' },
    { name: 'Товщина', value: '2,5 мм' },
  ]);
  // Ідемпотентність: повторний виклик поверх власного виходу — без змін.
  assert.deepEqual(buildConsolidatedSpecifications(once, '410,00', [1.5, 2]), once);
});

test('SPECS: specificationListsEqual — строгая глубокая равность', () => {
  assert.equal(specificationListsEqual([{ name: 'A', value: '1' }], [{ name: 'A', value: '1' }]), true);
  assert.equal(specificationListsEqual([{ name: 'A', value: '1' }], [{ name: 'A', value: '2' }]), false);
  assert.equal(specificationListsEqual([], []), true);
});

// ---------------------------------------------------------------------------
// корневая категория
// ---------------------------------------------------------------------------

test('ROOT CATEGORY: slug совпадает с витринной константой LINOLEUM_ROOT_SLUG (cross-pin)', async () => {
  const { LINOLEUM_ROOT_SLUG } = await import('../app/lib/catalog/shared.ts');
  assert.equal(LINOLEUM_ROOT_CATEGORY.slug, LINOLEUM_ROOT_SLUG);
  assert.equal(LINOLEUM_ROOT_CATEGORY.slug, 'linoleum');
  assert.equal(LINOLEUM_ROOT_CATEGORY.name, 'Лінолеум');
});

test('ROOT CATEGORY: create / reuse / conflict', () => {
  assert.deepEqual(planRootCategory([]), { create: true, existingId: null, conflict: false });
  assert.deepEqual(planRootCategory([{ id: 'c1', slug: 'linoleum', name: 'Лінолеум' }]), {
    create: false,
    existingId: 'c1',
    conflict: false,
  });
  assert.deepEqual(planRootCategory([{ id: 'c1', slug: 'linoleum', name: 'Інша' }]), {
    create: false,
    existingId: null,
    conflict: true,
  });
});

// ---------------------------------------------------------------------------
// PLAN: creates — один дизайн = одна карточка с вариантами
// ---------------------------------------------------------------------------

test('PLAN: один дизайн, несколько ширин → ОДНА карточка: name без ширини, MIN price, SUM qty, ширини в specs, варіанти по ширині', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'L-100', name: 'SUGAR OAK 997L Лінолеум SMARTEX', widthM: 2.5, priceSqm: 350.5, qtyM: 40 }),
      lrow({ code: 'L-100', name: 'SUGAR OAK 997L Лінолеум SMARTEX', widthM: 1.5, priceSqm: 350.5, qtyM: 12 }),
      lrow({ code: 'L-100', name: 'SUGAR OAK 997L Лінолеум SMARTEX', widthM: 3, priceSqm: 350.5, qtyM: 0 }),
    ],
    emptyVariants()
  );

  assert.equal(plan.creates.length, 1, 'один дизайн → одна карточка');
  assert.deepEqual(plan.creates[0], {
    sku: 'ln-xl-100',
    slug: 'ln-xl-100',
    name: 'SUGAR OAK 997L Лінолеум SMARTEX',
    price: 525.75, // MIN: 350.5 × 1.5
    stockQuantity: 52, // 40 + 12 + 0
    availability: 'in_stock',
    isActive: false,
    specifications: [
      { name: 'Ціна за м²', value: '350,50' },
      { name: 'Ширина', value: '1,5' },
      { name: 'Ширина', value: '2,5' },
      { name: 'Ширина', value: '3' },
    ],
    variants: [
      {
        sku: 'ln-xl-100-w15',
        name: '1,5',
        price: 525.75,
        stockQuantity: 12,
        availability: 'in_stock',
        isActive: true,
      },
      {
        sku: 'ln-xl-100-w25',
        name: '2,5',
        price: 876.25,
        stockQuantity: 40,
        availability: 'in_stock',
        isActive: true,
      },
      {
        sku: 'ln-xl-100-w30',
        name: '3',
        price: 1051.5,
        stockQuantity: 0,
        availability: 'out_of_stock',
        isActive: true,
      },
    ],
  });
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.missingProducts, []);
  assert.deepEqual(plan.missingVariants, []);
  assert.deepEqual(plan.noops, []);
  assert.deepEqual(plan.conflicts, []);
});

test('PLAN: весь дизайн в 0 → availability out_of_stock, нулевые варіанти out_of_stock', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [lrow({ code: 'L-1', name: 'D', widthM: 2, priceSqm: 300, qtyM: 0 })],
    emptyVariants()
  );
  assert.equal(plan.creates[0]?.availability, 'out_of_stock');
  assert.equal(plan.creates[0]?.variants[0]?.availability, 'out_of_stock');
});

test('PLAN: різні ціни за м² по ширинах → product price = MIN пог.м, «Ціна за м²» = MIN price_sqm', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'L-2', name: 'D2', widthM: 2, priceSqm: 300, qtyM: 5 }),
      lrow({ code: 'L-2', name: 'D2', widthM: 3, priceSqm: 260, qtyM: 5 }),
    ],
    emptyVariants()
  );
  const c = plan.creates[0]!;
  assert.equal(c.price, 600, 'MIN(300×2, 260×3) = 600');
  assert.deepEqual(c.specifications[0], { name: 'Ціна за м²', value: '260,00' });
});

test('PLAN: группировка по name — два коди одного дизайну → одна карточка (sku від вузької ширини)', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'A-9', name: 'Helsinki 582', widthM: 3, priceSqm: 300, qtyM: 4 }),
      lrow({ code: 'A-1', name: 'Helsinki 582', widthM: 1.5, priceSqm: 300, qtyM: 2 }),
    ],
    emptyVariants()
  );
  assert.equal(plan.creates.length, 1);
  const c = plan.creates[0]!;
  assert.equal(c.sku, 'ln-xa-1', 'код від вузької (першої) ширини');
  assert.deepEqual(
    c.variants.map((v) => v.sku),
    ['ln-xa-1-w15', 'ln-xa-1-w30'],
    'variant sku завжди від productSku (контракт C2: {productSku}-w{token})'
  );
});

test('PLAN: та сама ширина двічі (два коди) всередині дизайну → остання перемагає (варіант = ширина)', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'C1', name: 'D', widthM: 2, priceSqm: 300, qtyM: 1 }),
      lrow({ code: 'C2', name: 'D', widthM: 2, priceSqm: 310, qtyM: 7 }),
    ],
    emptyVariants()
  );
  assert.equal(plan.creates.length, 1);
  const c = plan.creates[0]!;
  assert.equal(c.variants.length, 1);
  assert.equal(c.variants[0]?.stockQuantity, 7);
  assert.equal(c.stockQuantity, 7);
});

test('PLAN: разные дизайны (разные name) с одним кодом — ОКРЕМІ карточки', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'L-1', name: 'Дизайн Першний', widthM: 2, priceSqm: 300, qtyM: 1 }),
      lrow({ code: 'L-1', name: 'Дизайн Другий', widthM: 2.5, priceSqm: 310, qtyM: 2 }),
    ],
    emptyVariants()
  );
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['ln-xl-1', 'ln-xl-1-2'],
    'коллизия sku решается суффиксом -2'
  );
  assert.deepEqual(plan.creates.map((c) => c.name), ['Дизайн Першний', 'Дизайн Другий']);
  assert.equal(new Set(plan.creates.map((c) => c.slug)).size, 2, 'slug унікальні');
});

// ---------------------------------------------------------------------------
// PLAN: diff-aware updates существующей консолидированной карточки
// ---------------------------------------------------------------------------

function consolidatedExisting(): Map<string, ExistingProduct> {
  return emptyMap([
    [
      'ln-xl-100',
      prod({
        id: 'id-p1',
        sku: 'ln-xl-100',
        name: 'SUGAR OAK 997L',
        price: 525.75,
        stockQuantity: 52,
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '350,50' },
          { name: WIDTH_SPEC_NAME, value: '1,5' },
          { name: WIDTH_SPEC_NAME, value: '2,5' },
          { name: WIDTH_SPEC_NAME, value: '3' },
        ],
      }),
    ],
  ]);
}

function consolidatedVariants(): Map<string, ExistingVariant> {
  return new Map<string, ExistingVariant>([
    [
      'ln-xl-100-w15',
      variant({ id: 'id-v15', sku: 'ln-xl-100-w15', productId: 'id-p1', name: '1,5', price: 525.75, stockQuantity: 12 }),
    ],
    [
      'ln-xl-100-w25',
      variant({ id: 'id-v25', sku: 'ln-xl-100-w25', productId: 'id-p1', name: '2,5', price: 876.25, stockQuantity: 40 }),
    ],
    [
      'ln-xl-100-w30',
      variant({ id: 'id-v30', sku: 'ln-xl-100-w30', productId: 'id-p1', name: '3', price: 1051.5, stockQuantity: 0 }),
    ],
  ]);
}

function sugarOakRows(over: Partial<LinoleumRow> = {}): LinoleumRow[] {
  return [
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 1.5, priceSqm: 350.5, qtyM: 12, ...over }),
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 2.5, priceSqm: 350.5, qtyM: 40 }),
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 3, priceSqm: 350.5, qtyM: 0 }),
  ];
}

test('PLAN: полное совпадение → product noop + variant noops (идемпотентность базы)', () => {
  const plan = planLinoleumImport(consolidatedExisting(), sugarOakRows(), consolidatedVariants());
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.variantCreates, []);
  assert.deepEqual(plan.variantUpdates, []);
  assert.deepEqual(plan.missingProducts, []);
  assert.deepEqual(plan.missingVariants, []);
  assert.deepEqual(plan.conflicts, []);
  assert.ok(plan.noops.includes('ln-xl-100'));
  assert.ok(plan.noops.includes('ln-xl-100-w15'));
  assert.ok(plan.noops.includes('ln-xl-100-w25'));
  assert.ok(plan.noops.includes('ln-xl-100-w30'));
});

test('PLAN: price_sqm изменился → product update (MIN price + specs) + варіанти (кожен price)', () => {
  const rows = sugarOakRows().map((r) => ({ ...r, priceSqm: 410 }));
  const plan = planLinoleumImport(consolidatedExisting(), rows, consolidatedVariants());
  assert.deepEqual(plan.updates, [
    {
      id: 'id-p1',
      fields: {
        price: 615, // MIN: 410 × 1.5
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '410,00' },
          { name: WIDTH_SPEC_NAME, value: '1,5' },
          { name: WIDTH_SPEC_NAME, value: '2,5' },
          { name: WIDTH_SPEC_NAME, value: '3' },
        ],
      },
    },
  ]);
  assert.deepEqual(plan.variantUpdates, [
    { id: 'id-v15', fields: { price: 615 } },
    { id: 'id-v25', fields: { price: 1025 } },
    { id: 'id-v30', fields: { price: 1230 } },
  ]);
});

test('PLAN: изменился только qty одной ширины → variant update stock + product update SUM', () => {
  const rows = [
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 1.5, priceSqm: 350.5, qtyM: 12 }),
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 2.5, priceSqm: 350.5, qtyM: 35 }),
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 3, priceSqm: 350.5, qtyM: 0 }),
  ];
  const plan = planLinoleumImport(consolidatedExisting(), rows, consolidatedVariants());
  assert.deepEqual(plan.updates, [{ id: 'id-p1', fields: { stock_quantity: 47 } }]);
  assert.deepEqual(plan.variantUpdates, [{ id: 'id-v25', fields: { stock_quantity: 35 } }]);
  assert.deepEqual(plan.variantCreates, []);
});

test('PLAN: новая ширина у существующего дизайна → variantCreates (is_active true, availability по qty)', () => {
  const rows = [
    ...sugarOakRows(),
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 4, priceSqm: 350.5, qtyM: 6 }),
  ];
  const existing = consolidatedExisting();
  const existingSpecs = existing.get('ln-xl-100')!.specifications;
  const plan = planLinoleumImport(existing, rows, consolidatedVariants());
  assert.deepEqual(plan.variantCreates, [
    {
      productId: 'id-p1',
      variant: {
        sku: 'ln-xl-100-w40',
        name: '4',
        price: 1402,
        stockQuantity: 6,
        availability: 'in_stock',
        isActive: true,
      },
    },
  ]);
  // specs продукта дополняются «Ширина 4» (список ширин — данные карточки)
  const update = plan.updates[0];
  assert.ok(update, 'product update несёт новые specs');
  assert.deepEqual(update.fields.specifications, [
    ...existingSpecs,
    { name: WIDTH_SPEC_NAME, value: '4' },
  ]);
  assert.equal(update.fields.stock_quantity, 58);
});

test('PLAN: ширина зникла з дизайну → missingVariants (варіант → 0) + specs/SUM оновлюються; qty=0 зниклий — noop', () => {
  const rows = [
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 1.5, priceSqm: 350.5, qtyM: 12 }),
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 3, priceSqm: 350.5, qtyM: 0 }),
  ];
  const plan = planLinoleumImport(consolidatedExisting(), rows, consolidatedVariants());
  assert.deepEqual(plan.missingVariants, [{ id: 'id-v25' }], 'w25 (qty 40) зник → 0');
  assert.ok(plan.noops.includes('ln-xl-100-w30'), 'нульовий зниклий — noop');
  const update = plan.updates[0];
  assert.ok(update, 'product update: SUM без 2,5 + specs без «2,5»');
  assert.equal(update.fields.stock_quantity, 12);
  assert.deepEqual(update.fields.specifications, [
    { name: PRICE_SQM_SPEC_NAME, value: '350,50' },
    { name: WIDTH_SPEC_NAME, value: '1,5' },
    { name: WIDTH_SPEC_NAME, value: '3' },
  ]);
});

test('PLAN: исчезнувший дизайн → missingProducts + все его варианты в missingVariants; уже сведённые — noops', () => {
  const existing = consolidatedExisting();
  const variants = consolidatedVariants();
  const plan = planLinoleumImport(existing, [lrow({ code: 'OTHER', name: 'Інший', widthM: 2 })], variants);
  assert.deepEqual(plan.missingProducts, [{ id: 'id-p1' }]);
  assert.deepEqual(
    plan.missingVariants.map((m) => m.id).sort(),
    ['id-v15', 'id-v25'],
    'нулевой w30 — не в missing'
  );
  assert.ok(plan.noops.includes('ln-xl-100-w30'));
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['ln-xother']
  );
});

// ---------------------------------------------------------------------------
// L12: тех-записи сайту в specifications переживают sync (импортер владеет
// только каноном 1С — «Ціна за м²» + «Ширина»×N)
// ---------------------------------------------------------------------------

/** Консолідована карточка з тех-записами, доданими сайтом поверх канону 1С
 *  (джерела — карточки магазинів, не 1С). Канон першим, extra після нього —
 *  саме так виглядає жива карточка після адмінських доповнень. */
function consolidatedWithSiteSpecs(): Map<string, ExistingProduct> {
  return emptyMap([
    [
      'ln-xl-100',
      prod({
        id: 'id-p1',
        sku: 'ln-xl-100',
        name: 'SUGAR OAK 997L',
        price: 525.75,
        stockQuantity: 52,
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '350,50' },
          { name: WIDTH_SPEC_NAME, value: '1,5' },
          { name: WIDTH_SPEC_NAME, value: '2,5' },
          { name: WIDTH_SPEC_NAME, value: '3' },
          { name: 'Клас зносостійкості', value: '23' },
          { name: 'Товщина', value: '2,5 мм' },
          { name: 'Основа', value: 'Війлок' },
          { name: 'Виробник', value: 'Beauflor' },
          { name: 'Країна виробник', value: 'Бельгія' },
        ],
      }),
    ],
  ]);
}

test('L12 PLAN: update зберігає тех-записи сайту (Виробник/Клас/…) — канон 1С оновлюється, extra переносяться як є', () => {
  const rows = sugarOakRows().map((r) => ({ ...r, priceSqm: 410 }));
  const plan = planLinoleumImport(consolidatedWithSiteSpecs(), rows, consolidatedVariants());
  assert.deepEqual(plan.updates, [
    {
      id: 'id-p1',
      fields: {
        price: 615, // MIN: 410 × 1.5
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '410,00' },
          { name: WIDTH_SPEC_NAME, value: '1,5' },
          { name: WIDTH_SPEC_NAME, value: '2,5' },
          { name: WIDTH_SPEC_NAME, value: '3' },
          { name: 'Клас зносостійкості', value: '23' },
          { name: 'Товщина', value: '2,5 мм' },
          { name: 'Основа', value: 'Війлок' },
          { name: 'Виробник', value: 'Beauflor' },
          { name: 'Країна виробник', value: 'Бельгія' },
        ],
      },
    },
  ]);
  assert.equal(preservedTechSpecCount(plan), 5, 'усі 5 тех-записів сайту перенесено');
});

test('L12 PLAN: CREATE — специфікації лише канонічні (extra-записам узяти нізвідки), preservedTechSpecCount = 0', () => {
  const plan = planLinoleumImport(emptyMap(), sugarOakRows(), emptyVariants());
  assert.deepEqual(
    [...new Set((plan.creates[0]?.specifications ?? []).map((s) => s.name))].sort(),
    ['Ціна за м²', 'Ширина'],
    'у create потрапляють тільки імена канону 1С'
  );
  assert.equal(preservedTechSpecCount(plan), 0);
});

test('L12 PLAN: ідемпотентність з тех-записами сайту — оновлений канон + ті самі extra, повтор порожній', () => {
  const existing = consolidatedWithSiteSpecs();
  const rows = sugarOakRows().map((r) => ({ ...r, priceSqm: 410 }));
  const applied = simulateApply(existing, rows, consolidatedVariants());
  const stored = applied.products.get('ln-xl-100')!.specifications;
  assert.equal(stored.filter((s) => s.name === 'Виробник').length, 1, 'extra не задублено');
  assert.deepEqual(
    stored,
    [
      { name: PRICE_SQM_SPEC_NAME, value: '410,00' },
      { name: WIDTH_SPEC_NAME, value: '1,5' },
      { name: WIDTH_SPEC_NAME, value: '2,5' },
      { name: WIDTH_SPEC_NAME, value: '3' },
      { name: 'Клас зносостійкості', value: '23' },
      { name: 'Товщина', value: '2,5 мм' },
      { name: 'Основа', value: 'Війлок' },
      { name: 'Виробник', value: 'Beauflor' },
      { name: 'Країна виробник', value: 'Бельгія' },
    ],
    'канон оновлено, extra залишились на своїх місцях'
  );
  const plan2 = planLinoleumImport(applied.products, rows, applied.variants);
  assert.deepEqual(plan2.updates, [], 'повторний --run поверх extra — noop');
  assert.deepEqual(plan2.creates, []);
  assert.ok(plan2.noops.includes('ln-xl-100'));
});

test('L12 PLAN: запис з іменем «Ширина» серед збережених не виживає — канон перемагає (edge L12)', () => {
  const existing = emptyMap([
    [
      'ln-xl-100',
      prod({
        id: 'id-p1',
        sku: 'ln-xl-100',
        name: 'SUGAR OAK 997L',
        price: 525.75,
        stockQuantity: 52,
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '350,50' },
          { name: WIDTH_SPEC_NAME, value: '1,5' },
          { name: WIDTH_SPEC_NAME, value: '2,5' },
          { name: WIDTH_SPEC_NAME, value: '3' },
          { name: 'Виробник', value: 'Beauflor' },
          { name: WIDTH_SPEC_NAME, value: '2,5 м' }, // «extra» з канонічним іменем
        ],
      }),
    ],
  ]);
  const plan = planLinoleumImport(existing, sugarOakRows(), consolidatedVariants());
  assert.equal(plan.updates.length, 1, 'список ширин — дані карточки: оновлюється');
  const specs = plan.updates[0]!.fields.specifications ?? [];
  assert.equal(
    specs.filter((s) => s.name === WIDTH_SPEC_NAME).length,
    3,
    'рівно канонічні ширини фіду'
  );
  assert.ok(!specs.some((s) => s.value === '2,5 м'), 'збережений «Ширина 2,5 м» не виживає');
  assert.ok(specs.some((s) => s.name === 'Виробник'), 'справжній extra зберігається');
});

test('L12 SPECS: preservedTechSpecCount — рахує лише не-канонічні записи в перезаписах specs оновлень', () => {
  const base = {
    creates: [],
    variantCreates: [],
    variantUpdates: [],
    missingProducts: [],
    missingVariants: [],
    noops: [],
    conflicts: [],
  };
  assert.equal(
    preservedTechSpecCount({
      ...base,
      updates: [
        {
          id: 'a',
          fields: {
            specifications: [
              { name: PRICE_SQM_SPEC_NAME, value: '410,00' },
              { name: WIDTH_SPEC_NAME, value: '2' },
              { name: 'Виробник', value: 'Beauflor' },
              { name: 'Товщина', value: '2,5 мм' },
            ],
          },
        },
        { id: 'b', fields: { price: 100 } }, // specs не переписуються → extra зберігаються тривіально
      ],
    }),
    2
  );
  assert.equal(preservedTechSpecCount({ ...base, updates: [] }), 0);
});

// ---------------------------------------------------------------------------
// PLAN: идемпотентность (план поверх своей же применённой выдачи пуст)
// ---------------------------------------------------------------------------

test('PLAN: идемпотентность — план поверх применённой выдачи пуст, все skus в noops', () => {
  const existing = consolidatedExisting();
  const variants = consolidatedVariants();
  const rows = sugarOakRows();
  const applied = simulateApply(existing, rows, variants);
  const plan2 = planLinoleumImport(applied.products, rows, applied.variants);

  assert.deepEqual(plan2.creates, []);
  assert.deepEqual(plan2.updates, []);
  assert.deepEqual(plan2.variantCreates, []);
  assert.deepEqual(plan2.variantUpdates, []);
  assert.deepEqual(plan2.missingProducts, []);
  assert.deepEqual(plan2.missingVariants, []);
  assert.deepEqual(plan2.conflicts, []);
  assert.deepEqual(
    [...plan2.noops].sort(),
    [...applied.products.keys(), ...applied.variants.keys()].sort(),
    'все продукты и варианты домена — noops'
  );
});

test('PLAN: идемпотентность после появления и исчезновения ширины (вариант create → missing → noop)', () => {
  const existing = consolidatedExisting();
  const variants = consolidatedVariants();
  const withW4 = [
    ...sugarOakRows(),
    lrow({ code: 'L-100', name: 'SUGAR OAK 997L', widthM: 4, priceSqm: 350.5, qtyM: 6 }),
  ];
  const applied = simulateApply(existing, withW4, variants);
  const withoutW4 = sugarOakRows();
  const applied2 = simulateApply(applied.products, withoutW4, applied.variants);
  const plan3 = planLinoleumImport(applied2.products, withoutW4, applied2.variants);
  assert.deepEqual(plan3.creates, []);
  assert.deepEqual(plan3.updates, []);
  assert.deepEqual(plan3.variantCreates, []);
  assert.deepEqual(plan3.variantUpdates, []);
  assert.deepEqual(plan3.missingProducts, []);
  assert.deepEqual(plan3.missingVariants, []);
});

// ---------------------------------------------------------------------------
// PLAN: коллизии + контракт домена
// ---------------------------------------------------------------------------

test('PLAN: коллизия нормализованных кодов (A 1 и a1) → суффикс -2, детерминированно', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'A 1', name: 'Перша', widthM: 2 }),
      lrow({ code: 'a1', name: 'Друга', widthM: 2 }),
    ],
    emptyVariants()
  );
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['ln-xa1', 'ln-xa1-2']
  );
  const slugs = plan.creates.map((c) => c.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'slug уникальны');
});

test('PLAN: коллизия с существующим sku — первый матчается (update), второй создаётся с -2', () => {
  const existing = emptyMap([
    ['ln-xa1', prod({ id: 'id-old', sku: 'ln-xa1', name: 'Друга', price: 700, stockQuantity: 1 })],
  ]);
  const plan = planLinoleumImport(
    existing,
    [
      lrow({ code: 'a1', name: 'Друга', widthM: 2, priceSqm: 410, qtyM: 1 }),
      lrow({ code: 'A 1', name: 'Перша', widthM: 2.5, priceSqm: 350, qtyM: 1 }),
    ],
    emptyVariants()
  );
  assert.equal(plan.updates.length, 1, 'первая группа матчает существующую (diff по цене)');
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['ln-xa1-2']
  );
});

test('PLAN: conflicts — всегда [] по контракту (вход отфильтрован по домену ln-*)', () => {
  const plan = planLinoleumImport(emptyMap(), [lrow({ code: 'L-1', name: 'D' })], emptyVariants());
  assert.deepEqual(plan.conflicts, []);
});

test('PLAN: не-ln ключи в existing игнорируются полностью', () => {
  const existing = emptyMap([
    ['yc-123', prod({ id: 'id-yc', sku: 'yc-123' })],
    ['wc-x6647-04', prod({ id: 'id-wc', sku: 'wc-x6647-04' })],
  ]);
  const plan = planLinoleumImport(
    existing,
    [lrow({ code: 'L-1', name: 'D' })],
    emptyVariants()
  );
  assert.deepEqual(plan.missingProducts, []);
  assert.deepEqual(plan.noops, []);
  assert.deepEqual(plan.updates, []);
});

test('PLAN: варианты чужих продуктов не попадают в missing (только варианты ln-продуктов)', () => {
  const existing = emptyMap([
    ['ln-xgone', prod({ id: 'id-gone', sku: 'ln-xgone', stockQuantity: 3 })],
  ]);
  const variants = new Map<string, ExistingVariant>([
    [
      'ln-xgone-w20',
      variant({ id: 'id-v-gone', sku: 'ln-xgone-w20', productId: 'id-gone', stockQuantity: 2 }),
    ],
    [
      'ln-xforeign-w20',
      variant({ id: 'id-v-foreign', sku: 'ln-xforeign-w20', productId: 'id-yc', stockQuantity: 9 }),
    ],
  ]);
  const plan = planLinoleumImport(existing, [], variants);
  assert.deepEqual(plan.missingProducts, [{ id: 'id-gone' }]);
  assert.deepEqual(plan.missingVariants, [{ id: 'id-v-gone' }]);
});
