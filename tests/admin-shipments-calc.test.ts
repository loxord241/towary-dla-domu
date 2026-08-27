/**
 * Stage 2E — admin delivery cost calculation (warehouse-only) invariants.
 * Pure functions + env config, no HTTP. Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCalculationInput,
  selectDeliveryService,
  type ShipmentForCalc,
} from '../app/lib/admin-shipments-calc.ts';
import {
  NOVA_POST_SENDER_DIVISION_ID_ENV,
  readNovaPostSenderDivisionId,
} from '../app/lib/delivery/novapost/config.ts';
import { toProviderBody } from '../app/lib/delivery/novapost/delivery-cost.ts';
import type { NpDeliveryQuote } from '../app/lib/delivery/novapost/types.ts';

function shipment(overrides: Partial<ShipmentForCalc> = {}): ShipmentForCalc {
  return {
    shipment_id: 'aaaaaaaa-0000-0000-0000-0000000000e1',
    shipment_index: 1,
    status: 'planned',
    service_type: 'nova_poshta_warehouse',
    warehouse_ref: '11198',
    parcels: [
      {
        parcel_index: 1,
        cargo_category: 'parcel',
        actual_weight_grams: 5000,
        width_mm: 400,
        length_mm: 300,
        height_mm: 200,
        insurance_cost: 1000,
      },
    ],
    ...overrides,
  };
}

describe('buildCalculationInput', () => {
  test('warehouse shipment with parcels builds a valid calculation input', () => {
    const res = buildCalculationInput(shipment());
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.input.recipientDivisionId, 11198);
    assert.equal(res.input.recipientAddress, null);
    assert.equal(res.input.parcels.length, 1);
    assert.deepEqual(res.input.parcels[0], {
      cargoCategory: 'parcel',
      rowNumber: 1,
      actualWeightGrams: 5000,
      widthMm: 400,
      lengthMm: 300,
      heightMm: 200,
      insuranceCost: 1000,
    });
  });

  test('skips non-planned shipments', () => {
    const res = buildCalculationInput(shipment({ status: 'created' }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, 'not_planned');
  });

  test('skips courier shipments (courier calculation not implemented)', () => {
    const res = buildCalculationInput(
      shipment({ service_type: 'nova_poshta_courier', warehouse_ref: null })
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, 'courier_not_supported');
  });

  test('skips shipments without parcels', () => {
    const res = buildCalculationInput(shipment({ parcels: [] }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, 'no_parcels');
  });

  test('skips warehouse shipment with a bad warehouse_ref', () => {
    for (const ref of [null, '', 'abc', '0', '-5']) {
      const res = buildCalculationInput(shipment({ warehouse_ref: ref }));
      assert.equal(res.ok, false, `ref=${ref}`);
      if (!res.ok) assert.equal(res.reason, 'bad_destination', `ref=${ref}`);
    }
  });

  test('parcel rowNumber follows parcel_index from the DB', () => {
    const res = buildCalculationInput(
      shipment({
        parcels: [
          {
            parcel_index: 1,
            cargo_category: 'pallet',
            actual_weight_grams: 100000,
            width_mm: 1200,
            length_mm: 800,
            height_mm: 1800,
            insurance_cost: 5000,
          },
        ],
      })
    );
    assert.ok(res.ok, JSON.stringify(res));
    if (res.ok) {
      assert.equal(res.input.parcels[0].cargoCategory, 'pallet');
      assert.equal(res.input.parcels[0].insuranceCost, 5000);
    }
  });
});

describe('selectDeliveryService (fail-closed single-row rule)', () => {
  const quote = (services: NpDeliveryQuote['services']): NpDeliveryQuote => ({
    scheduledDeliveryDate: '2026-09-01T12:00:00Z',
    recipientSettlementId: 118064,
    recipientDivisionId: 11198,
    services,
  });

  test('exactly one valid service row → its cost', () => {
    const res = selectDeliveryService(
      quote([{ deliveryTypeName: null, serviceName: null, amount: null, price: 30, discount: 0, cost: 30, paymentStatus: 'NeedPay' }])
    );
    assert.ok(res.ok, JSON.stringify(res));
    if (res.ok) {
      assert.equal(res.cost, 30);
      assert.equal(res.scheduledDeliveryDate, '2026-09-01T12:00:00Z');
    }
  });

  test('zero rows → fail-closed', () => {
    const res = selectDeliveryService(quote([]));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, 'no_services');
  });

  test('more than one row → fail-closed (ambiguous)', () => {
    const row = { deliveryTypeName: 'standard', serviceName: null, amount: null, price: 30, discount: 0, cost: 30, paymentStatus: 'NeedPay' };
    const res = selectDeliveryService(quote([row, { ...row, cost: 50 }]));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, 'ambiguous_services');
  });

  test('never picks a row with non-finite or negative cost', () => {
    const bad = (cost: unknown) => ({
      deliveryTypeName: null, serviceName: null, amount: null, price: null, discount: null, cost, paymentStatus: null,
    });
    const res = selectDeliveryService(quote([bad(-1) as never, bad(Number.NaN) as never]));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, 'no_services');
  });
});

describe('toProviderBody sender division (live-verified requirement)', () => {
  const input = {
    parcels: [
      {
        cargoCategory: 'parcel' as const,
        rowNumber: 1,
        actualWeightGrams: 5000,
        widthMm: 400,
        lengthMm: 300,
        heightMm: 200,
        insuranceCost: 1000,
      },
    ],
    recipientDivisionId: 11198,
    recipientAddress: null,
  };

  test('sender division included when provided (live API requires it)', () => {
    const body = toProviderBody(input, 7162) as {
      sender: { countryCode: string; divisionId?: number };
    };
    assert.equal(body.sender.countryCode, 'UA');
    assert.equal(body.sender.divisionId, 7162);
    assert.deepEqual((body as unknown as { recipient: unknown }).recipient, {
      countryCode: 'UA',
      divisionId: 11198,
    });
  });

  test('backwards compatible: without sender division body is unchanged', () => {
    const body = toProviderBody(input) as { sender: { divisionId?: number } };
    assert.equal(body.sender.divisionId, undefined);
  });
});

describe('NOVA_POST_SENDER_DIVISION_ID env config', () => {
  test('env var name is server-side only', () => {
    assert.equal(NOVA_POST_SENDER_DIVISION_ID_ENV, 'NOVA_POST_SENDER_DIVISION_ID');
  });

  test('fail-closed: missing/invalid → null', () => {
    process.env[NOVA_POST_SENDER_DIVISION_ID_ENV] = '';
    assert.equal(readNovaPostSenderDivisionId(), null);
    process.env[NOVA_POST_SENDER_DIVISION_ID_ENV] = 'abc';
    assert.equal(readNovaPostSenderDivisionId(), null);
    process.env[NOVA_POST_SENDER_DIVISION_ID_ENV] = '0';
    assert.equal(readNovaPostSenderDivisionId(), null);
    process.env[NOVA_POST_SENDER_DIVISION_ID_ENV] = '-5';
    assert.equal(readNovaPostSenderDivisionId(), null);
    process.env[NOVA_POST_SENDER_DIVISION_ID_ENV] = '2.5';
    assert.equal(readNovaPostSenderDivisionId(), null);
    delete process.env[NOVA_POST_SENDER_DIVISION_ID_ENV];
    assert.equal(readNovaPostSenderDivisionId(), null);
  });

  test('valid positive integer is accepted', () => {
    process.env[NOVA_POST_SENDER_DIVISION_ID_ENV] = ' 11198 ';
    assert.equal(readNovaPostSenderDivisionId(), 11198);
    delete process.env[NOVA_POST_SENDER_DIVISION_ID_ENV];
  });
});
