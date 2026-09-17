/**
 * Лінолеум, батч 2: pure-планировщик импорта staging→products
 * app/lib/linoleum/import-plan.ts (зеркало tests/wallpaper-import-plan.test.ts).
 *
 * Полностью чистые тесты: никаких БД/Next/секретов — только pure-модуль
 * + тип LinoleumRow из app/lib/linoleum/parse.ts + константа корневого slug'а
 * из app/lib/catalog/shared.ts (cross-pin: импортер и витрина о одном slug'е).
 *
 * Контракт (план L3, 2026-09-17):
 *  - товарная модель: ОДНА карточка = дизайн×ширина; sku-домен `ln-*`;
 *  - sku = `ln-x<нормализованный код 1С>-w<токен ширины>`; нормализация кода:
 *    trim + lowercase + вырезка пробелов; коды уже внутри charset'а
 *    [a-z0-9-] проходят как есть, коды с символами вне него (кириллица:
 *    «ЛІН-01160049») → digits-only фолбэк («01160049»); токен ширины =
 *    ширина×10 (1.5→'15', 2→'20', 2.5→'25', 3→'30', 3.5→'35', 4→'40') —
 *    детерминированно, идемпотентно, 1:1 на (код, ширина), charset
 *    slug'а [a-z0-9-];
 *  - имя карточки: `{name} {ширина} м`, ширина в українській комою
 *    ('1,5'/'2'/'2,5'/'3'/'3,5'/'4') — uk-контент, format.ts рендерит
 *    uk-UA комою;
 *  - products.price = грн за ПОГОННЫЙ метр = price_sqm × width_m, HALF-UP
 *    до копійки (співпадає з округленням Postgres NUMERIC);
 *  - specifications (jsonb array): {'Ціна за м²': '350,50'} + {'Ширина': '2,5'};
 *  - creates: availability по qty (0 → out_of_stock), isActive всегда false;
 *  - updates: diff-aware (price / specifications / stock_quantity);
 *    спецификации переписываются ТОЛЬКО при расхождении «Ціна за м²»
 *    (replace-in-place, остальные записи и порядок сохраняются); «Ширина»
 *    на update не трогается никогда — (код, ширина) и есть идентичность
 *    карточки; имя/sku/slug/is_active существующих не трогаются;
 *  - missing: существующие ln-*, исчезнувшие из выгрузки (ещё не OOS);
 *    уже сведённые (qty=0) — в noops; DELETE никогда;
 *  - conflicts: всегда [] по контракту (домен отфильтрован upstream);
 *  - дедуп по (code, width_m): последняя строка побеждает.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINOLEUM_ROOT_CATEGORY,
  PRICE_SQM_SPEC_NAME,
  WIDTH_SPEC_NAME,
  findSpecValue,
  formatPriceSqmValue,
  formatWidthM,
  linoleumCardName,
  linoleumSku,
  planLinoleumImport,
  runningMeterPrice,
  withPriceSqmSpec,
  type ExistingProduct,
  type LinoleumPlan,
} from '../app/lib/linoleum/import-plan.ts';
import type { LinoleumRow } from '../app/lib/linoleum/parse.ts';

// catalog/shared.ts creates its anon Supabase client at module load; provide
// the publishable-env placeholders BEFORE the dynamic import (no network).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';

function lrow(over: Partial<LinoleumRow> & { code: string }): LinoleumRow {
  return {
    name: `Лінолеум ${over.code}`,
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
    name: 'x',
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

function emptyMap(
  entries: Array<[string, ExistingProduct]> = []
): Map<string, ExistingProduct> {
  return new Map(entries);
}

/** Имитирует исполнение плана: создаёт/обновляет/сводит missing в qty=0. */
function simulateApply(
  existing: Map<string, ExistingProduct>,
  rows: LinoleumRow[]
): Map<string, ExistingProduct> {
  const plan: LinoleumPlan = planLinoleumImport(existing, rows);
  const next = new Map(existing);
  let i = 0;
  for (const c of plan.creates) {
    i += 1;
    next.set(c.sku, {
      id: `new-${i}`,
      sku: c.sku,
      name: c.name,
      price: c.price,
      stockQuantity: c.stockQuantity,
      isActive: c.isActive,
      specifications: c.specifications,
    });
  }
  const byId = new Map([...next].map(([sku, p]) => [p.id, sku] as const));
  for (const u of plan.updates) {
    const sku = byId.get(u.id);
    if (sku === undefined) throw new Error(`update для неизвестного id ${u.id}`);
    const p = next.get(sku);
    if (p === undefined) throw new Error(`нет товара ${sku}`);
    next.set(sku, {
      ...p,
      price: u.fields.price ?? p.price,
      stockQuantity: u.fields.stock_quantity ?? p.stockQuantity,
      specifications: u.fields.specifications ?? p.specifications,
    });
  }
  const missingIds = new Set(plan.missing.map((m) => m.id));
  for (const [sku, p] of next) {
    if (missingIds.has(p.id)) next.set(sku, { ...p, stockQuantity: 0 });
  }
  return next;
}

// ---------------------------------------------------------------------------
// форматтеры: ширина, цена за м², имя, sku
// ---------------------------------------------------------------------------

test('FORMAT: formatWidthM — українська кома, цілі без дробу (канон для імені, специфікації і майбутнього фільтра ширин хаба)', () => {
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

test('FORMAT: имя карточки = «{name} {ширина} м» (карта = дизайн × ширина)', () => {
  assert.equal(linoleumCardName('Лінолеум Форум', 2.5), 'Лінолеум Форум 2,5 м');
  assert.equal(linoleumCardName('Лінолеум Тарко', 2), 'Лінолеум Тарко 2 м');
});

test('FORMAT: sku = ln-x{код}-w{ширина×10} — детермінований, 1:1 на (код, ширина), charset [a-z0-9-]', () => {
  assert.equal(linoleumSku('1234', 1.5), 'ln-x1234-w15');
  assert.equal(linoleumSku('1234', 2), 'ln-x1234-w20');
  assert.equal(linoleumSku('1234', 2.5), 'ln-x1234-w25');
  assert.equal(linoleumSku('1234', 3), 'ln-x1234-w30');
  assert.equal(linoleumSku('1234', 3.5), 'ln-x1234-w35');
  assert.equal(linoleumSku('1234', 4), 'ln-x1234-w40');
  // нормализация кода: trim + lowercase + пробелы вырезаются
  assert.equal(linoleumSku('  A 100 ', 2), 'ln-xa100-w20');
  // 1:1: разные ширины одного кода — разные sku
  const widths = [1.5, 2, 2.5, 3, 3.5, 4] as const;
  const tokens = widths.map((w) => linoleumSku('L-1', w));
  assert.equal(new Set(tokens).size, 6);
  for (const sku of tokens) assert.match(sku, /^[a-z0-9-]+$/);
});

test('FORMAT: кириллический код поставщика → digits-only fallback, sku/slug остаются [a-z0-9-]', () => {
  // Реальный код выгрузки 1С: кириллица + дефис + цифры. Наивная
  // нормализация (trim+lowercase) оставила бы кириллицу в slug'е.
  assert.equal(linoleumSku('ЛІН-01160049', 1.5), 'ln-x01160049-w15');
  // Детерминированность: регистр/пробелы не меняют ядро кода.
  assert.equal(linoleumSku('лІН 01160049', 2), 'ln-x01160049-w20');
  // План целиком: slug === sku и весь charset [a-z0-9-].
  const plan = planLinoleumImport(emptyMap(), [lrow({ code: 'ЛІН-01160049' })]);
  assert.equal(plan.creates.length, 1);
  const created = plan.creates[0]!;
  assert.equal(created.slug, created.sku);
  assert.match(created.sku, /^[a-z0-9-]+$/);
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
// спецификации: helpers
// ---------------------------------------------------------------------------

test('SPECS: create-набор = [Ціна за м², Ширина] в этом порядке', () => {
  const result = planLinoleumImport(emptyMap(), [
    lrow({ code: 'L-1', priceSqm: 350.5, widthM: 2.5 }),
  ]);
  assert.deepEqual(result.creates[0]?.specifications, [
    { name: 'Ціна за м²', value: '350,50' },
    { name: 'Ширина', value: '2,5' },
  ]);
});

test('SPECS: withPriceSqmSpec — replace-in-place, остальные записи и порядок нетронуты', () => {
  const stored = [
    { name: 'Клас зносу', value: '23' },
    { name: PRICE_SQM_SPEC_NAME, value: '300,00' },
    { name: WIDTH_SPEC_NAME, value: '3' },
  ];
  assert.deepEqual(withPriceSqmSpec(stored, '410,00'), [
    { name: 'Клас зносу', value: '23' },
    { name: PRICE_SQM_SPEC_NAME, value: '410,00' },
    { name: WIDTH_SPEC_NAME, value: '3' },
  ]);
});

test('SPECS: withPriceSqmSpec — записи нет → добавляется в конец', () => {
  assert.deepEqual(withPriceSqmSpec([{ name: WIDTH_SPEC_NAME, value: '2' }], '350,00'), [
    { name: WIDTH_SPEC_NAME, value: '2' },
    { name: PRICE_SQM_SPEC_NAME, value: '350,00' },
  ]);
  assert.deepEqual(withPriceSqmSpec([], '350,00'), [
    { name: PRICE_SQM_SPEC_NAME, value: '350,00' },
  ]);
});

test('SPECS: findSpecValue — находка, отсутствие → undefined', () => {
  const stored = [{ name: PRICE_SQM_SPEC_NAME, value: '300,00' }];
  assert.equal(findSpecValue(stored, PRICE_SQM_SPEC_NAME), '300,00');
  assert.equal(findSpecValue(stored, WIDTH_SPEC_NAME), undefined);
  assert.equal(findSpecValue([], PRICE_SQM_SPEC_NAME), undefined);
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

// ---------------------------------------------------------------------------
// PLAN: creates
// ---------------------------------------------------------------------------

test('PLAN: пустая БД → creates с sku ln-x<код>-w<токен>, именем «{name} {w} м», ценой пог.м, specs, availability по qty', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'L-100', name: 'Лінолеум Форум', widthM: 2.5, priceSqm: 350.5, qtyM: 40 }),
      lrow({ code: 'L-200', name: 'Лінолеум Тарко', widthM: 3, priceSqm: 410, qtyM: 0 }),
    ]
  );

  assert.equal(plan.creates.length, 2);
  assert.deepEqual(plan.creates[0], {
    sku: 'ln-xl-100-w25',
    slug: 'ln-xl-100-w25',
    name: 'Лінолеум Форум 2,5 м',
    price: 876.25, // 350.5 × 2.5
    stockQuantity: 40,
    availability: 'in_stock',
    isActive: false,
    specifications: [
      { name: 'Ціна за м²', value: '350,50' },
      { name: 'Ширина', value: '2,5' },
    ],
  });
  assert.deepEqual(plan.creates[1], {
    sku: 'ln-xl-200-w30',
    slug: 'ln-xl-200-w30',
    name: 'Лінолеум Тарко 3 м',
    price: 1230, // 410 × 3
    stockQuantity: 0,
    availability: 'out_of_stock',
    isActive: false,
    specifications: [
      { name: 'Ціна за м²', value: '410,00' },
      { name: 'Ширина', value: '3' },
    ],
  });
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.noops, []);
  assert.deepEqual(plan.conflicts, []);
  for (const c of plan.creates) assert.equal(c.slug, c.sku, 'slug === sku');
});

test('PLAN: один код, несколько ширин → ОТДЕЛЬНЫЕ карточки (дизайн × ширина)', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'L-1', widthM: 2, priceSqm: 300 }),
      lrow({ code: 'L-1', widthM: 3, priceSqm: 300 }),
      lrow({ code: 'L-1', widthM: 4, priceSqm: 300 }),
    ]
  );
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['ln-xl-1-w20', 'ln-xl-1-w30', 'ln-xl-1-w40']
  );
  // у каждой своя цена пог.м и своя «Ширина»
  assert.equal(plan.creates[0]?.price, 600);
  assert.equal(plan.creates[1]?.price, 900);
  assert.equal(plan.creates[2]?.price, 1200);
});

// ---------------------------------------------------------------------------
// PLAN: дедуп по (code, width)
// ---------------------------------------------------------------------------

test('PLAN: дедуп по (code,width) — последняя строка побеждает, порядок по первому появлению', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'A', widthM: 2, priceSqm: 100, qtyM: 1, name: 'перша A' }),
      lrow({ code: 'B', widthM: 2, priceSqm: 100, qtyM: 2 }),
      lrow({ code: 'A', widthM: 2, priceSqm: 120, qtyM: 4, name: 'остання A' }),
    ]
  );
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['ln-xa-w20', 'ln-xb-w20']
  );
  const a = plan.creates[0];
  assert.ok(a, 'create для A существует');
  assert.equal(a.name, 'остання A 2 м');
  assert.equal(a.price, 240);
  assert.equal(a.stockQuantity, 4);
});

// ---------------------------------------------------------------------------
// PLAN: diff-aware updates
// ---------------------------------------------------------------------------

test('PLAN: price_sqm изменился → update несёт price (новый пог.м) + specifications (новая «Ціна за м²»), stock нетронут', () => {
  const existing = emptyMap([
    [
      'ln-xl-1-w20',
      prod({
        id: 'id-p1',
        sku: 'ln-xl-1-w20',
        price: 700, // 350 × 2
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '350,00' },
          { name: WIDTH_SPEC_NAME, value: '2' },
        ],
        stockQuantity: 5,
      }),
    ],
  ]);
  const plan = planLinoleumImport(existing, [
    lrow({ code: 'L-1', widthM: 2, priceSqm: 410, qtyM: 5 }),
  ]);
  assert.deepEqual(plan.updates, [
    {
      id: 'id-p1',
      fields: {
        price: 820, // 410 × 2
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '410,00' },
          { name: WIDTH_SPEC_NAME, value: '2' },
        ],
      },
    },
  ]);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.noops, []);
});

test('PLAN: изменился только qty → update несёт ТОЛЬКО stock_quantity (спецификации/цена нетронуты)', () => {
  const existing = emptyMap([
    ['ln-xl-1-w20', prod({ id: 'id-q1', sku: 'ln-xl-1-w20', price: 700, stockQuantity: 5 })],
  ]);
  const plan = planLinoleumImport(existing, [
    lrow({ code: 'L-1', widthM: 2, priceSqm: 350, qtyM: 0 }),
  ]);
  assert.deepEqual(plan.updates, [{ id: 'id-q1', fields: { stock_quantity: 0 } }]);
});

test('PLAN: цена и stock разошлись, specs совпали → два поля, specifications НЕ пишется', () => {
  const existing = emptyMap([
    [
      'ln-xl-1-w25',
      prod({
        id: 'id-m1',
        sku: 'ln-xl-1-w25',
        price: 700, // расходится (ожидаётся 875)
        stockQuantity: 5, // расходится (ожидаются 40)
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '350,00' },
          { name: WIDTH_SPEC_NAME, value: '2,5' },
        ],
      }),
    ],
  ]);
  const plan = planLinoleumImport(existing, [
    lrow({ code: 'L-1', widthM: 2.5, priceSqm: 350, qtyM: 40 }),
  ]);
  assert.deepEqual(plan.updates, [
    { id: 'id-m1', fields: { price: 875, stock_quantity: 40 } },
  ]);
});

test('PLAN: specs без «Ціна за м²» (ручная/старая строка) → specifications дописываются', () => {
  const existing = emptyMap([
    [
      'ln-xl-1-w20',
      prod({
        id: 'id-s1',
        sku: 'ln-xl-1-w20',
        price: 700,
        specifications: [{ name: WIDTH_SPEC_NAME, value: '2' }],
      }),
    ],
  ]);
  const plan = planLinoleumImport(existing, [
    lrow({ code: 'L-1', widthM: 2, priceSqm: 350, qtyM: 5 }),
  ]);
  assert.deepEqual(plan.updates, [
    {
      id: 'id-s1',
      fields: {
        specifications: [
          { name: WIDTH_SPEC_NAME, value: '2' },
          { name: PRICE_SQM_SPEC_NAME, value: '350,00' },
        ],
      },
    },
  ]);
});

test('PLAN: «Ширина» на update НИКОГДА не переписывается (идентичность карточки — код×ширина)', () => {
  const existing = emptyMap([
    [
      'ln-xl-1-w20',
      prod({
        id: 'id-w1',
        sku: 'ln-xl-1-w20',
        price: 700,
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '350,00' },
          { name: WIDTH_SPEC_NAME, value: 'ДРУГОЕ' },
        ],
      }),
    ],
  ]);
  const plan = planLinoleumImport(existing, [
    lrow({ code: 'L-1', widthM: 2, priceSqm: 350, qtyM: 5 }),
  ]);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.noops, ['ln-xl-1-w20']);
});

test('PLAN: полное совпадение (цена пог.м + specs + qty) → sku в noops', () => {
  const existing = emptyMap([
    [
      'ln-xl-1-w15',
      prod({
        id: 'id-ok1',
        sku: 'ln-xl-1-w15',
        price: 525.75,
        stockQuantity: 3,
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: '350,50' },
          { name: WIDTH_SPEC_NAME, value: '1,5' },
        ],
      }),
    ],
  ]);
  const plan = planLinoleumImport(existing, [
    lrow({ code: 'L-1', widthM: 1.5, priceSqm: 350.5, qtyM: 3 }),
  ]);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.noops, ['ln-xl-1-w15']);
  assert.deepEqual(plan.conflicts, []);
});

// ---------------------------------------------------------------------------
// PLAN: missing → OOS (никогда DELETE)
// ---------------------------------------------------------------------------

test('PLAN: исчезнувшие из выгрузки → missing (qty>0); уже сведённые (qty=0) → noops', () => {
  const existing = emptyMap([
    ['ln-xgone1-w20', prod({ id: 'id-gone1', sku: 'ln-xgone1-w20', stockQuantity: 3 })],
    ['ln-xgone2-w20', prod({ id: 'id-gone2', sku: 'ln-xgone2-w20', stockQuantity: 0 })],
  ]);
  const plan = planLinoleumImport(existing, [
    lrow({ code: 'alive', widthM: 2, qtyM: 1 }),
  ]);
  assert.deepEqual(plan.missing, [{ id: 'id-gone1' }]);
  assert.ok(plan.noops.includes('ln-xgone2-w20'), 'сведённая строка — noop');
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['ln-xalive-w20']
  );
});

// ---------------------------------------------------------------------------
// PLAN: идемпотентность
// ---------------------------------------------------------------------------

test('PLAN: идемпотентность — план поверх своей же применённой выдачи пуст', () => {
  const existing = emptyMap([
    ['ln-xalive-w20', prod({ id: 'id-alive', sku: 'ln-xalive-w20', price: 700, stockQuantity: 5 })],
    ['ln-xgone-w25', prod({ id: 'id-gone', sku: 'ln-xgone-w25', price: 500, stockQuantity: 2 })],
  ]);
  const rows = [
    lrow({ code: 'alive', widthM: 2, priceSqm: 410, qtyM: 5 }),
    lrow({ code: 'fresh', widthM: 2.5, priceSqm: 200, qtyM: 1 }),
  ];

  const applied = simulateApply(existing, rows);
  const plan2 = planLinoleumImport(applied, rows);

  assert.deepEqual(plan2.creates, []);
  assert.deepEqual(plan2.updates, []);
  assert.deepEqual(plan2.missing, []);
  assert.deepEqual(plan2.conflicts, []);
  assert.deepEqual(
    [...plan2.noops].sort(),
    [...applied.keys()].sort(),
    'все товары домена — noops'
  );
});

// ---------------------------------------------------------------------------
// PLAN: коллизии + контракт домена
// ---------------------------------------------------------------------------

test('PLAN: коллизия нормализованных кодов (A 1 и a1) → суффикс -2, детерминированно', () => {
  const plan = planLinoleumImport(
    emptyMap(),
    [
      lrow({ code: 'A 1', widthM: 2, name: 'перша' }),
      lrow({ code: 'a1', widthM: 2, name: 'друга' }),
    ]
  );
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['ln-xa1-w20', 'ln-xa1-w20-2']
  );
  const slugs = plan.creates.map((c) => c.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'slug уникальны');
});

test('PLAN: коллизия с существующим sku — первый матчается, второй создаётся с -2', () => {
  const existing = emptyMap([
    ['ln-xa1-w20', prod({ id: 'id-old', sku: 'ln-xa1-w20', price: 700, stockQuantity: 1 })],
  ]);
  const plan = planLinoleumImport(existing, [
    lrow({ code: 'a1', widthM: 2, priceSqm: 350, qtyM: 1 }),
    lrow({ code: 'A 1', widthM: 2, priceSqm: 350, qtyM: 1 }),
  ]);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['ln-xa1-w20-2']
  );
  assert.deepEqual(plan.noops, ['ln-xa1-w20']);
});

test('PLAN: conflicts — всегда [] по контракту (вход отфильтрован по домену ln-*)', () => {
  const plan = planLinoleumImport(emptyMap(), [lrow({ code: 'L-1' })]);
  assert.deepEqual(plan.conflicts, []);
});

test('PLAN: не-ln ключи в existing игнорируются полностью', () => {
  const existing = emptyMap([
    ['yc-123', prod({ id: 'id-yc', sku: 'yc-123' })],
    ['wc-x6647-04', prod({ id: 'id-wc', sku: 'wc-x6647-04' })],
  ]);
  const plan = planLinoleumImport(existing, [lrow({ code: 'L-1' })]);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.noops, []);
  assert.deepEqual(plan.updates, []);
});
