/**
 * Static invariants for the PDP roll calculator (wallpapers phase 2,
 * plan 2026-09-10). node:test cannot render React (.tsx), so the component
 * and the page integration are pinned by source inspection — the same
 * convention as pdp-specs-placement.test.ts / product-specifications.test.ts.
 *
 * Math itself is unit-tested for real in tests/roll-math.test.ts.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const componentSrc = readFileSync(
  path.join(root, 'app/components/RollCalculator.tsx'),
  'utf8'
);
const pageSrc = readFileSync(
  path.join(root, 'app/product/[slug]/page.tsx'),
  'utf8'
);

// ---- RollCalculator component ------------------------------------------------

test('roll-calculator: is a client component using the cart context', () => {
  assert.ok(
    componentSrc.startsWith("'use client'"),
    'компонент має бути client ("use client" першим рядком)'
  );
  assert.match(
    componentSrc,
    /import \{ useCart, MAX_ITEM_QUANTITY \} from '@\/app\/lib\/cart-context'/,
    'додавання йде через наявний cart-context'
  );
  assert.match(
    componentSrc,
    /addItem\(productId, null, calc\.rolls\)/,
    'у кошик додається рівно розрахована кількість (quantity = N)'
  );
});

test('roll-calculator: inputs — периметр, висота, підбір, розмір рулона', () => {
  assert.match(componentSrc, /Периметр приміщення, м/);
  assert.match(componentSrc, /Висота стін, м/);
  assert.match(componentSrc, /Малюнок з підбором/);
  // controlled number inputs for both measurements
  const numberInputs = componentSrc.match(/type="number"/g) ?? [];
  assert.equal(numberInputs.length, 2, 'два number-поля (периметр і висота)');
  assert.match(componentSrc, /type="checkbox"/, 'перемикач підбору — checkbox');
  assert.match(componentSrc, /Розмір рулона:/, 'select розміру рулона присутній');
  // the three nominal sizes from the 1C feed are selectable
  for (const key of ['53x10', '53x15', '106x10']) {
    assert.ok(
      componentSrc.includes(`key: '${key}'`),
      `опція рулона ${key} має бути в select`
    );
  }
});

test('roll-calculator: result — «Рекомендовано: N рул.» + «Додати N у кошик»', () => {
  assert.match(componentSrc, /Рекомендовано:/);
  assert.match(componentSrc, /\{calc\.rolls\} рул\./);
  assert.match(
    componentSrc,
    /Додати \{calc\.rolls\} у кошик/,
    'кнопка додавання несе розраховану кількість'
  );
  assert.match(componentSrc, /calculateRolls\(/, 'математика — з pure-модуля roll-math');
});

test('roll-calculator: motion-reduce обовʼязковий (animate-none + transition-none)', () => {
  assert.match(
    componentSrc,
    /added-in motion-reduce:animate-none/,
    'поява результату анімується з вимкненням при reduced motion'
  );
  assert.match(
    componentSrc,
    /motion-reduce:transition-none/,
    'переходи кнопок/посилань вимикаються при reduced motion'
  );
  const animateNone = (componentSrc.match(/motion-reduce:animate-none/g) ?? []).length;
  assert.ok(animateNone >= 1, 'animate-none щонайменше на блоці результату');
});

test('roll-calculator: impossible-кейс показує пояснення, а не рекомендацію', () => {
  assert.match(
    componentSrc,
    /calc\.impossible/,
    'прапорець impossible з roll-math опрацьовується'
  );
  assert.match(componentSrc, /не\s+вміщується\s+в\s+рулон/);
});

// ---- PDP integration ----------------------------------------------------------

test('roll-calculator: PDP монтує калькулятор ТІЛЬКИ для wc-* з розпізнаним розміром', () => {
  assert.match(
    pageSrc,
    /import RollCalculator from '@\/app\/components\/RollCalculator'/,
    'PDP імпортує компонент'
  );
  assert.match(
    pageSrc,
    /import \{ parseRollSize \} from '@\/app\/lib\/wallpapers\/parse'/,
    'розмір рулона парситься реюзом parseRollSize'
  );
  // The single decision point: wc-* gate…
  assert.match(
    pageSrc,
    /const isWallpaper = product\.sku\.startsWith\('wc-'\)/,
    'гейт — sku починається на wc-'
  );
  // …parsed on the server, null propagated (no default size).
  assert.match(
    pageSrc,
    /const rollSize = isWallpaper \? parseRollSize\(product\.name\) : null/,
    'розмір парситься на сервері; без розпізнаного розміру — null'
  );
  // …and the render is guarded by BOTH the sku gate and the parsed size.
  assert.match(
    pageSrc,
    /\{isWallpaper && rollSize !== null && \(\s*<RollCalculator\s+productId=\{product\.id\}\s+rollSize=\{rollSize\}\s*\/>\s*\)\}/,
    'рендер лише для wc-* і rollSize !== null'
  );
  assert.equal(
    (pageSrc.match(/<RollCalculator/g) ?? []).length,
    1,
    'калькулятор монтується рівно в одному місці сторінки'
  );
});
