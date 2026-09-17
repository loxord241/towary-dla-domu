/**
 * Static invariants for the ln-* PDP purchase UX (linoleum vertical,
 * batch 3, task L6, owner plan 2026-09-17). node:test cannot render React
 * (.tsx), so the page integration and the client panel are pinned by source
 * inspection — the same convention as roll-calculator.test.ts /
 * pdp-specs-placement.test.ts. The pure math behind the panel is unit-tested
 * for real in tests/linoleum-product-view.test.ts.
 *
 * Contract under pin:
 *   - the gate is the ln- sku prefix from domains.ts (single source);
 *   - ln-* PDP replaces the unit AddToCartButton with LinoleumMeterPanel
 *     (whole metres 1..99 via the штатный integer cart path, variantId=null);
 *   - the «Ціна за м²» specification renders as a грн/м² badge next to the
 *     price (products.price on ln-* is грн за погонный метр);
 *   - wallpaper-specific blocks (roll calculator, glue cross-sell) stay
 *     gated off ln-* PDPs.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageSrc = readFileSync(
  path.join(root, 'app/product/[slug]/page.tsx'),
  'utf8'
);
const panelSrc = readFileSync(
  path.join(root, 'app/components/LinoleumMeterPanel.tsx'),
  'utf8'
);
const cardSrc = readFileSync(
  path.join(root, 'app/components/ProductCard.tsx'),
  'utf8'
);

// ---- PDP integration ----------------------------------------------------------

test('linoleum-pdp: гейт isLinoleum — префікс ln- з domains.ts (єдине джерело)', () => {
  assert.match(
    pageSrc,
    /import \{ LINOLEUM_SKU_PREFIX \} from '@\/app\/lib\/domains'/,
    'префікс імпортується з domains.ts, не дублікується літералом'
  );
  assert.match(
    pageSrc,
    /const isLinoleum = product\.sku\.startsWith\(LINOLEUM_SKU_PREFIX\)/,
    'гейт — sku починається на ln-'
  );
});

test('linoleum-pdp: buy-box для ln-* — LinoleumMeterPanel замість AddToCartButton', () => {
  assert.match(
    pageSrc,
    /import LinoleumMeterPanel from '@\/app\/components\/LinoleumMeterPanel'/,
    'PDP імпортує панель метражу'
  );
  // The conditional must REPLACE the unit button for ln-* (not stack both):
  // one buy-box per page, the owner 2026-09-15 placement (under the price).
  assert.match(
    pageSrc,
    /\{isLinoleum \? \(\s*<LinoleumMeterPanel\s+productId=\{product\.id\}\s+price=\{product\.price\}\s+currency=\{product\.currency\}\s+stockQuantity=\{product\.stock_quantity\}\s+availabilityStatus=\{product\.availability_status\}\s*\/>\s*\) : \(\s*<AddToCartButton/,
    'ln-* рендерить панель метражу, інші домени — штатну кнопку'
  );
  assert.equal(
    (pageSrc.match(/<AddToCartButton/g) ?? []).length,
    1,
    'штатний buy-box лишається рівно в одному місці (гілка не-ln-*)'
  );
  assert.equal(
    (pageSrc.match(/<LinoleumMeterPanel/g) ?? []).length,
    1,
    'панель метражу монтується рівно в одному місці сторінки'
  );
});

test('linoleum-pdp: бейдж «{ціна} грн/м²» біля ціни — зі специфікації «Ціна за м²»', () => {
  assert.match(
    pageSrc,
    /import \{ extractPricePerSqm \} from '@\/app\/lib\/linoleum\/product-view'/,
    'читання специфікації — через pure-хелпер product-view'
  );
  assert.match(
    pageSrc,
    /const linoleumPriceSqm = isLinoleum\s*\?\s*extractPricePerSqm\(product\.specifications\)\s*:\s*null/,
    'бейдж обчислюється лише для ln-*; іншим доменам — null'
  );
  assert.match(
    pageSrc,
    /\{linoleumPriceSqm && \(/,
    'бейдж умовний (без вигаданих чисел, коли специфікації немає)'
  );
  assert.match(pageSrc, /\{linoleumPriceSqm\} грн\/м²/);
});

test('linoleum-pdp: шпалерні блоки не тікають на ln-* (roll calculator, клей)', () => {
  // RollCalculator keeps its single wallpaper-gated mount (the full shape is
  // pinned by roll-calculator.test.ts; here we pin the ln-* coexistence).
  assert.match(
    pageSrc,
    /\{isWallpaper && \(\s*<RollCalculator/,
    'roll calculator — тільки для wc-*'
  );
  assert.equal(
    (pageSrc.match(/<RollCalculator/g) ?? []).length,
    1,
    'шпалерний калькулятор не дублюється'
  );
  assert.match(
    pageSrc,
    /\{isWallpaper && <GlueCrossSell products=\{glueProducts\} \/>\}/,
    'клейова полиця — тільки для wc-*'
  );
  // The wallpaper roll-size parse stays wallpaper-gated (no ln- input).
  assert.match(
    pageSrc,
    /const rollSize = isWallpaper \? parseRollSize\(product\.name\) : null/
  );
});

// ---- LinoleumMeterPanel --------------------------------------------------------

test('linoleum-panel: client-острів на cart-context, variantId=null, цілі метри', () => {
  assert.ok(
    panelSrc.startsWith("'use client'"),
    'компонент має бути client ("use client" першим рядком)'
  );
  assert.match(
    panelSrc,
    /import \{ useCart, MAX_ITEM_QUANTITY, MAX_CART_LINES \} from '@\/app\/lib\/cart-context'/,
    'додавання йде через наявний cart-context'
  );
  assert.match(
    panelSrc,
    /addItem\(productId, null, qty\)/,
    'у кошик додається метраж без варіанта (variantId=null)'
  );
  assert.match(
    panelSrc,
    /Number\.isInteger\(n\) \? n : 1/,
    'штатний integer-шлях: дробний вхід не приймається'
  );
  assert.match(
    panelSrc,
    /Math\.min\(stockQuantity \|\| MAX_ITEM_QUANTITY, MAX_ITEM_QUANTITY\)/,
    'метраж обмежений залишком (метри) і максимумом позиції кошика (99)'
  );
});

test('linoleum-panel: метраж — лейбл, підсказка ціни за пог.м, живий итог', () => {
  assert.match(panelSrc, /Метраж \(м\):/, 'лейбл кількості — метраж');
  assert.match(
    panelSrc,
    /ціна: \{unitPrice\}\/пог\.м/,
    'підсказка «ціна: X грн/пог.м» (formatPrice дає «X грн»)'
  );
  assert.match(
    panelSrc,
    /\{meters\} м × \{unitPrice\} = \{formatPrice\(meters \* price, currency\)\}/,
    'живий итог «{qty} м × {price} = {итого} грн»'
  );
  assert.match(
    panelSrc,
    /import \{ formatPrice \} from '@\/app\/lib\/format'/,
    'ціни — тільки через форматер (єдиний presentation-пункт)'
  );
});

test('linoleum-panel: калькулятор кімнати → «Підставити в метраж», математика з product-view', () => {
  assert.match(
    panelSrc,
    /import \{[\s\S]*calcLinoleumMeters,[\s\S]*\} from '@\/app\/lib\/linoleum\/product-view'/,
    'метраж рахує pure-модуль product-view (unit-тести), не інлайн'
  );
  assert.match(panelSrc, /Довжина кімнати, м/);
  assert.match(panelSrc, /Ширина кімнати, м/);
  assert.match(panelSrc, /Підставити в метраж/);
  assert.match(panelSrc, /Розраховано:/);
  // Room inputs are decimal (кома-дружні), the metres input stays integer.
  assert.equal(
    (panelSrc.match(/inputMode="decimal"/g) ?? []).length,
    2,
    'два десяткові поля кімнати (довжина і ширина)'
  );
});

test('linoleum-panel: неможливий/порожній вхід — без рекомендації; out_of_stock — вимкнена кнопка', () => {
  assert.match(
    panelSrc,
    /if \(lengthM === null \|\| widthM === null\) return null;/,
    'неповний вхід не дає «розрахованого» метражу'
  );
  assert.match(
    panelSrc,
    /Немає в наявності/,
    'out_of_stock рендерить вимкнену кнопку (як AddToCartButton)'
  );
  assert.match(
    panelSrc,
    /added-in motion-reduce:animate-none/,
    'поява результату анімується з вимкненням при reduced motion'
  );
  assert.match(
    panelSrc,
    /motion-reduce:transition-none/,
    'переходи вимикаються при reduced motion'
  );
});

// ---- ProductCard ---------------------------------------------------------------

test('product-card: ln-* картки показують {ціна} грн/м² замість ціни за пог.м', () => {
  assert.match(
    cardSrc,
    /import \{ isLinoleumSlug \} from '@\/app\/lib\/domains'/,
    'гейт домену — з domains.ts'
  );
  assert.match(
    cardSrc,
    /import \{ extractPricePerSqm \} from '@\/app\/lib\/linoleum\/product-view'/,
    'читання специфікації — через pure-хелпер'
  );
  assert.match(
    cardSrc,
    /const priceSqm = isLinoleumSlug\(product\.slug\)\s*\?\s*extractPricePerSqm\(product\.specifications\)\s*:\s*null/,
    'грн/м² тільки для ln-* і тільки з реальної специфікації'
  );
  // The m² branch must come FIRST (replaces the running-meter price), and
  // the card data carries the optional specifications field.
  assert.match(
    cardSrc,
    /\{priceSqm \? \([\s\S]*?\{priceSqm\} грн\/м²[\s\S]*?\) : hasDiscount \? \(/,
    'грн/м² — головна ціна ln-картки, інші домени без змін'
  );
  assert.match(
    cardSrc,
    /specifications\?: \{ name: string; value: string \}\[\] \| null;/,
    'ProductCardData несе опціональну specifications'
  );
});
