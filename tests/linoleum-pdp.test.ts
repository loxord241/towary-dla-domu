/**
 * Static invariants for the ln-* PDP purchase UX (linoleum vertical, batch 3,
 * task L6, owner plan 2026-09-17; width selection — task C3, owner plan
 * 2026-09-18). node:test cannot render React (.tsx), so the page integration
 * and the client panel are pinned by source inspection — the same convention
 * as roll-calculator.test.ts / pdp-specs-placement.test.ts. The pure math
 * behind the panel is unit-tested for real in tests/linoleum-product-view.test.ts.
 *
 * Contract under pin:
 *   - the gate is the ln- sku prefix from domains.ts (single source);
 *   - ln-* PDP replaces the unit AddToCartButton with LinoleumMeterPanel
 *     (whole metres 1..99 via the штатный integer cart path; since C3 the
 *     metres are added FOR THE SELECTED WIDTH: consolidated model — product
 *     = design, product_variants = widths, place_order takes the variantId
 *     and decrements variant stock at variant price);
 *   - width chips come from the is_active product_variants the page maps
 *     (label = «{name} м»), default selection = narrowest in-stock width;
 *   - the panel price is the SELECTED width's грн/пог.м (live on chip
 *     switch) with the «{Ціна за м²} грн/м²» spec as the caption;
 *   - the «Ціна за м²» specification renders as a грн/м² badge next to the
 *     page price (products.price on ln-* is грн за погонный метр) and as
 *     «від …» on cards (C2: the spec value is the design MIN across widths);
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
  // specifications ride in so the calculator knows the ROLL width; variants
  // ride in since C3 — the width chips (consolidated model 2026-09-18).
  assert.match(
    pageSrc,
    /\{isLinoleum \? \(\s*<LinoleumMeterPanel\s+productId=\{product\.id\}\s+price=\{product\.price\}\s+currency=\{product\.currency\}\s+stockQuantity=\{product\.stock_quantity\}\s+availabilityStatus=\{product\.availability_status\}\s+specifications=\{product\.specifications\}\s+variants=\{linoleumWidths\}\s*\/>\s*\) : \(\s*<AddToCartButton/,
    'ln-* рендерить панель метражу (зі специфікаціями та ширина-варіантами), інші домени — штатну кнопку'
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

test('linoleum-pdp: у панель прокидаються ШИРИНИ-варіанти (is_active) консолідованої моделі', () => {
  // C3 (owner plan 2026-09-18): продукт = дизайн, product_variants = ширини
  // (name = formatWidthM «1,5», price = грн/пог.м цієї ширини, stock = метри).
  assert.match(
    pageSrc,
    /const linoleumWidths = isLinoleum\s*\?\s*product\.variants\s*\.filter\(\(v\) => v\.is_active\)/,
    'чипи — тільки з is_active варіантів (RLS final_001 уже фільтрує; фільтр — defense-in-depth)'
  );
  assert.match(
    pageSrc,
    /name: v\.name,\s*price: v\.price,\s*stockQuantity: v\.stock_quantity,\s*availabilityStatus: v\.availability_status,/,
    'у чип ідуть name/price/stock/availability варіанта —Panel не читає сирий ProductVariant'
  );
  // Не-ln-* домени отримують порожній список — гейт не розповзається.
  assert.match(pageSrc, /: \[\]\s*$/m);
});

test('linoleum-pdp: бейдж «{ціна} грн/м²» біля ціни — зі специфікації «Ціна за м²»', () => {
  assert.match(
    pageSrc,
    // UPDATE L11 (2026-09-18): в імпорт додано mergeSpecEntries — пін матчить
    // список імен, а не точний вираз; інваріант («бейдж читає специфікацію
    // через pure-хелпер product-view») не змінено.
    /import \{[^}]*extractPricePerSqm[^}]*\} from '@\/app\/lib\/linoleum\/product-view'/,
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
  // Рішення оркестратора (доповнення C3, 2026-09-18): «від» — як на картках,
  // бо після консолідації спека несе ДИЗАЙН-МІНІМУМ (MIN по ширинах).
  assert.match(pageSrc, /від \{linoleumPriceSqm\} грн\/м²/);
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

test('linoleum-pdp: блок «Варіанти товару» НЕ рендериться для ln-* (його дублюють чипи панелі)', () => {
  // Рішення оркестратора (доповнення C3, 2026-09-18): універсальний нижній
  // блок «Варіанти товару» (ширина+ціна без кнопки покупки) дублює чипи
  // LinoleumMeterPanel — для ln-* його не рендеримо; іншим доменам блок
  // без змін (гейт !isLinoleum стоїть ПЕРЕД length-перевіркою).
  assert.match(
    pageSrc,
    /\{!isLinoleum && product\.variants\.length > 0 && \(/,
    'блок «Варіанти товару» загейчений від ln-*'
  );
});

test('linoleum-pdp: L11 — таблиця специфікацій бачить ЗЛИТУ «Ширина» (display-only), панель — сирі', () => {
  // Власник 2026-09-18: у блоці характеристик «Ширина» — ОДИН рядок
  // («1,5, 2, 2,5, 3, 3,5, 4»), а не шість. У БД записи лишаються
  // ПОЗАЇНДИВІДУАЛЬНО (фільтр ширин хаба — jsonb contains,
  // app/lib/catalog/linoleum-listing.ts; importer buildConsolidatedSpecifications)
  // — зливається ТІЛЬКИ відображення: pure mergeSpecEntries на сторінці
  // під гейтом isLinoleum, іншим доменам — сирі специфікації як були.
  assert.match(
    pageSrc,
    /import \{[^}]*mergeSpecEntries[^}]*\} from '@\/app\/lib\/linoleum\/product-view'/,
    'злиття — через pure-хелпер product-view (unit-тести), не інлайн'
  );
  assert.match(
    pageSrc,
    /const displaySpecifications = isLinoleum\s*\?\s*mergeSpecEntries\(product\.specifications\)\s*:\s*product\.specifications/,
    'один decision point: ln-* — злиті, інші домени — сирі'
  );
  // Усі ТРИ місця відображення специфікацій PDP (лід+«Основні характеристики»,
  // inline-таблиця у слоті «Опис», повноширинна таблиця нижче сітки):
  assert.equal(
    (pageSrc.match(/specifications=\{displaySpecifications\}/g) ?? []).length,
    3,
    'злиті специфікації — в усіх трьох місцях відображення (ProductIntro, inline, section)'
  );
  // LinoleumMeterPanel отримує СИРІ специфікації: це не відображення таблиці,
  // а функціональне читання — fallback extractWidthLabel мусить знайти першу
  // «1,5» (злитий рядок «1,5, 2, …» парсер ширини не зрозуміє).
  assert.match(
    pageSrc,
    /specifications=\{product\.specifications\}\s+variants=\{linoleumWidths\}/,
    'панель метражу — сирі специфікації (fallback ширини калькулятора)'
  );
});

// ---- LinoleumMeterPanel --------------------------------------------------------

test('linoleum-panel: client-острів на cart-context, addItem — variantId ОБРАНОЇ ширини (fallback null), цілі метри', () => {
  assert.ok(
    panelSrc.startsWith("'use client'"),
    'компонент має бути client ("use client" першим рядком)'
  );
  assert.match(
    panelSrc,
    /import \{ useCart, MAX_ITEM_QUANTITY, MAX_CART_LINES \} from '@\/app\/lib\/cart-context'/,
    'додавання йде через наявний cart-context'
  );
  // C3: метри додаються для вибраної ширини (place_order декрементить сток
  // варіанта за ціною варіанта); 0 варіантів → чесний fallback variantId=null
  // (попередня поведінка, ціна/сток продукту).
  assert.match(
    panelSrc,
    /addItem\(productId, selectedVariant \? selectedVariant\.id : null, qty\)/,
    'у кошик іде variantId вибраної ширини, без ширин — null'
  );
  assert.match(
    panelSrc,
    /Number\.isInteger\(n\) \? n : 1/,
    'штатний integer-шлях: дробний вхід не приймається'
  );
  assert.match(
    panelSrc,
    /Math\.min\(effectiveStock \|\| MAX_ITEM_QUANTITY, MAX_ITEM_QUANTITY\)/,
    'метраж обмежений залишком ОБРАНОЇ ширини (метри) і максимумом позиції кошика (99)'
  );
});

test('linoleum-panel: чіпи ширин — «{name} м», дефолт «найвужчий в наявності», вибір кліком', () => {
  assert.match(
    panelSrc,
    /export interface LinoleumWidthOption \{/,
    'чип — це продукт_variants рядок консолідованої моделі (окремий тип)'
  );
  assert.match(
    panelSrc,
    /variants\?: LinoleumWidthOption\[\];/,
    'варіанти — опційний проп: 0 варіантів = чесний single-width fallback'
  );
  assert.match(
    panelSrc,
    /\{option\.name\} м\{soldOut \? ' · немає' : ''\}/,
    'лейбл чіпа = formatWidthM-імʼя варіанта + « м»; вичерпана ширина позначається'
  );
  assert.match(
    panelSrc,
    /aria-checked=\{selected\}/,
    'чипи — радіогрупа з доступним станом (a11y, як select у AddToCartButton)'
  );
  assert.match(
    panelSrc,
    /const selectedWidthId = pickedWidthId \?\? defaultWidthId;/,
    'вибір тримається в стані, до першого кліку — дефолт'
  );
  assert.match(
    panelSrc,
    /const firstAvailable = sorted\.find\(/,
    'дефолт = перший В НАЯВНОСТІ чіп (план C3: «перший in-stock або найвужчий»)'
  );
  assert.match(
    panelSrc,
    /o\.stockQuantity > 0 && o\.availabilityStatus !== 'out_of_stock'/,
    '«в наявності» = метри > 0 і не out_of_stock'
  );
  assert.match(
    panelSrc,
    /return wa - wb;/,
    'чипи сортовані за числовою шириною (uk-кома «1,5»), найвужчі перші — «перший» і «найвужчий» збігаються'
  );
  assert.match(
    panelSrc,
    /setMeters\(\(m\) => \(Number\.isInteger\(m\) \? Math\.max\(1, Math\.min\(m, optionMax\)\) : 1\)\)/,
    'при зміні ширини метраж піджимається під залишок нової ширини'
  );
});

test('linoleum-panel: ціна вибраної ширини жива — «{unitPrice}/пог.м» + підпис «{price_sqm} грн/м²», итог від variant price', () => {
  assert.match(
    panelSrc,
    /const effectivePrice = selectedVariant \? selectedVariant\.price : price;/,
    'ціна за пог.м = ціна ВИБРАНОЇ ширини (fallback — ціна продукту)'
  );
  assert.match(
    panelSrc,
    /\{unitPrice\}\/пог\.м/,
    'заголовок ціни: «{variant.price} грн/пог.м» за обрану ширину'
  );
  assert.match(
    panelSrc,
    /const priceSqm = extractPricePerSqm\(specifications\);/,
    'підпис читає «Ціна за м²» через pure-хелпер'
  );
  assert.match(
    panelSrc,
    /\{priceSqm\} грн\/м²/,
    'підпис «{price_sqm} грн/м²» під заголовком (план C3)'
  );
  assert.match(
    panelSrc,
    /\{meters\} м × \{unitPrice\} = \{formatPrice\(meters \* effectivePrice, currency\)\}/,
    'живий итог «{qty} м × {price ширини} = {итого} грн»'
  );
  assert.match(
    panelSrc,
    /import \{ formatPrice \} from '@\/app\/lib\/format'/,
    'ціни — тільки через форматер (єдиний presentation-пункт)'
  );
});

test('linoleum-panel: вичерпана ширина — пряме повідомлення, кнопки покупки немає', () => {
  // REGRESSION-guard C3: користувач може клікнути на вичерпаний чіп —
  // панель не повинна «додавати в кошик» неіснуючі метри (place_order
  // все одно відхилить, але чесний UX — попередити до кошика).
  assert.match(
    panelSrc,
    /const widthUnavailable =/,
    'вичерпаність ВИБРАНОЇ ширини — окремий стан (продукт може мати інші ширини)'
  );
  assert.match(
    panelSrc,
    /Цієї ширини немає в наявності/,
    'повідомлення при исчерпании стока ширини (план C3)'
  );
});

test('linoleum-panel: метраж — лейбл, максимум від залишку, живий итог', () => {
  assert.match(panelSrc, /Метраж \(м\):/, 'лейбл кількості — метраж');
  assert.match(
    panelSrc,
    /макс\. \{maxMeters\} м/,
    'підсказка максимуму — залишок обраної ширини'
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
  assert.match(
    panelSrc,
    /Немає в наявності/,
    'out_of_stock продукту (усі ширини) рендерить вимкнену кнопку (як AddToCartButton)'
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

test('linoleum-panel: калькулятор ділить на ШИРИНУ ОБРАНОГО ВАРІАНТА, fallback — специфікація «Ширина»', () => {
  // Баг-фікс 2026-09-17: калькулятор ділить на реальну ширину рулону. З C3
  // ширин кілька: джерело — name ВИБРАНОГО варіанта (formatWidthM-канон,
  // той самий що й у спеки), fallback (0 варіантів) — перша «Ширина» спеки.
  assert.match(
    panelSrc,
    /import \{[\s\S]*extractWidthLabel,[\s\S]*\} from '@\/app\/lib\/linoleum\/product-view'/,
    'fallback ширини читається специфікацією через pure-хелпер'
  );
  assert.match(
    panelSrc,
    /if \(selectedVariant\) return parsePositive\(selectedVariant\.name\);/,
    'ширину рулону беремо з обраного варіанта (не з першої спеки — їх тепер кілька)'
  );
  assert.match(
    panelSrc,
    /widthM: rollWidthM/,
    'у calcLinoleumMeters передається реальна ширина рулону'
  );
  assert.match(
    panelSrc,
    /if \(lengthM === null \|\| widthM === null \|\| rollWidthM === null\) return null;/,
    'без реальної ширини рулону калькулятор не дає рекомендації (не вигадує число)'
  );
  // Результат у форматі ревʼю: «{S} м² → {n} пог. м (рулон {width} м)».
  assert.match(panelSrc, /м² → \{calc\.meters\} пог\. м/);
  assert.match(panelSrc, /\(рулон \{widthLabel\} м\)/);
  // P0.1 (2026-09-18): попередження про стикування смуг, коли рулон вужчий за обидві сторони
  assert.match(panelSrc, /calc\.requiresSeam === true/);
  assert.match(
    panelSrc,
    /Ширина рулону менша за обидві сторони кімнати — знадобиться стикування смуг\./
  );
});

// ---- ProductCard ---------------------------------------------------------------

test('product-card: ln-* картки показують «від {ціна} грн/м²» замість ціни за пог.м', () => {
  assert.match(
    cardSrc,
    /import \{ isLinoleumSlug \} from '@\/app\/lib\/domains'/,
    'гейт домену — з domains.ts'
  );
  assert.match(
    cardSrc,
    /const isLinoleum = isLinoleumSlug\(product\.slug\)/,
    'гейт обчислюється один раз (ціна грн/м² І кнопка)'
  );
  assert.match(
    cardSrc,
    /import \{ extractPricePerSqm \} from '@\/app\/lib\/linoleum\/product-view'/,
    'читання специфікації — через pure-хелпер'
  );
  assert.match(
    cardSrc,
    /const priceSqm = isLinoleum\s*\?\s*extractPricePerSqm\(product\.specifications\)\s*:\s*null/,
    'грн/м² тільки для ln-* і тільки з реальної специфікації'
  );
  // The m² branch must come FIRST (replaces the running-meter price), and
  // the card data carries the optional specifications field. C3: «від» —
  // після консолідації специфікація несе ДИЗАЙН-МІНІМУМ (одна «Ціна за м²»
  // = MIN по ширинах, C2), тож це стартова ціна дизайну, не фінальна.
  assert.match(
    cardSrc,
    /\{priceSqm \? \([\s\S]*?від \{priceSqm\} грн\/м²[\s\S]*?\) : hasDiscount \? \(/,
    '«від {MIN} грн/м²» — головна ціна ln-картки, інші домени без змін'
  );
  // P1.3 (2026-09-18): якщо немає priceSqm (напр. в обраному без спек) — показувати /пог. м
  assert.match(
    cardSrc,
    /\{isLinoleum \? '\/пог\. м' : ''\}/,
    'фолбек-одиниця виміру для ln-* без priceSqm — /пог. м'
  );
  assert.match(
    cardSrc,
    /specifications\?: \{ name: string; value: string \}\[\] \| null;/,
    'ProductCardData несе опціональну specifications'
  );
});

test('product-card: у ln-* карток НЕМАЄ «У кошик» — Link «Обрати метраж» на PDP', () => {
  // REGRESSION (ревʼю власника 2026-09-17): картка показує 500 грн/м², а
  // «У кошик» додавав 1 ПОГОННИЙ метр (напр. 1250 грн) — покупець бачив
  // одну ціну, а кошик отримував іншу. ln-* з сітки веде на PDP, де
  // рахується метраж і обирається ширина; не-ln-* домени не змінені.
  assert.match(
    cardSrc,
    /\{isLinoleum \? \(\s*<Link\s+href=\{`\/product\/\$\{product\.slug\}`\}[\s\S]*?Обрати метраж[\s\S]*?\) : \(\s*<CardAddToCartButton/,
    'ln-* — лінк «Обрати метраж» на PDP, інші домени — штатну кнопку'
  );
  assert.match(cardSrc, /Обрати метраж/);
  assert.equal(
    (cardSrc.match(/<CardAddToCartButton/g) ?? []).length,
    1,
    'add-to-cart з сітки лишається тільки не-ln-*'
  );
});

// ---- Breadcrumbs (P2.2 domain duplicate elimination) ---------------------------

test('linoleum-pdp: хлібні крихти не дублюють назву доменної категорії на PDP (P2.2)', () => {
  // REGRESSION (P2.2, 2026-09-18): друга крихта стає «Лінолеум» (/linoleum)
  // для ln-* або «Шпалери» (/oboi) для wc-*. Усередині trailCategories.map
  // корінь 'linoleum' чи 'shpaleri' дублював би назву:
  // «Головна / Лінолеум / Лінолеум / ...» або «Головна / Шпалери / Шпалери / ...».
  // Фільтрація повертає null для дубльованого доменного кореня без мутації trailCategories.

  // 1. Статичний пін сирця: умова пропуску дублікатів присутня в trailCategories.map
  assert.match(
    pageSrc,
    /\(isLinoleum\s*&&\s*cat\.slug\s*===\s*'linoleum'\)\s*\|\|\s*\(isWallpaper\s*&&\s*cat\.slug\s*===\s*'shpaleri'\)/,
    'фільтр дублікатів кореневих категорій присутній у хлібних крихтах'
  );
  assert.match(
    pageSrc,
    /if\s*\(\s*\(isLinoleum\s*&&\s*cat\.slug\s*===\s*'linoleum'\)\s*\|\|\s*\(isWallpaper\s*&&\s*cat\.slug\s*===\s*'shpaleri'\)\s*\)\s*\{\s*return null\s*\}/,
    'дублююча доменна категорія повертає null у JSX-мапі'
  );

  // 2. Інваріанти: trailCategories.map залишається рівно 2 рази (крихти + характеристики)
  assert.equal(
    (pageSrc.match(/trailCategories\.map/g) ?? []).length,
    2,
    'trailCategories.map рівно у двох місцях (крихти і блок характеристик)'
  );
  assert.equal(
    (pageSrc.match(/\/catalog\/\$\{encodeURIComponent\(cat\.slug\)\}/g) ?? []).length,
    2,
    'шляхові посилання збережені в обох місцях'
  );

  // 3. Імітація логіки рендерингу ланцюжка хлібних крихт:
  type BreadcrumbCat = { slug: string; name: string };
  function renderBreadcrumbs(
    isLinoleum: boolean,
    isWallpaper: boolean,
    trail: BreadcrumbCat[],
    productName: string
  ): string[] {
    const root2 = isLinoleum ? 'Лінолеум' : isWallpaper ? 'Шпалери' : 'Каталог';
    const crumbs = ['Головна', root2];
    for (const cat of trail) {
      if (
        (isLinoleum && cat.slug === 'linoleum') ||
        (isWallpaper && cat.slug === 'shpaleri')
      ) {
        continue;
      }
      crumbs.push(cat.name);
    }
    crumbs.push(productName);
    return crumbs;
  }

  // Лінолеум: коренева категорія 'linoleum' не дублюється
  assert.deepEqual(
    renderBreadcrumbs(true, false, [{ slug: 'linoleum', name: 'Лінолеум' }], 'Таркетт'),
    ['Головна', 'Лінолеум', 'Таркетт'],
    'лінолеум: «Головна / Лінолеум / <товар>» без другого «Лінолеум»'
  );

  // Лінолеум з підкатегорією: підкатегорія рендериться після Лінолеум
  assert.deepEqual(
    renderBreadcrumbs(
      true,
      false,
      [
        { slug: 'linoleum', name: 'Лінолеум' },
        { slug: 'napivkomertsiinyi', name: 'Напівкомерційний' },
      ],
      'Таркетт'
    ),
    ['Головна', 'Лінолеум', 'Напівкомерційний', 'Таркетт'],
    'лінолеум: підкатегорія зберігається в ланцюжку'
  );

  // Шпалери: коренева категорія 'shpaleri' не дублюється
  assert.deepEqual(
    renderBreadcrumbs(
      false,
      true,
      [
        { slug: 'shpaleri', name: 'Шпалери' },
        { slug: 'vinilovi', name: 'Вінілові' },
      ],
      'Шпалери 10м'
    ),
    ['Головна', 'Шпалери', 'Вінілові', 'Шпалери 10м'],
    'шпалери: «Головна / Шпалери / Вінілові / <товар>» без другого «Шпалери»'
  );

  // Каталог (побутова техніка): звичайний ланцюжок не змінюється
  assert.deepEqual(
    renderBreadcrumbs(
      false,
      false,
      [
        { slug: 'tekhnika', name: 'Побутова техніка' },
        { slug: 'kholodylnyky', name: 'Холодильники' },
      ],
      'Холодильник Samsung'
    ),
    ['Головна', 'Каталог', 'Побутова техніка', 'Холодильники', 'Холодильник Samsung'],
    'каталог: повний ланцюжок зберігається'
  );
});

