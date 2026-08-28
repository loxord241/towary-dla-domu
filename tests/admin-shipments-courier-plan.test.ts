/**
 * Stage 2G — shipment plan payload: structured courier address fields
 * (street_name / building / flat). Mirrors migration 026 + the extended
 * admin_replace_shipment_plan RPC contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseShipmentPlanPayload } from '../app/lib/admin-shipments.ts';

const baseShipment = {
  shipment_index: 1,
  city_ref: '119638',
  city_name: 'місто Кривий Ріг',
  cod_amount: '100.50',
  items: [{ order_item_id: '0189f4a0-1111-7222-8333-000000000001', quantity: '1' }],
  parcels: [],
};

test('PLAN-COURIER: courier accepts structured address parts', () => {
  const res = parseShipmentPlanPayload({
    shipments: [
      {
        ...baseShipment,
        service_type: 'nova_poshta_courier',
        address: 'вул. Гетьмана Івана Мазепи, 64, кв. 12',
        street_name: 'вул. Гетьмана Івана Мазепи',
        building: '64',
        flat: '12',
      },
    ],
  });
  assert.ok(res.ok, res.ok ? '' : res.error);
  if (res.ok) {
    assert.equal(res.plan.shipments[0].street_name, 'вул. Гетьмана Івана Мазепи');
    assert.equal(res.plan.shipments[0].building, '64');
    assert.equal(res.plan.shipments[0].flat, '12');
  }
});

test('PLAN-COURIER: structured fields are optional for courier (legacy plans keep working)', () => {
  const res = parseShipmentPlanPayload({
    shipments: [
      {
        ...baseShipment,
        service_type: 'nova_poshta_courier',
        address: 'вул. Хрещатик, 22',
      },
    ],
  });
  assert.ok(res.ok, res.ok ? '' : res.error);
  if (res.ok) {
    assert.equal(res.plan.shipments[0].street_name, null);
    assert.equal(res.plan.shipments[0].building, null);
    assert.equal(res.plan.shipments[0].flat, null);
  }
});

test('PLAN-COURIER: warehouse must not carry courier address parts', () => {
  for (const extra of [
    { street_name: 'вул. Хрещатик' },
    { building: '22' },
    { flat: '5' },
  ]) {
    const res = parseShipmentPlanPayload({
      shipments: [
        {
          ...baseShipment,
          service_type: 'nova_poshta_warehouse',
          warehouse_ref: '11654',
          warehouse_name: 'Відділення № 1',
          ...extra,
        },
      ],
    });
    assert.equal(res.ok, false, JSON.stringify(extra));
  }
});

test('PLAN-COURIER: courier still requires a display address', () => {
  const res = parseShipmentPlanPayload({
    shipments: [
      {
        ...baseShipment,
        service_type: 'nova_poshta_courier',
        street_name: 'вул. Хрещатик',
        building: '22',
      },
    ],
  });
  assert.equal(res.ok, false);
});

test('PLAN-COURIER: length caps (street 100, building 100, flat 10)', () => {
  const res = parseShipmentPlanPayload({
    shipments: [
      {
        ...baseShipment,
        service_type: 'nova_poshta_courier',
        address: 'a',
        street_name: 'в'.repeat(101),
      },
    ],
  });
  assert.equal(res.ok, false);

  const res2 = parseShipmentPlanPayload({
    shipments: [
      {
        ...baseShipment,
        service_type: 'nova_poshta_courier',
        address: 'a',
        flat: '1'.repeat(11),
      },
    ],
  });
  assert.equal(res2.ok, false);

  const ok = parseShipmentPlanPayload({
    shipments: [
      {
        ...baseShipment,
        service_type: 'nova_poshta_courier',
        address: 'a',
        street_name: 'в'.repeat(100),
        building: 'б'.repeat(100),
        flat: '1'.repeat(10),
      },
    ],
  });
  assert.ok(ok.ok, ok.ok ? '' : ok.error);
});
