/**
 * Stage 2G — admin shipment plan prefill from the structured checkout
 * delivery choice (orders.shipping_info.delivery).
 *
 * Rules:
 *   - prefill only when the plan is EMPTY (never overwrite a manual plan);
 *   - warehouse AND locker map to service_type 'nova_poshta_warehouse'
 *     (the locker distinction lives in the NP divisionCategory);
 *   - courier maps to 'nova_poshta_courier' with structured street parts;
 *   - display address is composed for the human-readable `address` field;
 *   - malformed checkout data is ignored (never throws, never blocks).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prefillShipmentDraft } from '../app/lib/admin-shipment-prefill.ts';

test('PREFILL: warehouse checkout delivery becomes a planned shipment row', () => {
  const rows = prefillShipmentDraft({
    delivery: {
      serviceType: 'nova_poshta_warehouse',
      settlementId: 119638,
      settlementName: 'місто Кривий Ріг',
      divisionId: 11654,
      divisionName: 'Відділення № 1',
    },
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    service_type: 'nova_poshta_warehouse',
    city_ref: '119638',
    city_name: 'місто Кривий Ріг',
    warehouse_ref: '11654',
    warehouse_name: 'Відділення № 1',
    address: null,
    street_name: null,
    building: null,
    flat: null,
  });
});

test('PREFILL: locker keeps nova_poshta_warehouse service type in the DB', () => {
  const rows = prefillShipmentDraft({
    delivery: {
      serviceType: 'nova_poshta_locker',
      settlementId: 118064,
      settlementName: 'місто Київ',
      divisionId: 9001,
      divisionName: 'Поштомат № 9001',
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.service_type, 'nova_poshta_warehouse');
  assert.equal(rows[0]!.warehouse_ref, '9001');
});

test('PREFILL: courier keeps structured address + composes the display address', () => {
  const rows = prefillShipmentDraft({
    delivery: {
      serviceType: 'nova_poshta_courier',
      settlementId: 119638,
      settlementName: 'місто Кривий Ріг',
      streetId: 5694732,
      streetName: 'вул. Гетьмана Івана Мазепи',
      building: '64',
      flat: '12',
    },
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.service_type, 'nova_poshta_courier');
  assert.equal(row.city_ref, '119638');
  assert.equal(row.warehouse_ref, null);
  assert.equal(row.street_name, 'вул. Гетьмана Івана Мазепи');
  assert.equal(row.building, '64');
  assert.equal(row.flat, '12');
  assert.equal(row.address, 'вул. Гетьмана Івана Мазепи, 64, кв. 12');
});

test('PREFILL: courier display address without flat has no flat suffix', () => {
  const rows = prefillShipmentDraft({
    delivery: {
      serviceType: 'nova_poshta_courier',
      settlementId: 118064,
      settlementName: 'місто Київ',
      streetName: 'вул. Хрещатик',
      building: '22',
    },
  });
  assert.equal(rows[0]!.address, 'вул. Хрещатик, 22');
});

test('PREFILL: malformed checkout delivery is ignored (empty prefill)', () => {
  for (const bad of [
    null,
    {},
    { delivery: { serviceType: 'nova_poshta_warehouse' } },
    { delivery: { serviceType: 'junk', settlementId: 1 } },
    { delivery: { serviceType: 'nova_poshta_courier', settlementId: 'x' } },
    { delivery: { serviceType: 'nova_poshta_warehouse', settlementId: 1 } },
  ]) {
    assert.deepEqual(prefillShipmentDraft(bad as never), [], JSON.stringify(bad));
  }
});
