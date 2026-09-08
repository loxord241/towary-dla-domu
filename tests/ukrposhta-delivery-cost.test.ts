/**
 * Ukrposhta Ecom /domestic/delivery-price — pure planning + normalization.
 *
 * Unit contract (our route): grams + millimeters in, UAH out. The mm → cm
 * conversion happens in exactly one documented place (toProviderBody) and
 * its precision loss (≤ 5 mm per side) is pinned. The provider body is
 * Bearer-only and has NO public sandbox, so the wire contract could not be
 * live-verified — the fixed server-side fields (type/deliveryType) and the
 * whitelist normalization are pinned here instead; no fake price can ever
 * be produced from an unexpected response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDeliveryCostBody,
  toProviderBody,
  normalizeQuote,
  convertMmToCm,
  calculateDeliveryCost,
} from '../app/lib/delivery/ukrposhta/delivery-cost.ts';
import { UkrposhtaError, isUkrposhtaError } from '../app/lib/delivery/ukrposhta/errors.ts';

const VALID = {
  recipientPostIndex: '79000',
  weightGrams: 1500,
  widthMm: 300,
  lengthMm: 400,
  heightMm: 250,
  declaredPriceUah: 1999.99,
};

test('COST: parse accepts the valid body (mm + grams in)', () => {
  const parsed = parseDeliveryCostBody(VALID);
  assert.deepEqual(parsed, VALID);
});

test('COST: dimensions are all-or-none and strictly positive integer mm', () => {
  assert.equal(
    parseDeliveryCostBody({ ...VALID, widthMm: 300, heightMm: undefined }),
    null,
    'partial trio rejected'
  );
  assert.equal(parseDeliveryCostBody({ ...VALID, widthMm: 0 }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, widthMm: 300.5 }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, widthMm: '300' }), null);
  const noDims = parseDeliveryCostBody({
    recipientPostIndex: '79000',
    weightGrams: 1500,
    declaredPriceUah: 100,
  });
  assert.ok(noDims);
  assert.equal(noDims.widthMm, null);
});

test('COST: weight is positive integer grams with a sane ceiling', () => {
  assert.equal(parseDeliveryCostBody({ ...VALID, weightGrams: 0 }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, weightGrams: -100 }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, weightGrams: 1500.5 }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, weightGrams: '1500' }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, weightGrams: 600_000 }), null);
});

test('COST: post index is exactly 5 digits; declaredPrice is finite ≥ 0 UAH', () => {
  assert.equal(parseDeliveryCostBody({ ...VALID, recipientPostIndex: '7900' }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, recipientPostIndex: '790000' }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, recipientPostIndex: '7900a' }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, declaredPriceUah: -1 }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, declaredPriceUah: NaN }), null);
  assert.equal(parseDeliveryCostBody({ ...VALID, declaredPriceUah: Infinity }), null);
  assert.equal(parseDeliveryCostBody(null), null);
  assert.equal(parseDeliveryCostBody('x'), null);
});

test('COST: mm → cm conversion rounds and rejects sub-5mm sides', () => {
  assert.equal(convertMmToCm(104), 10);
  assert.equal(convertMmToCm(105), 11); // rounding, not truncation
  assert.equal(convertMmToCm(10), 1);
  assert.equal(convertMmToCm(4), null);
  assert.equal(convertMmToCm(0), null);
});

test('COST: provider body converts to cm/grams, sender postcode and fixed flags server-side', () => {
  const body = toProviderBody(VALID, '50000') as Record<string, unknown>;
  assert.deepEqual(body.addressFrom, { postcode: '50000' });
  assert.deepEqual(body.addressTo, { postcode: '79000' });
  assert.equal(body.weight, 1500); // grams pass through untouched
  assert.equal(body.width, 30);   // 300 mm → 30 cm
  assert.equal(body.length, 40);  // 400 mm → 40 cm
  assert.equal(body.height, 25);  // 250 mm → 25 cm exactly
  assert.equal(body.declaredPrice, 1999.99);
  assert.equal(body.type, 'STANDARD');
  assert.equal(body.deliveryType, 'W2W'); // MVP: office → office only, fixed
});

test('COST: a sub-5mm side is a typed invalid_input, never a broken payload', () => {
  assert.throws(
    () => toProviderBody({ ...VALID, widthMm: 3 }, '50000'),
    (e: unknown) => isUkrposhtaError(e) && e.kind === 'invalid_input'
  );
});

test('COST: quote normalization is a strict whitelist — no fake price from junk', () => {
  const q = normalizeQuote({
    deliveryPrice: 55.5,
    rawDeliveryPrice: 60,
    calculationDescription: 'Доставка: 55.50 грн',
    junk: 'ignored',
  });
  assert.equal(q.deliveryPriceUah, 55.5);
  assert.equal(q.rawDeliveryPriceUah, 60);
  assert.equal(q.calculationDescription, 'Доставка: 55.50 грн');

  for (const bad of [
    null,
    {},
    { deliveryPrice: '55' },
    { deliveryPrice: -1 },
    { deliveryPrice: NaN },
    { deliveryPrice: Infinity },
  ]) {
    assert.throws(() => normalizeQuote(bad), UkrposhtaError, JSON.stringify(bad));
  }
});

test('COST: calculateDeliveryCost posts to domestic/delivery-price and normalizes', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const client = {
    classifierGet: async () => {
      throw new Error('must not be called');
    },
    ecomPost: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { deliveryPrice: 78.0, rawDeliveryPrice: null };
    },
  };
  const quote = await calculateDeliveryCost(client, VALID, '50000');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, 'domestic/delivery-price');
  assert.equal(quote.deliveryPriceUah, 78.0);
  assert.equal(quote.rawDeliveryPriceUah, null);
});
