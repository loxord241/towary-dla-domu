/**
 * Task 6 (wallpapers import): pure-планировщик импорта товаров
 * app/lib/wallpapers/import-plan.ts.
 *
 * Полностью чистые тесты: никаких БД/Next/секретов — только pure-модуль
 * + тип WallpaperRow из app/lib/wallpapers/parse.ts.
 *
 * Контракт (план Task 6, версия координатора 2026-09-10):
 *  - sku-домен `wc-*`: с артикулом → `wc-<нормализованный артикул>`,
 *    без артикула (article = null) → `wc-x<код 1С>`;
 *  - creates: sku/slug (slug === sku), name как в 1С, price, stockQuantity,
 *    availability по qty (0 → out_of_stock), isActive: false; коллизия
 *    sku/slug → суффикс `-2`, `-3`, …;
 *  - updates: ТОЛЬКО реально расходящиеся поля (price / stock_quantity);
 *  - missing: существующие wc-*, исчезнувшие из файла (ещё не OOS);
 *    уже сведённые (qty=0) — в noops, чтобы повторный план был пуст;
 *  - noops: sku, по которым в этом прогоне нет ни одной записи;
 *  - conflicts: всегда [] (вход отфильтрован по домену — контракт).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planWallpaperImport,
  type ExistingProduct,
  type WallpaperPlan,
} from '../app/lib/wallpapers/import-plan.ts';
import type { WallpaperRow } from '../app/lib/wallpapers/parse.ts';

function wrow(over: Partial<WallpaperRow> & { code: string }): WallpaperRow {
  return {
    name: `Шпалери ${over.code}`,
    article: null,
    rollSize: null,
    priceRetail: 100,
    qty: 3,
    ...over,
  };
}

function prod(over: Partial<ExistingProduct> & { id: string; sku: string }): ExistingProduct {
  return { name: 'x', price: 100, stockQuantity: 5, isActive: false, ...over };
}

function emptyMap(entries: Array<[string, ExistingProduct]> = []): Map<string, ExistingProduct> {
  return new Map(entries);
}

/** Имитирует исполнение плана (Task 7): создаёт/обновляет/сводит missing в qty=0. */
function simulateApply(
  existing: Map<string, ExistingProduct>,
  rows: WallpaperRow[]
): Map<string, ExistingProduct> {
  const plan: WallpaperPlan = planWallpaperImport(existing, rows);
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
      isActive: false,
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
    });
  }
  const missingIds = new Set(plan.missing.map((m) => m.id));
  for (const [sku, p] of next) {
    if (missingIds.has(p.id)) next.set(sku, { ...p, stockQuantity: 0 });
  }
  return next;
}

test('PLAN: пустая БД → creates с sku wc-<article> / wc-x<code>, availability по qty', () => {
  const rows = [
    wrow({
      code: '9001',
      article: '6647-04',
      name: '6647-04 шпалери,53см*10м',
      priceRetail: 345.5,
      qty: 7,
    }),
    wrow({ code: '30202', article: null, priceRetail: 120, qty: 0 }),
  ];
  const plan = planWallpaperImport(emptyMap(), rows);

  assert.equal(plan.creates.length, 2);
  assert.deepEqual(plan.creates[0], {
    sku: 'wc-6647-04',
    slug: 'wc-6647-04',
    name: '6647-04 шпалери,53см*10м',
    price: 345.5,
    stockQuantity: 7,
    availability: 'in_stock',
    isActive: false,
  });
  assert.deepEqual(plan.creates[1], {
    sku: 'wc-x30202',
    slug: 'wc-x30202',
    name: 'Шпалери 30202',
    price: 120,
    stockQuantity: 0,
    availability: 'out_of_stock',
    isActive: false,
  });
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.noops, []);
  assert.deepEqual(plan.conflicts, []);
});

test('PLAN: sku-нормализация артикула — lowercase, пробелы вырезаются', () => {
  const plan = planWallpaperImport(emptyMap(), [
    wrow({ code: '1', article: 'SP 531-34' }),
    wrow({ code: '2', article: 'AB-12' }),
  ]);
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['wc-sp531-34', 'wc-ab-12']
  );
});

test('PLAN: дедуп по code — последняя строка побеждает, порядок по первому появлению', () => {
  const rows = [
    wrow({ code: 'A', article: null, name: 'первая A', priceRetail: 10, qty: 1 }),
    wrow({ code: 'B', article: null, name: 'B', priceRetail: 20, qty: 2 }),
    wrow({ code: 'A', article: null, name: 'последняя A', priceRetail: 30, qty: 4 }),
  ];
  const plan = planWallpaperImport(emptyMap(), rows);
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['wc-xA', 'wc-xB']
  );
  const a = plan.creates[0];
  assert.ok(a, 'create для A существует');
  assert.equal(a.name, 'последняя A');
  assert.equal(a.price, 30);
  assert.equal(a.stockQuantity, 4);
});

test('PLAN: diff-aware updates — только реально расходящиеся поля, имя не трогаем', () => {
  const existing = emptyMap([
    ['wc-p1', prod({ id: 'id-p1', sku: 'wc-p1', price: 100, stockQuantity: 5 })],
    ['wc-p2', prod({ id: 'id-p2', sku: 'wc-p2', price: 100, stockQuantity: 5 })],
    ['wc-p3', prod({ id: 'id-p3', sku: 'wc-p3', price: 100, stockQuantity: 5, name: 'Старое имя' })],
  ]);
  const rows = [
    wrow({ code: '1', article: 'p1', priceRetail: 120, qty: 5 }),
    wrow({ code: '2', article: 'p2', priceRetail: 100, qty: 0 }),
    wrow({ code: '3', article: 'p3', priceRetail: 120, qty: 0, name: 'Новое имя' }),
  ];
  const plan = planWallpaperImport(existing, rows);

  assert.deepEqual(plan.updates, [
    { id: 'id-p1', fields: { price: 120 } },
    { id: 'id-p2', fields: { stock_quantity: 0 } },
    { id: 'id-p3', fields: { price: 120, stock_quantity: 0 } },
  ]);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.noops, []);
});

test('PLAN: полное совпадение → sku в noops, никаких записей', () => {
  const existing = emptyMap([
    ['wc-ok1', prod({ id: 'id-ok1', sku: 'wc-ok1', price: 99.5, stockQuantity: 3 })],
  ]);
  const plan = planWallpaperImport(existing, [
    wrow({ code: '1', article: 'ok1', priceRetail: 99.5, qty: 3 }),
  ]);
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.noops, ['wc-ok1']);
  assert.deepEqual(plan.conflicts, []);
});

test('PLAN: исчезнувшие из файла → missing (qty>0); уже сведённые (qty=0) → noops', () => {
  const existing = emptyMap([
    ['wc-gone1', prod({ id: 'id-gone1', sku: 'wc-gone1', stockQuantity: 3 })],
    ['wc-gone2', prod({ id: 'id-gone2', sku: 'wc-gone2', stockQuantity: 0 })],
  ]);
  const plan = planWallpaperImport(existing, [wrow({ code: '1', article: 'alive' })]);
  assert.deepEqual(plan.missing, [{ id: 'id-gone1' }]);
  assert.ok(plan.noops.includes('wc-gone2'), 'сведённая строка — noop');
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['wc-alive']
  );
});

test('PLAN: идемпотентность — план поверх своей же применённой выдачи пуст', () => {
  const existing = emptyMap([
    ['wc-alive', prod({ id: 'id-alive', sku: 'wc-alive', price: 100, stockQuantity: 5 })],
    ['wc-gone', prod({ id: 'id-gone', sku: 'wc-gone', price: 50, stockQuantity: 2 })],
  ]);
  const rows = [
    wrow({ code: '1', article: 'alive', priceRetail: 120, qty: 5 }),
    wrow({ code: '2', article: 'fresh', priceRetail: 200, qty: 1 }),
  ];

  const applied = simulateApply(existing, rows);
  const plan2 = planWallpaperImport(applied, rows);

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

test('PLAN: slug/sku коллизия двух новых строк → суффикс -2', () => {
  const rows = [
    wrow({ code: '1001', article: '6647-04', name: 'первая' }),
    wrow({ code: '1002', article: '6647-04', name: 'вторая' }),
  ];
  const plan = planWallpaperImport(emptyMap(), rows);
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['wc-6647-04', 'wc-6647-04-2']
  );
  const slugs = plan.creates.map((c) => c.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'slug уникальны');
  for (const c of plan.creates) assert.equal(c.slug, c.sku, 'slug === sku');
});

test('PLAN: коллизия с существующим sku — первый матчается, второй создаётся с -2', () => {
  const existing = emptyMap([
    ['wc-6647-04', prod({ id: 'id-old', sku: 'wc-6647-04', price: 100, stockQuantity: 1 })],
  ]);
  const rows = [
    wrow({ code: '1001', article: '6647-04', priceRetail: 100, qty: 1 }),
    wrow({ code: '1002', article: '6647-04' }),
  ];  const plan = planWallpaperImport(existing, rows);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(
    plan.creates.map((c) => c.sku),
    ['wc-6647-04-2']
  );
  assert.deepEqual(plan.noops, ['wc-6647-04']);
});

test('PLAN: conflicts — всегда [] по контракту (вход отфильтрован по домену)', () => {
  const plan = planWallpaperImport(emptyMap(), [wrow({ code: '1' })]);
  assert.deepEqual(plan.conflicts, []);
});

test('PLAN: не-wc ключи в existing игнорируются полностью', () => {
  const existing = emptyMap([
    ['yc-123', prod({ id: 'id-yc', sku: 'yc-123' })],
    ['manual', prod({ id: 'id-manual', sku: 'manual' })],
  ]);
  const plan = planWallpaperImport(existing, [wrow({ code: '1', article: 'a1' })]);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.noops, []);
  assert.deepEqual(plan.updates, []);
});
