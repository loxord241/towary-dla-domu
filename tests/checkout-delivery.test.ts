/**
 * Stage 2G — checkout delivery sanitizer (shipping_info.delivery).
 *
 * The guest checkout may send a structured Nova Post delivery object inside
 * shipping. Strict whitelist: strict integer ids, service-type whitelist,
 * per-type required fields, money/price-like keys structurally impossible.
 * The client can never override payerType or any cost — those fields do not
 * exist in the contract at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeDelivery } from '../app/lib/checkout-delivery.ts';

test('DELIVERY: absent/null input → no delivery object', () => {
  assert.equal(sanitizeDelivery(undefined).kind, 'absent');
  assert.equal(sanitizeDelivery(null).kind, 'absent');
});

test('DELIVERY: non-object input is rejected', () => {
  for (const bad of ['x', 42, [], true]) {
    assert.equal(sanitizeDelivery(bad).kind, 'invalid', String(bad));
  }
});

test('DELIVERY: warehouse requires settlementId + divisionId', () => {
  const ok = sanitizeDelivery({
    serviceType: 'nova_poshta_warehouse',
    settlementId: 119638,
    settlementName: 'місто Кривий Ріг',
    divisionId: 11654,
    divisionName: 'Відділення № 1',
  });
  assert.equal(ok.kind, 'ok');
  if (ok.kind === 'ok') {
    assert.deepEqual(ok.value, {
      serviceType: 'nova_poshta_warehouse',
      settlementId: 119638,
      settlementName: 'місто Кривий Ріг',
      divisionId: 11654,
      divisionName: 'Відділення № 1',
    });
  }

  assert.equal(
    sanitizeDelivery({ serviceType: 'nova_poshta_warehouse', settlementId: 1 }).kind,
    'invalid'
  );
});

test('DELIVERY: locker follows warehouse rules and keeps its type', () => {
  const ok = sanitizeDelivery({
    serviceType: 'nova_poshta_locker',
    settlementId: 118064,
    settlementName: 'місто Київ',
    divisionId: 9001,
  });
  assert.equal(ok.kind, 'ok');
  if (ok.kind === 'ok') {
    assert.equal(ok.value.serviceType, 'nova_poshta_locker');
    assert.equal(ok.value.divisionId, 9001);
    assert.equal('divisionName' in ok.value, false);
  }
});

test('DELIVERY: courier requires settlementId + street + building; flat optional', () => {
  const ok = sanitizeDelivery({
    serviceType: 'nova_poshta_courier',
    settlementId: 119638,
    settlementName: 'місто Кривий Ріг',
    streetId: 5694732,
    streetName: 'вул. Гетьмана Івана Мазепи',
    building: '64',
    flat: '12',
  });
  assert.equal(ok.kind, 'ok');

  assert.equal(
    sanitizeDelivery({
      serviceType: 'nova_poshta_courier',
      settlementId: 119638,
      streetName: 'вул. Хрещатик',
    }).kind,
    'invalid'
  );
  assert.equal(
    sanitizeDelivery({
      serviceType: 'nova_poshta_courier',
      settlementId: 119638,
      streetName: 'вул. Хрещатик',
    }).kind,
    'invalid'
  );
  assert.equal(
    sanitizeDelivery({
      serviceType: 'nova_poshta_courier',
      streetId: 1,
      streetName: 'вул. Хрещатик',
      building: '22',
    }).kind,
    'invalid'
  );
});

test('DELIVERY: ids are strict positive integers (no strings, no zero)', () => {
  const base = {
    serviceType: 'nova_poshta_warehouse',
    settlementId: 119638,
    settlementName: 'x',
    divisionId: 1,
  };
  for (const bad of [0, -3, 1.5, '119638', null, true]) {
    assert.equal(
      sanitizeDelivery({ ...base, settlementId: bad }).kind,
      'invalid',
      `settlementId=${String(bad)}`
    );
    assert.equal(
      sanitizeDelivery({ ...base, divisionId: bad }).kind,
      'invalid',
      `divisionId=${String(bad)}`
    );
  }
  const courier = {
    serviceType: 'nova_poshta_courier',
    settlementId: 1,
    streetName: 's',
    building: '1',
  };
  assert.equal(sanitizeDelivery({ ...courier, streetId: 'x' }).kind, 'invalid');
});

test('DELIVERY: unknown serviceType rejected', () => {
  assert.equal(
    sanitizeDelivery({
      serviceType: 'nova_poshta_express',
      settlementId: 1,
      divisionId: 1,
    }).kind,
    'invalid'
  );
  assert.equal(
    sanitizeDelivery({ settlementId: 1, divisionId: 1 }).kind,
    'invalid'
  );
});

test('DELIVERY: unknown keys are rejected (strict whitelist)', () => {
  assert.equal(
    sanitizeDelivery({
      serviceType: 'nova_poshta_warehouse',
      settlementId: 1,
      settlementName: 'x',
      divisionId: 1,
      payerType: 'Sender',
      cost: 0,
    }).kind,
    'invalid'
  );
});

test('DELIVERY: money/price-like keys can never enter the contract', () => {
  for (const key of ['total', 'amount', 'price', 'discount', 'cod_amount', 'payerType']) {
    const res = sanitizeDelivery({
      serviceType: 'nova_poshta_courier',
      settlementId: 1,
      settlementName: 'x',
      streetName: 's',
      building: '1',
      [key]: 100,
    });
    assert.equal(res.kind, 'invalid', key);
  }
});

test('DELIVERY: text fields are trimmed, length-capped, empty → absent', () => {
  const ok = sanitizeDelivery({
    serviceType: 'nova_poshta_courier',
    settlementId: 119638,
    settlementName: '  місто Кривий Ріг  ',
    streetName: 'вул. Хрещатик',
    building: '22',
    flat: '  ',
  });
  assert.equal(ok.kind, 'ok');
  if (ok.kind === 'ok') {
    assert.equal(ok.value.settlementName, 'місто Кривий Ріг');
    assert.equal('flat' in ok.value, false);
  }

  const tooLong = sanitizeDelivery({
    serviceType: 'nova_poshta_warehouse',
    settlementId: 1,
    settlementName: 'в'.repeat(201),
    divisionId: 1,
  });
  assert.equal(tooLong.kind, 'invalid');
});
