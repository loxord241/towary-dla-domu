/**
 * PDP <title> compaction (audit R3 2026-09-15): 1 934 eligible products
 * carried supplier names long enough to push «name — Товари для дому» past
 * the ~60-char SERP window (worst case 149 chars). The compactor builds a
 * shorter title name from the REAL name tokens only — leading type words +
 * brand + the model token (the digit-bearing token, where model numbers
 * live) — and falls back to a word-boundary truncation when no structure
 * can be found. Honesty rule: every emitted token comes from the product
 * name / brand; nothing is invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductTitleName } from '../app/lib/seo.ts';

const SUFFIX = ' — Товари для дому';

test('TITLE: short names pass through unchanged', () => {
  assert.equal(buildProductTitleName('Праска TEFAL FV5718E0', { brandName: 'TEFAL' }), 'Праска TEFAL FV5718E0');
  assert.equal(buildProductTitleName('Блендер', {}), 'Блендер');
});

test('TITLE: «type + brand + model» compaction for a long real name', () => {
  const name = 'Сервіз LUMINARC DIWALI LIGHT TURQUOISE /19 пр. (P2947)';
  assert.equal(
    buildProductTitleName(name, { brandName: 'LUMINARC' }),
    'Сервіз LUMINARC (P2947)'
  );
});

test('TITLE: keeps the last digit-bearing token as the model (multi-code names)', () => {
  const name = 'Холодильник Hisense RT641N4WIE1 BCD-456WYR' + ' з системою No Frost';
  assert.equal(
    buildProductTitleName(name, { brandName: 'Hisense' }),
    'Холодильник Hisense BCD-456WYR'
  );
});

test('TITLE: brand-first names keep the type words that follow the brand', () => {
  const name = 'TEFAL Бутербродниця SW383D10 3 в 1 багатофункціональна';
  assert.equal(
    buildProductTitleName(name, { brandName: 'TEFAL' }),
    'TEFAL Бутербродниця SW383D10'
  );
});

test('TITLE: no model token → «type + brand», still within budget', () => {
  const name = 'Набір кухонних ножів із підставкою Bull 9 предметів нержавіюча сталь';
  const out = buildProductTitleName(name, { brandName: 'Bull' });
  assert.ok(out.length <= 48, `name budget violated: ${out.length}`);
  assert.ok(out.includes('Bull'));
  assert.ok(out.startsWith('Набір'));
});

test('TITLE: unstructured long name falls back to a word-boundary truncation ≤48', () => {
  const name = 'Комплект ножів професійних з дерев’яною ручкою у подарунковій упаковці клас';
  const out = buildProductTitleName(name);
  assert.ok(out.length <= 48, `budget violated: ${out.length}`);
  assert.ok(!/\s$/.test(out), 'no trailing space');
  assert.ok(name.startsWith(out.slice(0, 10)), 'prefix of the real name');
});

test('TITLE: full title (name + suffix) fits the ~60-char SERP window for long inputs', () => {
  const long = 'Вбудована незалежна посудомийна машина Hisense HS622D60WX 60 см 12 наборів';
  const title = `${buildProductTitleName(long, { brandName: 'Hisense' })}${SUFFIX}`;
  assert.ok(title.length <= 66, `title too long (${title.length}): ${title}`);
});

test('TITLE: unknown brand name in opts is ignored gracefully', () => {
  const name = 'Сервіз LUMINARC DIWALI LIGHT TURQUOISE /19 пр. (P2947)';
  // Brand not present in the name → structural candidate must not claim it;
  // the honest fallback is the word-boundary truncation.
  const out = buildProductTitleName(name, { brandName: 'NONEXISTENT' });
  assert.ok(!out.includes('NONEXISTENT'));
  assert.ok(out.length <= 48);
});
