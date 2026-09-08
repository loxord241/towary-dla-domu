/**
 * F7: «Характеристики товару» block on the product page.
 *
 * The component itself is .tsx (JSX — not importable under node:test type
 * stripping), so coverage is split:
 *  - sanitizeSpecRows: full unit coverage (pure .ts);
 *  - ProductSpecifications.tsx: static source invariants — heading,
 *    table-fixed + overflow-wrap classes (no horizontal overflow),
 *    text-only rendering of values ({row.value} expression, no raw-HTML
 *    sink), null return for empty sets.
 * Live SSR spot-checks are performed separately against `next start`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { sanitizeSpecRows } = await import('../app/lib/product-specifications.ts');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const componentSrc = readFileSync(
  path.join(root, 'app/components/ProductSpecifications.tsx'),
  'utf8'
);

test('SPEC helper: normal array passes through in supplier order', () => {
  const rows = sanitizeSpecRows([
    { name: 'Тип', value: 'Відпарювач' },
    { name: 'Потужність, Вт', value: '1300.00' },
  ]);
  // Extended 2026-09: purely numeric values lose their trailing zeros for
  // display («1300.00» → «1300») — the stored JSONB is never mutated.
  assert.deepEqual(rows, [
    { name: 'Тип', value: 'Відпарювач' },
    { name: 'Потужність, Вт', value: '1300' },
  ]);
});

test('SPEC helper: trailing zeros trimmed on purely numeric values only', () => {
  const rows = sanitizeSpecRows([
    { name: 'A', value: '1000.00' }, // whole-number fraction → drop the dot too
    { name: 'B', value: '0.80' }, // fraction zeros → «0.8», separator KEPT
    { name: 'C', value: '10.50' }, // → «10.5»
    { name: 'D', value: '0.00' }, // → «0»
    { name: 'E', value: '1000' }, // integer: already clean, untouched
    { name: 'F', value: '1,7' }, // comma separator is NOT our business
    { name: 'G', value: '20 м²' }, // units → verbatim
    { name: 'H', value: '10x15' }, // non-numeric → verbatim
    { name: 'I', value: '-1.50' }, // sign → verbatim (not purely numeric)
    { name: 'J', value: '100.00.00' }, // not a number → verbatim
    { name: 'K', value: '.50' }, // no leading digits → verbatim
    { name: 'L', value: '0' }, // single digit integer → verbatim
  ]);
  assert.deepEqual(
    rows.map((r) => r.value),
    [
      '1000',
      '0.8',
      '10.5',
      '0',
      '1000',
      '1,7',
      '20 м²',
      '10x15',
      '-1.50',
      '100.00.00',
      '.50',
      '0',
    ]
  );
});

test('SPEC helper: absent/empty/invalid → empty array (block hidden)', () => {
  assert.deepEqual(sanitizeSpecRows(null), []);
  assert.deepEqual(sanitizeSpecRows(undefined), []);
  assert.deepEqual(sanitizeSpecRows([]), []);
  assert.deepEqual(sanitizeSpecRows('nope'), []);
  assert.deepEqual(
    sanitizeSpecRows([null, 42, 'junk', {}, { name: '', value: 'x' }, { name: 'x', value: '   ' }]),
    []
  );
  // mixed: invalid entries dropped, valid kept
  const mixed = sanitizeSpecRows([
    { name: 'Тип', value: 'Відпарювач' },
    null,
    { name: 'Країна', value: 'Україна' },
  ]);
  assert.deepEqual(mixed, [
    { name: 'Тип', value: 'Відпарювач' },
    { name: 'Країна', value: 'Україна' },
  ]);
});

test('SPEC duplicate names preserved as separate rows in order', () => {
  const rows = sanitizeSpecRows([
    { name: 'Рекомендована площа', value: '20 м²' },
    { name: 'Колір', value: 'білий' },
    { name: 'Рекомендована площа', value: '25 м²' },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.value), ['20 м²', 'білий', '25 м²']);
});

test('SPEC component: renders a fixed-layout wrapping table with Ukrainian heading', () => {
  assert.match(componentSrc, /Характеристики товару/);
  assert.match(componentSrc, /table-fixed/, 'фиксированная раскладка исключает горизонтальный overflow');
  assert.match(componentSrc, /w-full/);
  assert.match(componentSrc, /\[overflow-wrap:anywhere\]/, 'длинные слова обязаны переноситься');
  assert.match(componentSrc, /break-words/);
  assert.ok(!componentSrc.includes('<script'), 'никаких скриптов');
});

test('SPEC component: values render as React text children, never as HTML', () => {
  assert.match(componentSrc, /\{row\.value\}/, 'значение должно рендериться текстовым выражением');
  assert.match(componentSrc, /\{row\.name\}/);
  assert.ok(
    !componentSrc.includes('dangerouslySetInnerHTML'),
    'компонент не имеет HTML-sink (инвариант единственного sink в ProductDescription)'
  );
});

test('SPEC component: empty set returns null (no empty block)', () => {
  assert.match(componentSrc, /if \(rows\.length === 0\) return null;/);
  assert.match(componentSrc, /sanitizeSpecRows\(specifications\)/);
});
