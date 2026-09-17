/**
 * Pure view-layer helpers for ln-* products (linoleum vertical, batch 3,
 * task L6, 2026-09-17). Unit tests for app/lib/linoleum/product-view.ts —
 * a pure module (no React/Next/DB) mirroring the roll-math convention:
 *
 *   - extractPricePerSqm / extractWidthLabel read the specification entries
 *     written by the batch-2 importer (import-plan.ts buildSpecifications:
 *     «Ціна за м²» = formatPriceSqmValue canon «410,00», «Ширина» =
 *     formatWidthM canon «1,5»);
 *   - calcLinoleumMeters: room area + default +10 % waste, ceil to WHOLE
 *     metres (the purchase path sells integer metres 1–99, owner plan
 *     2026-09-17). Integer-centimetre arithmetic like roll-math.ts: IEEE-754
 *     binary fractions make ceil treacherous near integers, so the area is
 *     computed in cm² before the waste factor is applied.
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

test('calcLinoleumMeters: звичайна кімната 5×4 = 20 м² + 10% = 22 м', () => {
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4 }),
    { meters: 22 }
  );
});

test('calcLinoleumMeters: дрібні кімнати округлюються вгору до цілого метра', () => {
  // 3×3 = 9 м² × 1.1 = 9.9 → 10
  assert.deepEqual(mod.calcLinoleumMeters({ roomLengthM: 3, roomWidthM: 3 }), {
    meters: 10,
  });
  // 0.5×0.4 = 0.2 м² × 1.1 = 0.22 → 1 (мінімум покупки — 1 м)
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 0.5, roomWidthM: 0.4 }),
    { meters: 1 }
  );
});

test('calcLinoleumMeters: binary-fraction пастка — цілочисельні см, не float', () => {
  // 2×2.55 = 5.1 м² × 1.1 = 5.61 → ceil 6. Наивний float-шлях через
  // проміжні binary дроби може дати 5.6000000000000005 → той самий ceil,
  // але 3.3×2.9 = 9.57 × 1.1 = 10.527 — перевіряємо саме стабільність
  // результату на сантиметровій арифметиці (контракт модуля).
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 2, roomWidthM: 2.55 }),
    { meters: 6 }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 3.3, roomWidthM: 2.9 }),
    { meters: 11 }
  );
});

test('calcLinoleumMeters: wastePercent — 0% без запасу, 25% округлюється вгору', () => {
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, wastePercent: 0 }),
    { meters: 20 }
  );
  // 4×4 = 16 м² × 1.25 = 20 → рівно 20
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 4, roomWidthM: 4, wastePercent: 25 }),
    { meters: 20 }
  );
  // 5×3 = 15 м² × 1.25 = 18.75 → 19
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 3, wastePercent: 25 }),
    { meters: 19 }
  );
});

test('calcLinoleumMeters: неможливий вхід (0, відʼємне, не-число) → meters: null', () => {
  assert.deepEqual(mod.calcLinoleumMeters({ roomLengthM: 0, roomWidthM: 4 }), {
    meters: null,
  });
  assert.deepEqual(mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: -1 }), {
    meters: null,
  });
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: Number.NaN, roomWidthM: 4 }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({
      roomLengthM: Number.POSITIVE_INFINITY,
      roomWidthM: 4,
    }),
    { meters: null }
  );
  assert.deepEqual(
    mod.calcLinoleumMeters({ roomLengthM: 5, roomWidthM: 4, wastePercent: -5 }),
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
});
