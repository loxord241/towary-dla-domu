/**
 * Лінолеум CONSOLIDATE — одноразовий мігратор scripts/linoleum-consolidate.ts
 * (рішення власника C2, 2026-09-18: одна карточка = дизайн, 34 старі картки
 * дизайн×ширина → 6 консолідованих карток з product_variants).
 *
 * Контракт під тестом:
 *  - Джерело — ІСНУЮЧІ ln-* товари (price = грн/пог.м, «Ширина» у specs,
 *    stock_quantity = метраж цієї ширини); кожна картка парситься в
 *    LinoleumRow і годує ТОЙ САМИЙ planLinoleumImport + applyPlan з
 *    scripts/linoleum-import.ts (реюз, не копія);
 *  - parse: sku `ln-x<code>-w<token>[-N]`, ім'я «{дизайн} {ширина} м»,
 *    priceSqm зі спецификації «Ціна за м²» (фолбэк price/width);
 *  - групування 34→6 через реальний планувальник: creates = 6, варіанти = 34,
 *    hide = всі старі АКТИВНІ (diff-aware), НІКОЛИ не DELETE і не stock-обнулення
 *    старих (їх зведе наступний звичайний --run через missing-шлях);
 *  - уже-консолідовані картки (sku без width-токена) — existing планувальника
 *    (ідемпотентний повторний запуск); некоректні — тільки звіт;
 *  - статичні піни: немає .delete(, hide через .update({is_active:false})
 *    батчами ≤200, --plan/--run взаємозапні, застосування через applyPlan.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRICE_SQM_SPEC_NAME,
  WIDTH_SPEC_NAME,
  formatWidthM,
  type ExistingProduct,
  type ExistingVariant,
} from '../app/lib/linoleum/import-plan.ts';
import { LINOLEUM_WIDTHS_M, type LinoleumWidthM } from '../app/lib/linoleum/parse.ts';
import { BATCH_SIZE, chunkRows } from '../scripts/linoleum-import.ts';
import {
  legacyRowFromProduct,
  parseArgs,
  parseLegacyCardName,
  parseLegacyCardSku,
  parseUkPriceValue,
  planConsolidation,
  planHideLegacy,
} from '../scripts/linoleum-consolidate.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'scripts/linoleum-consolidate.ts'), 'utf8');

// ---------------------------------------------------------------------------
// Static structure invariants (raw source, comments stripped)
// ---------------------------------------------------------------------------

const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('CONSOLIDATE: --plan/--run — два взаємозапні режими, сторонні опції → usage', () => {
  assert.deepEqual(parseArgs(['--plan']), { mode: 'plan' });
  assert.deepEqual(parseArgs(['--run']), { mode: 'run' });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['--plan', '--run']), null);
  assert.equal(parseArgs(['--publish']), null, 'публікація — НЕ Territory консолідації');
  assert.equal(parseArgs(['--plan', 'x']), null);
});

test('CONSOLIDATE: запис іде через РЕЮЗ applyPlan з linoleum-import (один шлях коду, не копія)', () => {
  assert.match(
    code,
    /import\s*\{[^}]*applyPlan[^}]*\}\s*from\s*'\.\/linoleum-import\.ts'/,
    'applyPlan імпортується, а не копіюється'
  );
  assert.match(code, /await applyPlan\(/);
  assert.equal((code.match(/await applyPlan\(/g) ?? []).length, 1);
});

test('CONSOLIDATE: СТАРІ КАРТКИ — hide-not-delete: .update({is_active:false}) диф-освідлено батчами ≤200, НІКОЛИ .delete(/stock-обнулення старих', () => {
  assert.doesNotMatch(code, /\.delete\(/);
  assert.doesNotMatch(code, /\.rpc\(/);
  assert.doesNotMatch(code, /\.upsert\(/);
  // hide: единственный literal is_active: false в файле — в hideLegacyProducts
  assert.match(code, /async function hideLegacyProducts/);
  assert.equal((code.match(/is_active: false/g) ?? []).length, 1);
  assert.doesNotMatch(code, /is_active: true/);
  const hideIdx = code.indexOf('.update({ is_active: false })');
  assert.ok(hideIdx !== -1);
  const site = code.slice(hideIdx, hideIdx + 200);
  assert.match(site, /\.in\('id'/, 'hide батчится по id (≤200)');
  assert.match(code, /chunkRows\(\[\.\.\.hideIds\], BATCH_SIZE\)/);
  // Стары сток консолідація НЕ зводить в 0 (це missing-шлях звичайного --run)
  assert.doesNotMatch(code, /stock_quantity: 0/);
});

// ---------------------------------------------------------------------------
// parseLegacyCardSku / parseLegacyCardName / parseUkPriceValue
// ---------------------------------------------------------------------------

test('PARSE sku: ln-x<code>-w<token> → {code, width}; суфікс -2; не-старі sku → null', () => {
  assert.deepEqual(parseLegacyCardSku('ln-x01160049-w15'), { code: '01160049', widthM: 1.5 });
  assert.deepEqual(parseLegacyCardSku('ln-x01160049-w40'), { code: '01160049', widthM: 4 });
  assert.deepEqual(parseLegacyCardSku('ln-xa1-w20-2'), { code: 'a1', widthM: 2 });
  // уже-консолідований sku (без width-токена) — НЕ старий
  assert.equal(parseLegacyCardSku('ln-x01160049'), null);
  assert.equal(parseLegacyCardSku('yc-123'), null);
  // невідомий токен ширини — мусор, не старий
  assert.equal(parseLegacyCardSku('ln-x1234-w17'), null);
});

test('PARSE name: «{дизайн} {ширина} м» → імʼя дизайну; без хвоста/порожній дизайн → null', () => {
  assert.equal(parseLegacyCardName('SUGAR OAK 997L Лінолеум SMARTEX 1,5 м', 1.5), 'SUGAR OAK 997L Лінолеум SMARTEX');
  assert.equal(parseLegacyCardName('Helsinki 582 2 м', 2), 'Helsinki 582');
  assert.equal(parseLegacyCardName('Helsinki 582 2,5 м', 2), null, 'хвост не той ширини');
  assert.equal(parseLegacyCardName('Helsinki 582', 2), null);
  assert.equal(parseLegacyCardName('2 м', 2), null, 'порожній дизайн');
});

test('PARSE price: uk-кома → число; некоректне → null', () => {
  assert.equal(parseUkPriceValue('350,50'), 350.5);
  assert.equal(parseUkPriceValue('410'), 410);
  assert.equal(parseUkPriceValue(' 99,95 '), 99.95);
  assert.equal(parseUkPriceValue('abc'), null);
  assert.equal(parseUkPriceValue('-1'), null);
});

// ---------------------------------------------------------------------------
// legacyRowFromProduct
// ---------------------------------------------------------------------------

function legacyCard(over: Partial<ExistingProduct> & { id: string; sku: string }): ExistingProduct {
  const widthM = over.sku.endsWith('-w35') ? 3.5 : 2;
  return {
    name: `Дизайн ${over.id} ${formatWidthM(widthM)} м`,
    price: 700,
    stockQuantity: 5,
    isActive: true,
    specifications: [
      { name: PRICE_SQM_SPEC_NAME, value: '350,00' },
      { name: WIDTH_SPEC_NAME, value: formatWidthM(widthM) },
    ],
    ...over,
  };
}

test('legacyRowFromProduct: повний парсинг — код/ширина зі sku, дизайн з імені, priceSqm зі спеки, qtyM зі стоку', () => {
  const result = legacyRowFromProduct(
    legacyCard({
      id: 'a',
      sku: 'ln-x01160049-w25',
      name: 'SUGAR OAK 997L Лінолеум SMARTEX 2,5 м',
      price: 876.25,
      stockQuantity: 40,
    })
  );
  if (!('row' in result)) throw new Error(`очікували row: ${'error' in result ? result.error : ''}`);
  assert.deepEqual(result.row, {
    code: '01160049',
    name: 'SUGAR OAK 997L Лінолеум SMARTEX',
    widthM: 2.5,
    priceSqm: 350,
    qtyM: 40,
  });
});

test('legacyRowFromProduct: немає «Ціна за м²» → фолбэк price/width; немає обох → помилка', () => {
  const fallback = legacyRowFromProduct(
    legacyCard({
      id: 'b',
      sku: 'ln-xl1-w20',
      specifications: [{ name: WIDTH_SPEC_NAME, value: '2' }],
      price: 700,
    })
  );
  if (!('row' in fallback)) throw new Error('очікували row (фолбэк)');
  assert.equal(fallback.row.priceSqm, 350);

  const broken = legacyRowFromProduct(
    legacyCard({
      id: 'c',
      sku: 'ln-xl1-w20',
      specifications: [],
      price: 0,
    })
  );
  if (!('error' in broken)) throw new Error('очікували error');
  assert.match(broken.error, /Ціна за м²/);
});

test('legacyRowFromProduct: консолідований sku → помилка (не старий), консолідація кладе його в existing', () => {
  const result = legacyRowFromProduct(legacyCard({ id: 'd', sku: 'ln-xl1' }));
  if (!('error' in result)) throw new Error('очікували error');
  assert.match(result.error, /дизайн×ширина/);
});

// ---------------------------------------------------------------------------
// planConsolidation: 34 → 6 через РЕАЛЬНИЙ планувальник + hide
// ---------------------------------------------------------------------------

/** 6 дизайнів (4 Beauflor + Helsinki 582 + 592), разом 34 старі картки. */
function buildLegacyProd(): ExistingProduct[] {
  const designs: Array<{ code: string; name: string; sqm: number; widths: LinoleumWidthM[] }> = [
    { code: '01160049', name: 'SUGAR OAK 997L Лінолеум BEAUFLOUR SMARTEX', sqm: 350.5, widths: [1.5, 2, 2.5, 3, 3.5, 4] },
    { code: '01160050', name: 'GREY OAK 997M Лінолеум BEAUFLOUR SMARTEX', sqm: 350.5, widths: [1.5, 2, 2.5, 3, 3.5, 4] },
    { code: '01160051', name: 'VINTAGE 997P Лінолеум BEAUFLOUR SMARTEX', sqm: 410, widths: [1.5, 2, 2.5, 3, 3.5, 4] },
    { code: '01160052', name: 'LOFT 997X Лінолеум BEAUFLOUR SMARTEX', sqm: 410, widths: [1.5, 2, 2.5, 3, 3.5, 4] },
    { code: 'ЛІН-582', name: 'Helsinki 582', sqm: 300, widths: [1.5, 2, 2.5, 3, 3.5] },
    { code: 'ЛІН-592', name: 'Helsinki 592', sqm: 300, widths: [2, 2.5, 3, 3.5, 4] },
  ];
  const products: ExistingProduct[] = [];
  let i = 0;
  for (const d of designs) {
    for (const w of d.widths) {
      i += 1;
      const sku = `ln-x${/^[a-z0-9-]+$/.test(d.code) ? d.code : (d.code.match(/\d+/g) ?? []).join('')}-w${Math.round(w * 10)}`;
      products.push({
        id: `old-${i}`,
        sku,
        name: `${d.name} ${formatWidthM(w)} м`,
        price: Math.round(d.sqm * w * 100) / 100,
        stockQuantity: 3 + i,
        isActive: i % 5 !== 0, // частина вже прихована
        specifications: [
          { name: PRICE_SQM_SPEC_NAME, value: `${d.sqm.toFixed(2).replace('.', ',')}` },
          { name: WIDTH_SPEC_NAME, value: formatWidthM(w) },
        ],
      });
    }
  }
  return products;
}

test('CONSOLIDATE: 34 старі картки → 6 дизайнів, 34 варіанти; MIN price, SUM qty, specs із ширинами', () => {
  const products = buildLegacyProd();
  assert.equal(products.length, 34);
  const consolidation = planConsolidation(products, new Map<string, ExistingVariant>());

  assert.equal(consolidation.legacy.size, 34);
  assert.equal(consolidation.invalid.length, 0);
  assert.equal(consolidation.consolidatedExisting.size, 0);
  assert.equal(consolidation.plan.creates.length, 6, '34 → 6 дизайнів');
  assert.equal(
    consolidation.plan.creates.reduce((s, c) => s + c.variants.length, 0),
    34,
    'кожна стара картка → варіант'
  );

  const sugar = consolidation.plan.creates.find((c) => c.sku === 'ln-x01160049');
  assert.ok(sugar, 'Beauflor 997L консолідована');
  assert.equal(sugar.name, 'SUGAR OAK 997L Лінолеум BEAUFLOUR SMARTEX', 'імʼя БЕЗ ширини');
  assert.equal(sugar.price, Math.round(350.5 * 1.5 * 100) / 100, 'MIN пог.м (1,5 м — найвужча)');
  assert.equal(sugar.stockQuantity, [4, 5, 6, 7, 8, 9].reduce((a, b) => a + b, 0), 'SUM метражів');
  assert.deepEqual(
    sugar.specifications.filter((s) => s.name === WIDTH_SPEC_NAME).map((s) => s.value),
    ['1,5', '2', '2,5', '3', '3,5', '4']
  );
  assert.deepEqual(
    sugar.variants.map((v) => v.sku),
    ['ln-x01160049-w15', 'ln-x01160049-w20', 'ln-x01160049-w25', 'ln-x01160049-w30', 'ln-x01160049-w35', 'ln-x01160049-w40']
  );
  assert.deepEqual(sugar.variants.map((v) => v.stockQuantity), [4, 5, 6, 7, 8, 9]);

  const helsinki = consolidation.plan.creates.find((c) => c.name === 'Helsinki 582');
  assert.ok(helsinki, 'кириличний код → digits-only sku');
  assert.equal(helsinki.sku, 'ln-x582');
});

test('CONSOLIDATE: hide — тільки АКТИВНІ старі (diff-aware), id зі legacy; приховані не чіпаються', () => {
  const products = buildLegacyProd();
  const consolidation = planConsolidation(products, new Map());
  const hideIds = planHideLegacy([...consolidation.legacy.values()]);
  const activeIds = products.filter((p) => p.isActive).map((p) => p.id);
  assert.deepEqual([...hideIds].sort(), [...activeIds].sort());
  // батчування ≤200
  assert.deepEqual(
    chunkRows(hideIds, BATCH_SIZE).map((g) => g.length),
    chunkRows(activeIds, BATCH_SIZE).map((g) => g.length)
  );
});

test('CONSOLIDATE: повторний запуск — уже-консолідовані стають existing, старі знову джерело (план diff-aware)', () => {
  const products = buildLegacyProd();
  const first = planConsolidation(products, new Map());
  // Имитация: applyPlan создал консолидированные продукты+варианты.
  const consolidated: ExistingProduct[] = first.plan.creates.map((c, i) => ({
    id: `new-${i}`,
    sku: c.sku,
    name: c.name,
    price: c.price,
    stockQuantity: c.stockQuantity,
    isActive: false,
    specifications: c.specifications,
  }));
  const variants = new Map<string, ExistingVariant>();
  for (const c of first.plan.creates) {
    for (const v of c.variants) {
      variants.set(v.sku, {
        id: `v-${v.sku}`,
        sku: v.sku,
        productId: `new-${first.plan.creates.findIndex((x) => x.sku === c.sku)}`,
        name: v.name,
        price: v.price,
        stockQuantity: v.stockQuantity,
      });
    }
  }
  const second = planConsolidation([...products, ...consolidated], variants);
  assert.equal(second.consolidatedExisting.size, 6, 'консолідовані — existing планувальника');
  assert.equal(second.plan.creates.length, 0, 'нових карток немає');
  assert.equal(second.plan.updates.length, 0, 'стан збігся — diff порожній');
  assert.equal(second.plan.variantCreates.length, 0);
  assert.equal(second.plan.variantUpdates.length, 0);
  assert.equal(second.plan.missingProducts.length, 0);
  assert.equal(second.plan.missingVariants.length, 0);
  assert.equal(second.invalid.length, 0);
  // старі знову у legacy → hide diff-aware: тільки раніше-активні
  // (консолідовані isActive: false — не в hide)
  assert.equal(planHideLegacy([...products, ...consolidated]).length,
    products.filter((p) => p.isActive).length);
});

test('CONSOLIDATE: некоректні картки — тільки звіт, у план і legacy не потрапляють', () => {
  const products = [
    ...buildLegacyProd(),
    legacyCard({ id: 'junk', sku: 'ln-x!!junk!!', name: 'мусор' }),
  ];
  const consolidation = planConsolidation(products, new Map());
  assert.equal(consolidation.legacy.size, 34);
  assert.equal(consolidation.consolidatedExisting.size, 0);
  assert.equal(consolidation.invalid.length, 1);
  assert.equal(consolidation.invalid[0]?.sku, 'ln-x!!junk!!');
  assert.equal(consolidation.plan.creates.length, 6);
});

test('CONSOLIDATE: повний цикл ширин LINOLEUM_WIDTHS_M парситься у варіанти (токен ×10)', () => {
  for (const w of LINOLEUM_WIDTHS_M) {
    const sku = `ln-xtest-w${Math.round(w * 10)}`;
    const parsed = parseLegacyCardSku(sku);
    assert.ok(parsed, `токен для ${w} парситься`);
    assert.equal(parsed?.widthM, w);
  }
});
