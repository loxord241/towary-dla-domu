/**
 * Pure view-layer helpers for ln-* products (linoleum vertical, batch 3,
 * task L6, 2026-09-17). Unit tests for app/lib/linoleum/product-view.ts —
 * a pure module (no React/Next/DB) mirroring the roll-math convention:
 *
 *   - extractPricePerSqm / extractWidthLabel read the specification entries
 *     written by the batch-2 importer (import-plan.ts buildSpecifications:
 *     «Ціна за м²» = formatPriceSqmValue canon «410,00», «Ширина» =
 *     formatWidthM canon «1,5»);
 *   - calcLinoleumMeters: room area + default +10 % waste DIVIDED BY the
 *     roll width (widthM is REQUIRED, strictly one of LINOLEUM_WIDTHS_M
 *     from parse.ts), ceil to WHOLE running metres (the purchase path sells
 *     integer metres 1–99, owner plan 2026-09-17). Regression 2026-09-17
 *     (owner review): the pre-fix version returned the room area WITH waste
 *     as «пог. м» and ignored the roll width — a 22 м² room on a 2,5 м roll
 *     showed 22 instead of 9 running metres. Integer-centimetre arithmetic
 *     like roll-math.ts: IEEE-754 binary fractions make ceil treacherous
 *     near integers, so the area is computed in cm² before the waste factor
 *     is applied.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (await import(
  pathToFileURL(path.join(root, 'app/lib/linoleum/product-view.ts')).href
)) as typeof import('../app/lib/linoleum/product-view.ts');

const src = readFileSync(
  path.join(root, 'app/lib/linoleum/product-view.ts'),
  'utf8'
);

// ---- extractors ---------------------------------------------------------------

test('extractPricePerSqm: читає «Ціна за м²» з specifications (канон імпортера)', () => {
  assert.equal(
    mod.extractPricePerSqm([
      { name: 'Ціна за м²', value: '410,00' },
      { name: 'Ширина', value: '1,5' },
    ]),
    '410,00'
  );
  // Реальний порядок create-пейлоада: [Ціна за м², Ширина] — але зчитування
  // не має залежати від позиції (адмін може додати записи до/після).
  assert.equal(
    mod.extractPricePerSqm([
      { name: 'Клас зносостійкості', value: '32' },
      { name: 'Ціна за м²', value: '350,50' },
    ]),
    '350,50'
  );
});

test('extractPricePerSqm: немає запису / порожньо / null → null', () => {
  assert.equal(mod.extractPricePerSqm([{ name: 'Ширина', value: '2,5' }]), null);
  assert.equal(mod.extractPricePerSqm([]), null);
  assert.equal(mod.extractPricePerSqm(null), null);
  assert.equal(mod.extractPricePerSqm(undefined), null);
});

test('extractWidthLabel: читає «Ширина» (uk-формат formatWidthM)', () => {
  assert.equal(
    mod.extractWidthLabel([
      { name: 'Ціна за м²', value: '410,00' },
      { name: 'Ширина', value: '1,5' },
    ]),
    '1,5'
  );
  assert.equal(
    mod.extractWidthLabel([{ name: 'Ширина', value: '3' }]),
    '3'
  );
  assert.equal(mod.extractWidthLabel(null), null);
  assert.equal(mod.extractWidthLabel([]), null);
});

// ---- spec display merge (L11, display-вимога власника 2026-09-18) --------------

test('mergeSpecEntries: кілька «Ширина» → ОДИН рядок «1,5, 2, 2,5, 3, 3,5, 4» на позиції першого входження', () => {
  // Реальний payload імпортера (import-plan buildConsolidatedSpecifications):
  // «Ціна за м²» + по запису «Ширина» на кожну ширину сітки. У БД записи
  // лишаються ПОЗАЇНДИВІДУАЛЬНО (фільтр ширин хаба — jsonb contains,
  // linoleum-listing.ts) — зливається ТІЛЬКИ відображення.
  const merged = mod.mergeSpecEntries([
    { name: 'Ціна за м²', value: '410,00' },
    { name: 'Ширина', value: '1,5' },
    { name: 'Ширина', value: '2' },
    { name: 'Ширина', value: '2,5' },
    { name: 'Ширина', value: '3' },
    { name: 'Ширина', value: '3,5' },
    { name: 'Ширина', value: '4' },
  ]);
  assert.deepEqual(merged, [
    { name: 'Ціна за м²', value: '410,00' },
    { name: 'Ширина', value: '1,5, 2, 2,5, 3, 3,5, 4' },
  ]);
});

test('mergeSpecEntries: порядок значень — вихідний масив, не сортування (ні лексичне, ні числове)', () => {
  assert.deepEqual(
    mod.mergeSpecEntries([
      { name: 'Ширина', value: '4' },
      { name: 'Ширина', value: '1,5' },
    ]),
    [{ name: 'Ширина', value: '4, 1,5' }]
  );
});

test('mergeSpecEntries: 0 і 1 «Ширина» — тотожність (решта записів не чіпається)', () => {
  const noWidth = [
    { name: 'Ціна за м²', value: '410,00' },
    { name: 'Клас зносостійкості', value: '32' },
  ];
  assert.deepEqual(mod.mergeSpecEntries(noWidth), noWidth);
  const oneWidth = [{ name: 'Ширина', value: '2,5' }];
  assert.deepEqual(mod.mergeSpecEntries(oneWidth), oneWidth);
});

test('mergeSpecEntries: дублікати ІНШИХ назв лишаються окремими рядками (інваріант побутівки)', () => {
  const rows = [
    { name: 'Колір', value: 'червоний' },
    { name: 'Колір', value: 'синій' },
    { name: 'Ширина', value: '2' },
    { name: 'Матеріал', value: 'ПВХ' },
    { name: 'Матеріал', value: 'на повсті' },
  ];
  assert.deepEqual(mod.mergeSpecEntries(rows), rows);
});

test('mergeSpecEntries: null / undefined / [] / не-масив → [] (блок сховається у рендері)', () => {
  assert.deepEqual(mod.mergeSpecEntries(null), []);
  assert.deepEqual(mod.mergeSpecEntries(undefined), []);
  assert.deepEqual(mod.mergeSpecEntries([]), []);
  assert.deepEqual(
    mod.mergeSpecEntries('nope' as unknown as readonly { name: string; value: string }[]),
    []
  );
});

// ---- meter math ---------------------------------------------------------------
// GEOMETRIC CALCULATION (P0.1 2026-09-18): лінолеум продається прямокутним
// шматком W_roll × M пог. м.
// 1. Рулон ширший за обидві сторони: відріз за меншою стороною, без швів.
// 2. Рулон ширший за одну сторону: відріз за іншою стороною, без швів.
// 3. Рулон вужчий за обидві сторони: requiresSeam: true, мінімум метражу
//    серед орієнтацій смуг уздовж довжини та уздовж ширини.

test('calcLinoleumMeters: P0.1 регресія — 2.5×2.5, ширина 4, +10% → 3 пог. м (стара формула давала 2, що не покриває кімнату)', () => {
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 2.5, roomWidthM: 2.5, widthM: 4 }),
    { meters: 3, requiresSeam: false }
  );
});

test('calcLinoleumMeters: безшовне покриття з вибором меншої орієнтації (2×3, ширина 3.5 → 3 пог. м)', () => {
  // 3.5 >= 2 і 3.5 >= 3: відріз min(2, 3) * 1.1 = 2.2 -> 3 пог. м
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 3, roomWidthM: 2, widthM: 3.5 }),
    { meters: 3, requiresSeam: false }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 2, roomWidthM: 3, widthM: 3.5 }),
    { meters: 3, requiresSeam: false }
  );
});

test('calcLinoleumMeters: безшовне покриття за однією стороною', () => {
  // 4 >= 4, але 4 < 5: відріз уздовж 5м -> ceil(5 * 1.1) = 6 пог. м
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, widthM: 4 }),
    { meters: 6, requiresSeam: false }
  );
  // Навпаки: довжина 4, ширина 5, рулон 4: відріз уздовж 5м -> 6 пог. м
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 4, roomWidthM: 5, widthM: 4 }),
    { meters: 6, requiresSeam: false }
  );
});

test('calcLinoleumMeters: 5×4, +10%, ширина 2.5 → 9 пог. м, requiresSeam: true', () => {
  // Рулон 2.5 вужчий за 5 і 4. Смуги вздовж 4м дають 2 смуги по 4.4м = 8.8м -> 9 пог. м
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, widthM: 2.5 }),
    { meters: 9, requiresSeam: true }
  );
});

test('calcLinoleumMeters: без ширини рулону → meters: null (не вигадуємо число)', () => {
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 5,
      roomWidthM: 4,
      widthM: undefined as unknown as number,
    }),
    { meters: null }
  );
});

test('calcLinoleumMeters: точний поділ та округлення зі стикуванням смуг', () => {
  // 5×4, ширина 2 -> смуги вздовж 5м: 2 смуги по 5.5м = 11м
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, widthM: 2 }),
    { meters: 11, requiresSeam: true }
  );
  // 3×3, ширина 2.5: 2 смуги по 3.3м = 6.6м -> 7 пог. м
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 3, roomWidthM: 3, widthM: 2.5 }),
    { meters: 7, requiresSeam: true }
  );
  // 0.5×0.4, ширина 1.5 -> без швів, min(0.5, 0.4) * 1.1 = 0.44 -> 1 пог. м
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 0.5, roomWidthM: 0.4, widthM: 1.5 }),
    { meters: 1, requiresSeam: false }
  );
});

test('calcLinoleumMeters: binary-fraction пастка — цілочисельні см, не float', () => {
  // 2×2.55 = 2.55м при рулоні 2.5 покриває сторону 2м без швів: 2.55 * 1.1 = 2.805 -> 3
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 2, roomWidthM: 2.55, widthM: 2.5 }),
    { meters: 3, requiresSeam: false }
  );
  // 3.3×2.9, ширина 2.5: 2 смуги по 2.9 * 1.1 = 6.38 -> 7
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 3.3, roomWidthM: 2.9, widthM: 2.5 }),
    { meters: 7, requiresSeam: true }
  );
});

test('calcLinoleumMeters: wastePercent — 0% без запасу, 25% округлюється вгору', () => {
  // 5×4, ширина 2.5, 0% -> 2 смуги по 4м = 8м
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 5,
      roomWidthM: 4,
      widthM: 2.5,
      wastePercent: 0,
    }),
    { meters: 8, requiresSeam: true }
  );
  // 4×4, ширина 2.5, 25% -> 2 смуги по 4 * 1.25 = 10м
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 4,
      roomWidthM: 4,
      widthM: 2.5,
      wastePercent: 25,
    }),
    { meters: 10, requiresSeam: true }
  );
  // 5×3, ширина 2.5, 25% -> 2 смуги по 3 * 1.25 = 7.5 -> 8м
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 5,
      roomWidthM: 3,
      widthM: 2.5,
      wastePercent: 25,
    }),
    { meters: 8, requiresSeam: true }
  );
});

test('calcLinoleumMeters: ширина поза сіткою LINOLEUM_WIDTHS_M / ≤0 → meters: null', () => {
  // 1.7 м не існує в продуктовій сітці (1.5|2|2.5|3|3.5|4) — зламаний
  // імпорт/специфікація, а не привід для вигаданої рекомендації.
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, widthM: 1.7 }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, widthM: 0 }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, widthM: -2.5 }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 5,
      roomWidthM: 4,
      widthM: Number.NaN,
    }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 5,
      roomWidthM: 4,
      widthM: Number.POSITIVE_INFINITY,
    }),
    { meters: null }
  );
});

test('calcLinoleumMeters: неможливий вхід кімнати (0, відʼємне, не-число) → meters: null', () => {
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 0, roomWidthM: 4, widthM: 2.5 }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: -1, widthM: 2.5 }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: Number.NaN, roomWidthM: 4, widthM: 2.5 }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: Number.POSITIVE_INFINITY,
      roomWidthM: 4,
      widthM: 2.5,
    }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 5,
      roomWidthM: 4,
      widthM: 2.5,
      wastePercent: -5,
    }),
    { meters: null }
  );
});

// ---- purity + source contract --------------------------------------------------

test('product-view: pure-модуль без React/Next/DB, реюз назв специфікацій імпортера', () => {
  assert.doesNotMatch(src, /from ['"]react|from ['"]next|supabase/);
  // Канонічні назви записів беруться з import-plan (єднине джерело),
  // не дублікуються літералами.
  assert.match(src, /PRICE_SQM_SPEC_NAME/);
  assert.match(src, /WIDTH_SPEC_NAME/);
  assert.match(
    src,
    /from ['"]\.\/import-plan\.ts['"]/,
    'назви записів — з import-plan.ts, не нові літерали'
  );
  // Сітка ширин рулону — з parse.ts (LINOLEUM_WIDTHS_M), не новий літерал:
  // calc відсікає ширину поза реальною продуктовою сіткою.
  assert.match(src, /LINOLEUM_WIDTHS_M/);
  assert.match(src, /from ['"]\.\/parse\.ts['"]/);
});
