/**
 * Stage 2G — courier TTN payload support in the Stage 2F builder.
 *
 * The provider validator for POST /shipments shares the same recipient
 * branches as /shipments/calculations (sandbox-confirmed by the 422
 * validator listing), so the courier recipient is built as
 * { settlementId, addressParts{city?, street, building, flat?} } — the same
 * live-verified locator as the calculation. NO live POST is performed here;
 * the first courier TTN must be created against the sandbox and reconciled
 * via clientOrder (the orchestration already does adopt/rollback).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildShipmentTtnPayload,
  type TtnSourceShipment,
} from '../app/lib/admin-shipments-ttn.ts';

const SENDER = { divisionId: 11654, name: 'Магазин', phone: '380671234567' };

const base: TtnSourceShipment = {
  shipment_id: '0189f4a0-1111-7222-8333-00000000bb01',
  status: 'planned',
  service_type: 'nova_poshta_warehouse',
  city_ref: null,
  city_name: null,
  warehouse_ref: '11654',
  street_name: null,
  building: null,
  flat: null,
  parcels: [
    {
      parcel_index: 1,
      cargo_category: 'parcel',
      actual_weight_grams: 1000,
      width_mm: 100,
      length_mm: 200,
      height_mm: 150,
      insurance_cost: 500,
    },
  ],
  productNames: ['Тестовий товар'],
  recipientName: 'Тест Тестович',
  recipientPhone: '+380501234567',
};

test('TTN-COURIER: courier shipment builds recipient.settlementId + addressParts', () => {
  const built = buildShipmentTtnPayload(
    {
      ...base,
      service_type: 'nova_poshta_courier',
      warehouse_ref: null,
      city_ref: '119638',
      city_name: 'місто Кривий Ріг',
      street_name: 'вул. Гетьмана Івана Мазепи',
      building: '64',
      flat: '12',
    },
    SENDER
  );
  assert.ok(built.ok, built.ok ? '' : built.reason);
  if (built.ok) {
    const recipient = built.payload.recipient as Record<string, unknown>;
    assert.equal(recipient.countryCode, 'UA');
    assert.equal(recipient.settlementId, 119638);
    assert.equal(recipient.divisionId, undefined);
    const parts = recipient.addressParts as Record<string, unknown>;
    assert.equal(parts.city, 'місто Кривий Ріг');
    assert.equal(parts.street, 'вул. Гетьмана Івана Мазепи');
    assert.equal(parts.building, '64');
    assert.equal(parts.flat, '12');
    // payerType stays Recipient — delivery is paid by the buyer.
    assert.equal(built.payload.payerType, 'Recipient');
    assert.equal(built.clientOrder, base.shipment_id);
  }
});

test('TTN-COURIER: courier requires settlementId + street + building (fail-closed)', () => {
  const noSettlement = buildShipmentTtnPayload(
    {
      ...base,
      service_type: 'nova_poshta_courier',
      warehouse_ref: null,
      city_ref: null,
      street_name: 'вул. Хрещатик',
      building: '22',
    },
    SENDER
  );
  assert.ok(!noSettlement.ok);

  const noStreet = buildShipmentTtnPayload(
    {
      ...base,
      service_type: 'nova_poshta_courier',
      warehouse_ref: null,
      city_ref: '119638',
      street_name: null,
      building: '22',
    },
    SENDER
  );
  assert.ok(!noStreet.ok);

  const noBuilding = buildShipmentTtnPayload(
    {
      ...base,
      service_type: 'nova_poshta_courier',
      warehouse_ref: null,
      city_ref: '119638',
      street_name: 'вул. Хрещатик',
      building: '',
    },
    SENDER
  );
  assert.ok(!noBuilding.ok);
});

test('TTN-COURIER: flat omitted from payload when absent', () => {
  const built = buildShipmentTtnPayload(
    {
      ...base,
      service_type: 'nova_poshta_courier',
      warehouse_ref: null,
      city_ref: '118064',
      city_name: 'місто Київ',
      street_name: 'вул. Хрещатик',
      building: '22',
    },
    SENDER
  );
  assert.ok(built.ok);
  if (built.ok) {
    const parts = (built.payload.recipient as Record<string, unknown>)
      .addressParts as Record<string, unknown>;
    assert.equal('flat' in parts, false);
  }
});

test('TTN-WAREHOUSE: warehouse payload unchanged (divisionId, no settlementId)', () => {
  const built = buildShipmentTtnPayload(base, SENDER);
  assert.ok(built.ok, built.ok ? '' : built.reason);
  if (built.ok) {
    const recipient = built.payload.recipient as Record<string, unknown>;
    assert.equal(recipient.divisionId, 11654);
    assert.equal('settlementId' in recipient, false);
    assert.equal('addressParts' in recipient, false);
  }
});
