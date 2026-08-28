/* eslint-disable @typescript-eslint/no-explicit-any -- provider body assertions need dynamic property access */
/**
 * Stage 2G — Stage 2E courier calculation. The courier branch resolves the
 * recipient via recipientSettlementId (from city_ref) + structured address
 * parts (migration 026); the warehouse branch is unchanged. Both flow
 * through the same calculateDeliveryCost / selectDeliveryService pipeline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCalculationInput,
  selectDeliveryService,
} from '../app/lib/admin-shipments-calc.ts';
import { toProviderBody } from '../app/lib/delivery/novapost/delivery-cost.ts';
import type { ShipmentForCalc } from '../app/lib/admin-shipments-calc.ts';

const parcelRow = {
  parcel_index: 1,
  cargo_category: 'parcel',
  actual_weight_grams: 1000,
  width_mm: 100,
  length_mm: 200,
  height_mm: 150,
  insurance_cost: 500,
};

const courierShipment: ShipmentForCalc = {
  shipment_id: '0189f4a0-1111-7222-8333-00000000aa01',
  shipment_index: 1,
  status: 'planned',
  service_type: 'nova_poshta_courier',
  city_ref: '119638',
  city_name: 'місто Кривий Ріг',
  warehouse_ref: null,
  street_name: 'вул. Гетьмана Івана Мазепи',
  building: '64',
  flat: '12',
  parcels: [parcelRow],
};

test('CALC-2E: courier planned shipment builds a settlementId-based input', () => {
  const built = buildCalculationInput(courierShipment);
  assert.ok(built.ok, built.ok ? '' : built.reason);
  if (built.ok) {
    assert.equal(built.input.recipientSettlementId, 119638);
    assert.equal(built.input.recipientDivisionId, null);
    assert.equal(built.input.recipientAddress!.street, 'вул. Гетьмана Івана Мазепи');
    assert.equal(built.input.recipientAddress!.building, '64');
    assert.equal(built.input.recipientAddress!.flat, '12');
    assert.equal(built.input.recipientAddress!.city, 'місто Кривий Ріг');
  }
});

test('CALC-2E: courier provider body carries recipient.settlementId (never free-text city resolution)', () => {
  const built = buildCalculationInput(courierShipment);
  assert.ok(built.ok);
  if (built.ok) {
    const body = toProviderBody(built.input, 11654) as Record<string, any>;
    assert.equal(body.recipient.settlementId, 119638);
    assert.equal(body.recipient.addressParts.city, 'місто Кривий Ріг');
    assert.equal(body.recipient.addressParts.street, 'вул. Гетьмана Івана Мазепи');
    assert.equal(body.payerType, 'Recipient');
  }
});

test('CALC-2E: courier without street/building is skipped (fail-closed)', () => {
  const noStreet = buildCalculationInput({
    ...courierShipment,
    street_name: null,
  });
  assert.equal(noStreet.ok, false);

  const noBuilding = buildCalculationInput({
    ...courierShipment,
    building: null,
  });
  assert.equal(noBuilding.ok, false);
});

test('CALC-2E: courier with bad settlement (city_ref) is skipped', () => {
  const bad = buildCalculationInput({
    ...courierShipment,
    city_ref: 'not-a-number',
  });
  assert.equal(bad.ok, false);
});

test('CALC-2E: courier without parcels is skipped', () => {
  const noParcels = buildCalculationInput({
    ...courierShipment,
    parcels: [],
  });
  assert.equal(noParcels.ok, false);
});

test('CALC-2E: courier past planned status is skipped', () => {
  const created = buildCalculationInput({
    ...courierShipment,
    status: 'created',
  });
  assert.equal(created.ok, false);
});

test('CALC-2E: warehouse branch unchanged (no settlementId, divisionId used)', () => {
  const built = buildCalculationInput({
    ...courierShipment,
    service_type: 'nova_poshta_warehouse',
    warehouse_ref: '11654',
    street_name: null,
    building: null,
    flat: null,
  });
  assert.ok(built.ok, built.ok ? '' : built.reason);
  if (built.ok) {
    assert.equal(built.input.recipientDivisionId, 11654);
    assert.equal(built.input.recipientSettlementId, null);
    assert.equal(built.input.recipientAddress, null);
  }
});

test('CALC-2E: service selection is shared by both branches', () => {
  const selection = selectDeliveryService({
    scheduledDeliveryDate: null,
    recipientSettlementId: 119638,
    recipientDivisionId: null,
    services: [{ deliveryTypeName: 'Doors', serviceName: null, amount: 1, price: 85.5, discount: null, cost: 85.5, paymentStatus: null }],
  });
  assert.ok(selection.ok);
  if (selection.ok) assert.equal(selection.cost, 85.5);
});
