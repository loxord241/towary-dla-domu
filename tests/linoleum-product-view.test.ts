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

// ---- meter math ---------------------------------------------------------------
// REGRESSION (ревʼю власника 2026-09-17): калькулятор ігнорував ШИРИНУ
// РУЛОНУ — 22 м² кімнати при рулоні 2,5 м показував як «22 пог. м»
// (переплата у ширину рулону), а треба 22 / 2,5 = 8,8 → 9 пог. м.
// Погонні метри = (площа + запас) / ширина рулону; widthM — обовʼязковий.

test('calcLinoleumMeters: 5×4, +10%, ширина 2,5 → 9 пог. м (22/2,5=8,8→9)', () => {
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, widthM: 2.5 }),
    { meters: 9 }
  );
});

test('calcLinoleumMeters: та сама кімната, ширина 4 → 6 пог. м (22/4=5,5→6)', () => {
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, widthM: 4 }),
    { meters: 6 }
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

test('calcLinoleumMeters: точний поділ не додає метр (22/2 = 11), дрібний — округлює вгору', () => {
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, widthM: 2 }),
    { meters: 11 }
  );
  // 3×3 = 9 м² × 1.1 = 9.9 м² / 2.5 = 3.96 → 4
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 3, roomWidthM: 3, widthM: 2.5 }),
    { meters: 4 }
  );
  // 0.5×0.4 = 0.2 м² × 1.1 = 0.22 м² / 1.5 ≈ 0.15 → 1 (мінімум покупки — 1 м)
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 0.5, roomWidthM: 0.4, widthM: 1.5 }),
    { meters: 1 }
  );
});

test('calcLinoleumMeters: binary-fraction пастка — цілочисельні см, не float', () => {
  // 2×2.55 = 5.1 м² × 1.1 = 5.61 м² / 2.5 = 2.244 → 3; наївний float-шлях
  // через проміжні binary дроби не має дійти до ceil (контракт модуля).
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 2, roomWidthM: 2.55, widthM: 2.5 }),
    { meters: 3 }
  );
  // 3.3×2.9 = 9.57 м² × 1.1 = 10.527 м² / 2.5 = 4.2108 → 5
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 3.3, roomWidthM: 2.9, widthM: 2.5 }),
    { meters: 5 }
  );
});

test('calcLinoleumMeters: wastePercent — 0% без запасу, 25% округлюється вгору', () => {
  // 20 м² / 2.5 = рівно 8
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 5,
      roomWidthM: 4,
      widthM: 2.5,
      wastePercent: 0,
    }),
    { meters: 8 }
  );
  // 4×4 = 16 м² × 1.25 = 20 м² / 2.5 = рівно 8
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 4,
      roomWidthM: 4,
      widthM: 2.5,
      wastePercent: 25,
    }),
    { meters: 8 }
  );
  // 5×3 = 15 м² × 1.25 = 18.75 м² / 2.5 = 7.5 → 8
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: 5,
      roomWidthM: 3,
      widthM: 2.5,
      wastePercent: 25,
    }),
    { meters: 8 }
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
