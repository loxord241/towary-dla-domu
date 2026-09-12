/**
 * Unit tests for the pure 1C-wallpaper parsers (plan Task 3):
 * parseWallpaperCsv / parseArticleTokens / parseRollSize.
 *
 * Fixtures are REAL names from the 2026-09-10 shop inventory
 * (spec: docs/superpowers/specs/2026-09-10-wallpapers-import-design.md §3).
 * These tests pin the article-token rules so the photo matchers (Task 8)
 * can rely on them; the token grammar intentionally reproduces the
 * checklist-matcher prototype verified against the live inventory.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWallpaperCsv,
  parseArticleTokens,
  parseRollSize,
} from '../app/lib/wallpapers/parse.ts';

// ---------------------------------------------------------------------------
// parseArticleTokens — real inventory names
// ---------------------------------------------------------------------------

test('wallpaper-parse: tokens for 6647-04 (NNNN-NN)', () => {
  assert.deepEqual(parseArticleTokens('6647-04 шпалери,53см*10м'), ['6647-04']);
});

test('wallpaper-parse: tokens for 86000BR90 (alnum latin, lowercased)', () => {
  assert.deepEqual(
    parseArticleTokens('86000BR90 Браво темні, шпалери 1,06*10м'),
    ['86000br90'],
  );
});

test('wallpaper-parse: tokens for SP 531-34 (prefix + inner NNNN-NN both)', () => {
  assert.deepEqual(parseArticleTokens('SP 531-34 какао+золото/шпалери 1,06*10м'), [
    'sp531-34',
    '531-34',
  ]);
});

test('wallpaper-parse: tokens for SP515-13 (direct attach suppresses inner)', () => {
  assert.deepEqual(parseArticleTokens('SP515-13 персик под штукатурку'), ['sp515-13']);
});

test('wallpaper-parse: tokens for Тінь3829-10 (4+ letter word not a prefix)', () => {
  assert.deepEqual(parseArticleTokens('Тінь3829-10 шпалери,рулон 1,06*10м'), ['3829-10']);
});

test('wallpaper-parse: tokens for 163с27 (cyrillic с inside alnum)', () => {
  assert.deepEqual(parseArticleTokens('163с27 обои, рулон 10м сірий металік'), ['163с27']);
});

test('wallpaper-parse: tokens for Рн105р15', () => {
  assert.deepEqual(parseArticleTokens('Рн105р15 обоі завитокбеж'), ['рн105р15']);
});

test('wallpaper-parse: tokens for Рн 213р97 (space after short prefix glues)', () => {
  assert.deepEqual(parseArticleTokens('Рн 213р97 обоі  сірий трехугольн'), ['рн213р97']);
});

test('wallpaper-parse: tokens for PH 206 P 84 (multi-fragment glue)', () => {
  assert.deepEqual(
    parseArticleTokens('PH 206 P 84 світло cірі+срібло шпалери,рулон 1,06*10м'),
    ['ph206p84'],
  );
});

test('wallpaper-parse: tokens for Абстракция 5243 02 (NNNN NN -> dash, bare NNNN suppressed)', () => {
  assert.deepEqual(parseArticleTokens('Абстракция 5243 02 беж'), ['5243-02']);
});

test('wallpaper-parse: tokens for 30202 (bare 5-digit)', () => {
  assert.deepEqual(parseArticleTokens('30202 бузкова лілея шпалери'), ['30202']);
});

test('wallpaper-parse: tokens for 1598 (bare 4-digit; sizes/units ignored)', () => {
  assert.deepEqual(parseArticleTokens('1598 рожево бірюзові квіти,шпалери,53см*10м'), ['1598']);
});

test('wallpaper-parse: bare 4-digit standalone name', () => {
  assert.deepEqual(parseArticleTokens('5070'), ['5070']);
});

test('wallpaper-parse: names without any article yield no tokens', () => {
  assert.deepEqual(parseArticleTokens('обои вінілові білі'), []);
  assert.deepEqual(parseArticleTokens(''), []);
});

test('wallpaper-parse: duplicate article occurrences deduplicate', () => {
  assert.deepEqual(parseArticleTokens('6647-04 шпалери (6647-04)'), ['6647-04']);
});

test('wallpaper-parse: 8+ digit runs are not candidates (not an article shape)', () => {
  assert.deepEqual(parseArticleTokens('12345678 тест шпалери'), []);
});

test('wallpaper-parse: size fragments (53см, 10м, 1,06) never become tokens', () => {
  assert.deepEqual(parseArticleTokens('шпалери 53см*10м'), []);
  assert.deepEqual(parseArticleTokens('шпалери 1,06*10,05м'), []);
});

// ---------------------------------------------------------------------------
// parseRollSize
// ---------------------------------------------------------------------------

test('wallpaper-parse: rollSize 53см*10м', () => {
  assert.deepEqual(parseRollSize('6647-04 шпалери,53см*10м'), { widthCm: 53, lengthM: 10 });
});

test('wallpaper-parse: rollSize 0,53*10м (meters -> cm)', () => {
  assert.deepEqual(parseRollSize('0,53*10м'), { widthCm: 53, lengthM: 10 });
});

test('wallpaper-parse: rollSize 1,06*10м', () => {
  assert.deepEqual(parseRollSize('86000BR90 Браво темні, шпалери 1,06*10м'), {
    widthCm: 106,
    lengthM: 10,
  });
});

test('wallpaper-parse: rollSize 53см×15м (unicode multiply sign)', () => {
  assert.deepEqual(parseRollSize('53см×15м'), { widthCm: 53, lengthM: 15 });
});

test('wallpaper-parse: rollSize 106х10 (cyrillic х, no units)', () => {
  assert.deepEqual(parseRollSize('106х10'), { widthCm: 106, lengthM: 10 });
});

test('wallpaper-parse: rollSize 1,06х10,05м (10,05 truncates to 10)', () => {
  assert.deepEqual(parseRollSize('1,06х10,05м'), { widthCm: 106, lengthM: 10 });
});

test('wallpaper-parse: rollSize inside real inventory name', () => {
  assert.deepEqual(parseRollSize('Тінь3829-10 шпалери,рулон 1,06*10м'), {
    widthCm: 106,
    lengthM: 10,
  });
});

test('wallpaper-parse: rollSize null for unsupported dimensions', () => {
  assert.equal(parseRollSize('70см*10м'), null);
  assert.equal(parseRollSize('53см*12м'), null);
  assert.equal(parseRollSize('106х18'), null);
});

test('wallpaper-parse: rollSize null when no size in name', () => {
  assert.equal(parseRollSize('30202 бузкова лілея шпалери'), null);
  assert.equal(parseRollSize(''), null);
});

// ---------------------------------------------------------------------------
// parseWallpaperCsv
// ---------------------------------------------------------------------------

const HEADER = 'code;name;article;unit;price_retail;qty';

test('wallpaper-parse: csv fixture — valid row + strict per-line errors', () => {
  const text =
    `${HEADER}\n35125;30202 бузкова лілея шпалери;;рулон;210;15\nкривая;строка;x;;-5;1000\n\n`;
  const { rows, errors } = parseWallpaperCsv(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    code: '35125',
    name: '30202 бузкова лілея шпалери',
    article: null,
    rollSize: null,
    priceRetail: 210,
    qty: 15,
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.line, 3);
  assert.match(errors[0]?.reason ?? '', /price_retail/);
  assert.match(errors[0]?.reason ?? '', /qty/);
});

test('wallpaper-parse: csv with BOM and case-insensitive header', () => {
  const text = `\uFEFFCode;Name;Article;Unit;Price_Retail;Qty\n1;тест 53см*10м;;шт;100;2`;
  const { rows, errors } = parseWallpaperCsv(text);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.rollSize, { widthCm: 53, lengthM: 10 });
});

test('wallpaper-parse: csv without header parses data from line 1', () => {
  const { rows, errors } = parseWallpaperCsv('77;шпалери;а1;шт;50,5;7');
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.code, '77');
  assert.equal(rows[0]?.article, 'а1');
  assert.equal(rows[0]?.priceRetail, 50.5);
});

test('wallpaper-parse: csv CRLF line endings and physical line numbers', () => {
  const text = `${HEADER}\r\n1;ок;;шт;250;1\r\nbad;строка;;шт;-1;0\r\n`;
  const { rows, errors } = parseWallpaperCsv(text);
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.line, 3);
});

test('wallpaper-parse: csv blank lines are skipped silently', () => {
  const text = `\n\n${HEADER}\n\n1;а;;шт;250;5\n\n2;б;;шт;260;6\n`;
  const { rows, errors } = parseWallpaperCsv(text);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
});

test('wallpaper-parse: csv price boundaries 50..5000 (spec sanity windows)', () => {
  // 2026-09-12: windows aligned with the design spec (audit P2) — live
  // wc-* range 110..1400 грн.
  const okLow = parseWallpaperCsv(`${HEADER}\n1;а;;шт;50;1`).errors;
  const okHigh = parseWallpaperCsv(`${HEADER}\n1;а;;шт;5000;1`).errors;
  assert.deepEqual(okLow, []);
  assert.deepEqual(okHigh, []);
  const badLow = parseWallpaperCsv(`${HEADER}\n1;а;;шт;49;1`).errors;
  assert.equal(badLow.length, 1);
  assert.match(badLow[0]?.reason ?? '', /price_retail/);
  const badHigh = parseWallpaperCsv(`${HEADER}\n1;а;;шт;5000.01;1`).errors;
  assert.equal(badHigh.length, 1);
  assert.match(badHigh[0]?.reason ?? '', /price_retail/);
});

test('wallpaper-parse: csv qty boundaries 0..999, decimals rejected', () => {
  assert.deepEqual(parseWallpaperCsv(`${HEADER}\n1;а;;шт;250;999`).errors, []);
  assert.deepEqual(parseWallpaperCsv(`${HEADER}\n1;а;;шт;250;0`).errors, []);
  const tooBig = parseWallpaperCsv(`${HEADER}\n1;а;;шт;250;1000`).errors;
  assert.match(tooBig[0]?.reason ?? '', /qty/);
  const decimal = parseWallpaperCsv(`${HEADER}\n1;а;;шт;250;12.5`).errors;
  assert.match(decimal[0]?.reason ?? '', /qty/);
});

test('wallpaper-parse: csv wrong column count -> error, not throw', () => {
  const { rows, errors } = parseWallpaperCsv(`${HEADER}\n1;только;три;колонки`);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.line, 2);
  assert.match(errors[0]?.reason ?? '', /columns/);
});

test('wallpaper-parse: csv empty code or empty name -> error', () => {
  const emptyCode = parseWallpaperCsv(`${HEADER}\n;нет кода;;шт;250;1`).errors;
  assert.match(emptyCode[0]?.reason ?? '', /code/);
  const emptyName = parseWallpaperCsv(`${HEADER}\n5;;;шт;250;1`).errors;
  assert.match(emptyName[0]?.reason ?? '', /name/);
});

test('wallpaper-parse: csv non-numeric price/qty collected without throwing', () => {
  const { errors } = parseWallpaperCsv(`${HEADER}\n1;а;;шт;дорого;много`);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.reason ?? '', /price_retail/);
  assert.match(errors[0]?.reason ?? '', /qty/);
});

test('wallpaper-parse: csv empty input and header-only input', () => {
  assert.deepEqual(parseWallpaperCsv(''), { rows: [], errors: [] });
  assert.deepEqual(parseWallpaperCsv(`${HEADER}\n`), { rows: [], errors: [] });
});

test('wallpaper-parse: csv rollSize and article column land in the row', () => {
  const { rows } = parseWallpaperCsv(`${HEADER}\n9;шпалері 53см×15м;СП-9;рулон;300;12`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.article, 'СП-9');
  assert.deepEqual(rows[0]?.rollSize, { widthCm: 53, lengthM: 15 });
});

test('parseRollSize: разделитель «на» («рулон 1,06 на 10м» — реальное имя wc-x40346)', () => {
  assert.deepEqual(parseRollSize('Атлантида В118 8779-02,шпалери,рулон 1,06 на 10м'), {
    widthCm: 106,
    lengthM: 10,
  });
  assert.deepEqual(parseRollSize('шпалери 0,53 на 15м беж'), { widthCm: 53, lengthM: 15 });
  // «на» без пробелов словом не является
  assert.equal(parseRollSize('шпалери 1,06на10м'), null);
});
