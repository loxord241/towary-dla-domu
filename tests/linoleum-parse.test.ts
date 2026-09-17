/**
 * Unit tests for the pure 1C-linoleum CSV parser (linoleum vertical, batch 1):
 * parseLinoleumCsv over the contract `code;name;width_m;price_sqm;qty_m`.
 *
 * Contract under test (task L2, 2026-09-17; mirrors wallpapers/parse.ts):
 *   - `;`-separated, optional header line, BOM- and CRLF-tolerant, trimmed;
 *   - width_m — STRICTLY one of LINOLEUM_WIDTHS_M (1.5 | 2 | 2.5 | 3 | 4 м),
 *     decimal comma AND dot accepted; anything else is a per-line error;
 *   - price_sqm — sanity window 10..100000 грн/м² (see parse.ts comment);
 *   - qty_m — WHOLE running meters 0..99999; fractional strings rejected;
 *   - a line is valid ⇔ every field is valid; bad lines land in `errors`
 *     with 1-based physical line numbers and never fail the whole file;
 *   - duplicate codes are NOT deduplicated at this layer (import-plan's job).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLinoleumCsv,
  LINOLEUM_WIDTHS_M,
  LINOLEUM_PRICE_SQM_MIN,
  LINOLEUM_PRICE_SQM_MAX,
  LINOLEUM_QTY_M_MAX,
} from '../app/lib/linoleum/parse.ts';

const HEADER = 'code;name;width_m;price_sqm;qty_m';

// ---------------------------------------------------------------------------
// Valid rows
// ---------------------------------------------------------------------------

test('linoleum-parse: valid row with decimal commas', () => {
  const { rows, errors } = parseLinoleumCsv('L-100;Лінолеум Форум;2,5;350,50;40');
  assert.deepEqual(errors, []);
  assert.deepEqual(rows, [
    { code: 'L-100', name: 'Лінолеум Форум', widthM: 2.5, priceSqm: 350.5, qtyM: 40 },
  ]);
});

test('linoleum-parse: valid row with decimal dots', () => {
  const { rows, errors } = parseLinoleumCsv('L-100;Лінолеум Форум;2.5;350.5;40');
  assert.deepEqual(errors, []);
  assert.equal(rows[0]!.widthM, 2.5);
  assert.equal(rows[0]!.priceSqm, 350.5);
});

test('linoleum-parse: every width from the set parses (comma and dot forms)', () => {
  const widths = ['1,5', '2', '2,0', '2.5', '3', '4,0', '1.50'];
  for (const w of widths) {
    const { rows, errors } = parseLinoleumCsv(`C1;Назва;${w};250;10`);
    assert.deepEqual(errors, [], `width "${w}" must be valid`);
    assert.equal(rows.length, 1);
  }
  assert.deepEqual([...LINOLEUM_WIDTHS_M], [1.5, 2, 2.5, 3, 4], 'width set is pinned');
});

test('linoleum-parse: qty boundaries 0 and 99999 are valid', () => {
  for (const q of [0, LINOLEUM_QTY_M_MAX]) {
    const { rows, errors } = parseLinoleumCsv(`C1;Назва;3;250;${q}`);
    assert.deepEqual(errors, [], `qty ${q} must be valid`);
    assert.equal(rows[0]!.qtyM, q);
  }
});

test('linoleum-parse: price boundaries 10 and 100000 are valid', () => {
  assert.equal(LINOLEUM_PRICE_SQM_MIN, 10);
  assert.equal(LINOLEUM_PRICE_SQM_MAX, 100000);
  for (const p of [LINOLEUM_PRICE_SQM_MIN, LINOLEUM_PRICE_SQM_MAX]) {
    const { rows, errors } = parseLinoleumCsv(`C1;Назва;3;${p};10`);
    assert.deepEqual(errors, [], `price ${p} must be valid`);
    assert.equal(rows[0]!.priceSqm, p);
  }
});

// ---------------------------------------------------------------------------
// Per-line rejections — bad lines never fail the file
// ---------------------------------------------------------------------------

test('linoleum-parse: width outside the set → error', () => {
  for (const w of ['1.8', '5', '0.5', '10', '2,4']) {
    const { rows, errors } = parseLinoleumCsv(`C1;Назва;${w};250;10`);
    assert.deepEqual(rows, [], `width "${w}" must not parse`);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.reason, /width_m/);
  }
});

test('linoleum-parse: fractional qty (comma or dot) → error', () => {
  for (const q of ['12,5', '12.5', '0,5']) {
    const { rows, errors } = parseLinoleumCsv(`C1;Назва;3;250;${q}`);
    assert.deepEqual(rows, [], `qty "${q}" must not parse`);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.reason, /qty_m: not a plain integer/);
  }
});

test('linoleum-parse: price outside the sanity window → error', () => {
  for (const p of ['9,99', '100000,01', '0']) {
    const { rows, errors } = parseLinoleumCsv(`C1;Назва;3;${p};10`);
    assert.deepEqual(rows, [], `price "${p}" must not parse`);
    assert.match(errors[0]!.reason, /price_sqm.*out of range/);
  }
});

test('linoleum-parse: signed / exponent prices are not plain numbers → error', () => {
  for (const p of ['-5', '+5', '1e3', '250 грн']) {
    const { rows, errors } = parseLinoleumCsv(`C1;Назва;3;${p};10`);
    assert.deepEqual(rows, [], `price "${p}" must not parse`);
    assert.match(errors[0]!.reason, /price_sqm: not a plain number/);
  }
});

test('linoleum-parse: empty code / empty name → error', () => {
  const noCode = parseLinoleumCsv(`;Назва;3;250;10`);
  assert.deepEqual(noCode.rows, []);
  assert.match(noCode.errors[0]!.reason, /code is empty/);

  const noName = parseLinoleumCsv(`C1;;3;250;10`);
  assert.deepEqual(noName.rows, []);
  assert.match(noName.errors[0]!.reason, /name is empty/);
});

test('linoleum-parse: wrong column count → error with expected count', () => {
  const { rows, errors } = parseLinoleumCsv('C1;Назва;3;250');
  assert.deepEqual(rows, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.reason, /expected 5 ';'-separated columns, got 4/);
});

test('linoleum-parse: several problems on one line are aggregated', () => {
  const { errors } = parseLinoleumCsv(';Назва;9;0;1,5');
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.reason, /code is empty/);
  assert.match(errors[0]!.reason, /width_m/);
  assert.match(errors[0]!.reason, /price_sqm/);
  assert.match(errors[0]!.reason, /qty_m/);
});

test('linoleum-parse: a bad line does not fail the file; line numbers are 1-based physical', () => {
  const body = `${HEADER}\nC1;Назва;3;250;10\nC2;Крива ширина;1,8;250;10\nC3;Ще назва;4;300;0\n`;
  const { rows, errors } = parseLinoleumCsv(body);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.code), ['C1', 'C3']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 3);
});

// ---------------------------------------------------------------------------
// File-level tolerance: BOM, CRLF, optional header, blank lines, duplicates
// ---------------------------------------------------------------------------

test('linoleum-parse: BOM + CRLF + trailing newline tolerated', () => {
  const { rows, errors } = parseLinoleumCsv(`\uFEFF${HEADER}\r\nL-7;Лінолеум Сіріус;3;410;7\r\n`);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.code, 'L-7');
  assert.equal(rows[0]!.widthM, 3);
});

test('linoleum-parse: optional header line is skipped only when it matches', () => {
  const withHeader = parseLinoleumCsv(`${HEADER}\nC1;Назва;3;250;10\n`);
  assert.equal(withHeader.rows.length, 1);
  assert.deepEqual(withHeader.errors, []);

  const wrongHeader = parseLinoleumCsv(`code;name;width;price;qty\nC1;Назва;3;250;10\n`);
  assert.equal(wrongHeader.rows.length, 1, 'a non-header first line is parsed as data');
  assert.equal(wrongHeader.errors.length, 1, '...and the wrong-shaped header itself errors');
  assert.equal(wrongHeader.errors[0]!.line, 1);
});

test('linoleum-parse: blank lines are ignored', () => {
  const { rows, errors } = parseLinoleumCsv(`\nC1;Назва;3;250;10\n\n\nC2;Інша;2;180;0\n`);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
});

test('linoleum-parse: duplicate codes are NOT deduplicated (import-plan layer decides)', () => {
  const body = `C1;Перша назва;3;250;10\nC1;Друга назва;4;300;5\n`;
  const { rows, errors } = parseLinoleumCsv(body);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2, 'both lines survive to the staging/import layers');
});

test('linoleum-parse: never throws on garbage input', () => {
  assert.deepEqual(parseLinoleumCsv(''), { rows: [], errors: [] });
  assert.deepEqual(parseLinoleumCsv('\uFEFF'), { rows: [], errors: [] });
  const garbage = parseLinoleumCsv(';;;');
  assert.equal(garbage.rows.length, 0);
  assert.equal(garbage.errors.length, 1);
});
