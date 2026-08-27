/**
 * Nova Post validation/normalization invariants (pure functions, no HTTP).
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSettlementsQuery,
  normalizeSettlement,
} from '../app/lib/delivery/novapost/settlements.ts';
import {
  parseDivisionsQuery,
  normalizeDivision,
} from '../app/lib/delivery/novapost/divisions.ts';
import {
  parseDeliveryCostBody,
} from '../app/lib/delivery/novapost/delivery-cost.ts';

function params(entries: Record<string, string>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) sp.set(k, v);
  return sp;
}

describe('settlements query parsing', () => {
  test('defaults apply; limits enforced', () => {
    const q = parseSettlementsQuery(params({ q: 'Львів' }));
    assert.deepEqual(q, { query: 'Львів', limit: 10, page: 1 });

    assert.equal(parseSettlementsQuery(params({ q: 'Л' })), null, 'too short');
    assert.equal(parseSettlementsQuery(params({ q: 'Львів', limit: '0' })), null);
    assert.equal(parseSettlementsQuery(params({ q: 'Львів', limit: '51' })), null);
    assert.equal(parseSettlementsQuery(params({ q: 'Львів', limit: 'abc' })), null);
    assert.equal(parseSettlementsQuery(params({ q: 'Львів', page: '0' })), null);
    assert.equal(parseSettlementsQuery(params({})), null);
  });
});

describe('divisions query parsing', () => {
  test('settlementId must be a positive integer', () => {
    assert.deepEqual(parseDivisionsQuery(params({ settlementId: '7312' })), {
      settlementId: 7312,
      limit: 50,
      page: 1,
    });
    assert.equal(parseDivisionsQuery(params({})), null);
    assert.equal(parseDivisionsQuery(params({ settlementId: '-1' })), null);
    assert.equal(parseDivisionsQuery(params({ settlementId: 'x' })), null);
    assert.equal(parseDivisionsQuery(params({ settlementId: '1.5' })), null);
    assert.equal(parseDivisionsQuery(params({ settlementId: '1', limit: '101' })), null);
  });
});

describe('settlement/division normalization (provider untrusted)', () => {
  test('settlement: only documented fields survive; junk is dropped', () => {
    const normalized = normalizeSettlement({
      id: 12,
      name: 'Київ',
      region: { id: 3, name: 'Київська', parent: { id: 2, name: 'Київщина' } },
      secretInternalField: 'drop-me',
      alternativeNames: ['Kyiv'],
      apiKey: 'spoofed-key',
    });
    assert.deepEqual(normalized, {
      id: 12,
      name: 'Київ',
      regionName: 'Київська',
      regionParentName: 'Київщина',
    });
    assert.equal(normalized && JSON.stringify(normalized).includes('drop-me'), false);
    assert.equal(normalizeSettlement({ id: 0, name: 'X' }), null);
    assert.equal(normalizeSettlement({ id: 5 }), null);
    assert.equal(normalizeSettlement('string'), null);
  });

  test('division: weights must be sane numbers or null', () => {
    const d = normalizeDivision({
      id: 77,
      name: 'Відділення №1',
      shortName: 'Відд. 1',
      address: 'вул. Хрещатик, 22',
      number: '1',
      divisionCategory: 'PostBranch',
      maxWeightPlaceSender: 30000,
      maxWeightPlaceRecipient: 'junk',
      extra: 'ignored',
    });
    assert.ok(d);
    assert.equal(d.maxWeightPlaceSenderGrams, 30000);
    assert.equal(d.maxWeightPlaceRecipientGrams, null);
    assert.equal(d.category, 'PostBranch');
    assert.equal(normalizeDivision({ id: 1 }), null);
    assert.equal(normalizeDivision(null), null);
  });
});

describe('delivery-cost body parsing', () => {
  const validParcel = {
    cargoCategory: 'parcel',
    actualWeightGrams: 1500,
    widthMm: 200,
    lengthMm: 300,
    heightMm: 150,
  };

  test('valid division destination and valid address destination', () => {
    assert.deepEqual(
      parseDeliveryCostBody({
        parcels: [validParcel],
        recipientDivisionId: 42,
      })?.recipientDivisionId,
      42
    );
    const addr = parseDeliveryCostBody({
      parcels: [{ cargoCategory: 'parcel', actualWeightGrams: 500 }],
      recipientAddress: {
        city: 'Київ',
        street: 'Хрещатик',
        building: '22',
        flat: '5',
        postCode: '01001',
      },
    });
    assert.ok(addr?.recipientAddress);
    assert.equal(addr.recipientDivisionId, null);
  });

  test('weight: grams, multiple of 10, >= 10 (docs rounding rule enforced)', () => {
    assert.equal(
      parseDeliveryCostBody({
        parcels: [{ cargoCategory: 'parcel', actualWeightGrams: 1503 }],
        recipientDivisionId: 1,
      }),
      null
    );
    assert.equal(
      parseDeliveryCostBody({
        parcels: [{ cargoCategory: 'parcel', actualWeightGrams: 5 }],
        recipientDivisionId: 1,
      }),
      null
    );
    assert.equal(
      parseDeliveryCostBody({
        parcels: [{ cargoCategory: 'parcel', actualWeightGrams: -10 }],
        recipientDivisionId: 1,
      }),
      null
    );
  });

  test('dimensions: all-or-none, positive integers (mm)', () => {
    assert.equal(
      parseDeliveryCostBody({
        parcels: [{ cargoCategory: 'parcel', actualWeightGrams: 10, widthMm: 5 }],
        recipientDivisionId: 1,
      }),
      null
    );
    assert.ok(
      parseDeliveryCostBody({
        parcels: [
          { cargoCategory: 'parcel', actualWeightGrams: 10, widthMm: 5, lengthMm: 5, heightMm: 5 },
        ],
        recipientDivisionId: 1,
      })
    );
  });

  test('XOR: division AND address together is rejected', () => {
    assert.equal(
      parseDeliveryCostBody({
        parcels: [validParcel],
        recipientDivisionId: 42,
        recipientAddress: { city: 'a', street: 'b', building: 'c' },
      }),
      null
    );
  });

  test('neither destination, no parcels, bad category, bad insurance -> null', () => {
    assert.equal(parseDeliveryCostBody({ parcels: [validParcel] }), null);
    assert.equal(parseDeliveryCostBody({ recipientDivisionId: 1 }), null);
    assert.equal(
      parseDeliveryCostBody({
        parcels: [{ cargoCategory: 'mystery', actualWeightGrams: 10 }],
        recipientDivisionId: 1,
      }),
      null
    );
    assert.equal(
      parseDeliveryCostBody({
        parcels: [{ cargoCategory: 'parcel', actualWeightGrams: 10, insuranceCost: -1 }],
        recipientDivisionId: 1,
      }),
      null
    );
    assert.equal(parseDeliveryCostBody(null), null);
    assert.equal(parseDeliveryCostBody('str'), null);
  });

  test('client cannot override payerType or country codes', () => {
    const parsed = parseDeliveryCostBody({
      parcels: [validParcel],
      recipientDivisionId: 42,
      payerType: 'Sender',
      sender: { countryCode: 'PL' },
      recipient: { countryCode: 'PL' },
    });
    assert.ok(parsed);
    // parser only whitelists known fields; payerType/sender exist nowhere
    assert.equal('payerType' in parsed, false);
    assert.equal('sender' in parsed, false);
  });
});
