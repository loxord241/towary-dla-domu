/**
 * Ukrposhta Address Classifier — parsing against REAL keyless responses.
 *
 * Fixtures in tests/fixtures/ukrposhta/ are live responses captured
 * 2026-09-08 from https://www.ukrposhta.ua/address-classifier/0.0.1/ with
 * `Accept: application/json` (no keys, no auth):
 *   - regions.json                — get_regions_by_region_ua (full list);
 *   - city-search-lviv.json       — get_city_…?city_ua=Львів (7 matches);
 *   - offices-by-poCityId-14288.json — get_postoffices_by_postindex?poCityId=14288
 *     (131 real Lviv offices, ~249KB — the documented size-risk shape);
 *   - office-by-postindex-01001.json — get_postoffices_by_postindex?pi=01001
 *     (single real office «Київ 1»).
 *
 * The provider is NOT trusted: strict id parsing, whitelist normalization,
 * active-record filter and the output cap are pinned here. The locked-
 * record case is covered with an explicitly SYNTHETIC record appended to a
 * copy of the real fixture — the live Lviv/Kyiv responses contained only
 * active records, so no real locked fixture exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  extractClassifierEntries,
  parseClassifierId,
  CLASSIFIER_MAX_ENTRIES,
} from '../app/lib/delivery/ukrposhta/classifier.ts';
import { normalizeSettlement } from '../app/lib/delivery/ukrposhta/settlements.ts';
import {
  normalizePostOffice,
  isActivePostOffice,
  POSTOFFICE_ACTIVE_MARKER,
  OFFICES_MAX,
} from '../app/lib/delivery/ukrposhta/offices.ts';
import { UkrposhtaError } from '../app/lib/delivery/ukrposhta/errors.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(path.join(root, 'tests/fixtures/ukrposhta', name), 'utf8')
  );

test('CLASSIFIER: regions fixture parses — 26 entries, string ids strict-parse', () => {
  const entries = extractClassifierEntries(fixture('regions.json'));
  assert.equal(entries.length, 26);
  for (const e of entries) {
    const id = parseClassifierId(e.REGION_ID);
    assert.ok(id !== null && id >= 1, `region id ${String(e.REGION_ID)}`);
    assert.equal(typeof e.REGION_UA, 'string');
  }
});

test('CLASSIFIER: no-match shape {"Entries":{}} is an empty list, not an error', () => {
  assert.deepEqual(extractClassifierEntries({ Entries: {} }), []);
  assert.deepEqual(extractClassifierEntries({ Entries: { Entry: [] } }), []);
});

test('CLASSIFIER: single-entry payload may collapse Entry to a bare object', () => {
  const one = extractClassifierEntries({
    Entries: { Entry: { ID: '2700', PO_SHORT: 'Київ 1' } },
  });
  assert.equal(one.length, 1);
  assert.equal(one[0]!.ID, '2700');
});

test('CLASSIFIER: non-document shapes are unexpected_response', () => {
  for (const bad of [null, 'xml', 42, {}, { Entries: 5 }, { Entries: { Entry: 5 } }]) {
    assert.throws(() => extractClassifierEntries(bad), UkrposhtaError);
  }
  // over the raw-entry safety cap
  const flood = Array.from({ length: CLASSIFIER_MAX_ENTRIES + 1 }, () => ({}));
  assert.throws(
    () => extractClassifierEntries({ Entries: { Entry: flood } }),
    UkrposhtaError
  );
});

test('CLASSIFIER: id parser is strict — no "1e2", " 5 ", 0, negatives, floats', () => {
  assert.equal(parseClassifierId('14288'), 14288);
  assert.equal(parseClassifierId(14288), 14288);
  for (const bad of ['1e2', ' 5 ', '0x10', '', '0', '-1', '1.5', 0, -1, 1.5, null, undefined, true]) {
    assert.equal(parseClassifierId(bad as unknown as string), null, String(bad));
  }
});

test('CLASSIFIER: city fixture — Львів found with numeric id and stable codes', () => {
  const entries = extractClassifierEntries(fixture('city-search-lviv.json'));
  assert.equal(entries.length, 7);
  const normalized = entries.map(normalizeSettlement).filter((s) => s !== null);
  const lviv = normalized.find((s) => s!.name === 'Львів' && s!.regionName === 'Львівська');
  assert.ok(lviv);
  assert.equal(lviv!.id, 14288);
  assert.equal(typeof lviv!.id, 'number');
  assert.match(lviv!.katottg ?? '', /^\d+$/);
  assert.match(lviv!.koatuu ?? '', /^\d+$/);
  // partial-name matches (Львівка) survive with their own regions
  assert.ok(normalized.some((s) => s!.name !== 'Львів'));
});

test('CLASSIFIER: offices fixture (real Lviv, 131 records) — active filter + cap 100', () => {
  const body = fixture('offices-by-poCityId-14288.json');
  const raw = extractClassifierEntries(body);
  assert.equal(raw.length, 131);
  const normalized: ReturnType<typeof normalizePostOffice>[] = [];
  for (const item of raw) {
    const o = normalizePostOffice(item);
    if (o) normalized.push(o);
  }
  // all real records are active; the parser keeps them all pre-cap…
  assert.equal(normalized.length, 131);
  // …and the route-level cap bounds the answer
  assert.ok(normalized.length > OFFICES_MAX);
  const capped = normalized.slice(0, OFFICES_MAX);
  assert.equal(capped.length, 100);
  for (const o of capped) {
    assert.ok(o && o.id >= 1);
    assert.ok(o.postIndex === null || /^\d{4,6}$/.test(o.postIndex));
  }
  const first = capped[0]!;
  assert.equal(first.id, 1176813); // П-т Епіцентр (1147) Львів 79155 — real first row
  assert.equal(first.postIndex, '79155');
  assert.ok((first.address ?? '').length > 0);
});

test('CLASSIFIER: post-index fixture — the real «Київ 1» office (ID 2700)', () => {
  const entries = extractClassifierEntries(fixture('office-by-postindex-01001.json'));
  assert.equal(entries.length, 1);
  const office = normalizePostOffice(entries[0]);
  assert.ok(office);
  assert.equal(office!.id, 2700);
  assert.equal(office!.shortName, 'Київ 1');
  assert.equal(office!.postIndex, '01001');
});

test('CLASSIFIER: non-active records can never pass normalization (synthetic lock)', () => {
  // The live Lviv fixture has only active rows; a SYNTHETIC locked row is
  // appended to a copy to pin the POLOCK_UA filter.
  const raw = extractClassifierEntries(fixture('offices-by-poCityId-14288.json'));
  const withLocked = [
    ...raw,
    { ID: '999999', PO_SHORT: 'ЗАЧИНЕНО', POLOCK_UA: 'Запис видалено', LOCK_CODE: '65535' },
    { ID: '999998', PO_SHORT: 'БЕЗ-мітки', POLOCK_UA: null },
  ];
  const offices = withLocked.map(normalizePostOffice).filter((o) => o !== null);
  assert.equal(offices.length, 131);
  assert.ok(!offices.some((o) => o.id === 999999));
  assert.ok(!offices.some((o) => o.id === 999998));
  // the filter itself is the exact active-marker contract
  assert.equal(POSTOFFICE_ACTIVE_MARKER, 'Активний запис');
  assert.equal(isActivePostOffice({ POLOCK_UA: 'Активний запис' }), true);
  assert.equal(isActivePostOffice({ POLOCK_UA: 'активний запис' }), false);
  assert.equal(isActivePostOffice({}), false);
  // an active record with an id but no display fields still normalizes
  // (display strings are optional), but a record without an id never does
  const minimal = normalizePostOffice({ ID: '1', POLOCK_UA: 'Активний запис' });
  assert.ok(minimal);
  assert.equal(minimal.id, 1);
  assert.equal(minimal.shortName, null);
  assert.equal(normalizePostOffice({ POLOCK_UA: 'Активний запис' }), null);
});
