/**
 * Admin shipment planning (stage 2D) — payload validation invariants.
 * Pure functions, no HTTP/DB. The validator mirrors the DB constraints of
 * migrations 019/020 so the manager gets readable errors before the RPC runs.
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseShipmentPlanPayload,
  MAX_SHIPMENTS,
  MAX_PARCELS_PER_SHIPMENT,
} from '../app/lib/admin-shipments.ts';

const ITEM_A = '11111111-1111-1111-1111-111111111111';

function baseShipment(overrides: Record<string, unknown> = {}) {
  return {
    shipment_index: 1,
    service_type: 'nova_poshta_warehouse',
    city_ref: '12345',
    city_name: 'Львів',
    warehouse_ref: '67890',
    warehouse_name: 'Відділення №1',
    address: null,
    cod_amount: 100.5,
    items: [{ order_item_id: ITEM_A, quantity: 2 }],
    parcels: [],
    ...overrides,
  };
}

function ok(overrides: Record<string, unknown> = {}, shipments?: unknown[]) {
  return parseShipmentPlanPayload({
    shipments: shipments ?? [baseShipment(overrides)],
  });
}

describe('shipment plan payload — valid input', () => {
  test('parcels cap matches the live Nova Post calculation envelope (10)', () => {
    // OpenAPI has no maxItems, but our client parser caps at 10; 2D must
    // stay within the verified envelope (stage 2E decision).
    assert.equal(MAX_PARCELS_PER_SHIPMENT, 10);
  });

  test('accepts a minimal warehouse shipment', () => {
    const res = ok();
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.plan.shipments.length, 1);
    assert.equal(res.plan.shipments[0].cod_amount, 100.5);
  });

  test('accepts a courier shipment with a free-text address', () => {
    const res = ok({
      service_type: 'nova_poshta_courier',
      warehouse_ref: null,
      warehouse_name: null,
      address: 'вул. Шевченка 1, кв. 2',
    });
    assert.ok(res.ok, JSON.stringify(res));
  });

  test('accepts empty plan (clear all shipments)', () => {
    const res = parseShipmentPlanPayload({ shipments: [] });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.plan.shipments.length, 0);
  });

  test('accepts parcels with valid live-API parameters', () => {
    const res = ok({
      parcels: [
        {
          parcel_index: 1,
          cargo_category: 'parcel',
          actual_weight_grams: 5000,
          width_mm: 400,
          length_mm: 300,
          height_mm: 200,
          insurance_cost: 1500,
          description: 'Пральна машина',
        },
      ],
    });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.plan.shipments[0].parcels.length, 1);
  });

  test('numeric cod_amount as string is coerced', () => {
    const res = ok({ cod_amount: '250' });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.plan.shipments[0].cod_amount, 250);
  });
});

describe('shipment plan payload — structural errors', () => {
  test('rejects non-object and missing shipments array', () => {
    assert.equal(parseShipmentPlanPayload(null).ok, false);
    assert.equal(parseShipmentPlanPayload('x').ok, false);
    assert.equal(parseShipmentPlanPayload({}).ok, false);
    assert.equal(parseShipmentPlanPayload({ shipments: 'x' }).ok, false);
  });

  test('rejects more than MAX_SHIPMENTS', () => {
    const many = Array.from({ length: MAX_SHIPMENTS + 1 }, (_, i) =>
      baseShipment({ shipment_index: i + 1 })
    );
    const res = parseShipmentPlanPayload({ shipments: many });
    assert.equal(res.ok, false);
  });

  test('rejects non-contiguous shipment_index', () => {
    const res = parseShipmentPlanPayload({
      shipments: [baseShipment({ shipment_index: 1 }), baseShipment({ shipment_index: 3 })],
    });
    assert.equal(res.ok, false);
  });

  test('rejects duplicate shipment_index', () => {
    const res = parseShipmentPlanPayload({
      shipments: [baseShipment(), baseShipment()],
    });
    assert.equal(res.ok, false);
  });
});

describe('shipment plan payload — destination XOR', () => {
  test('warehouse shipment requires warehouse_ref, forbids address', () => {
    assert.equal(ok({ warehouse_ref: null }).ok, false);
    assert.equal(ok({ address: 'вул. Х' }).ok, false);
  });

  test('courier shipment requires address, forbids warehouse_ref', () => {
    assert.equal(
      ok({
        service_type: 'nova_poshta_courier',
        warehouse_ref: null,
        warehouse_name: null,
        address: null,
      }).ok,
      false
    );
    assert.equal(
      ok({
        service_type: 'nova_poshta_courier',
        address: 'вул. Х',
      }).ok,
      false
    );
  });

  test('unknown service_type rejected', () => {
    assert.equal(ok({ service_type: 'drone' }).ok, false);
  });

  test('city_ref required and non-empty', () => {
    assert.equal(ok({ city_ref: '' }).ok, false);
    assert.equal(ok({ city_ref: null }).ok, false);
  });
});

describe('shipment plan payload — items', () => {
  test('shipment must carry at least one item', () => {
    assert.equal(ok({ items: [] }).ok, false);
  });

  test('rejects bad uuid / quantity', () => {
    assert.equal(ok({ items: [{ order_item_id: 'nope', quantity: 1 }] }).ok, false);
    assert.equal(ok({ items: [{ order_item_id: ITEM_A, quantity: 0 }] }).ok, false);
    assert.equal(ok({ items: [{ order_item_id: ITEM_A, quantity: 1.5 }] }).ok, false);
  });

  test('rejects duplicate order_item inside one shipment', () => {
    assert.equal(
      ok({
        items: [
          { order_item_id: ITEM_A, quantity: 1 },
          { order_item_id: ITEM_A, quantity: 1 },
        ],
      }).ok,
      false
    );
  });

  test('same item in different shipments is allowed (partial allocation)', () => {
    const res = parseShipmentPlanPayload({
      shipments: [
        baseShipment({ shipment_index: 1 }),
        baseShipment({
          shipment_index: 2,
          items: [{ order_item_id: ITEM_A, quantity: 1 }],
        }),
      ],
    });
    assert.ok(res.ok, JSON.stringify(res));
  });

  test('quantity as numeric string is coerced', () => {
    const res = ok({ items: [{ order_item_id: ITEM_A, quantity: '2' }] });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.plan.shipments[0].items[0].quantity, 2);
  });
});

describe('shipment plan payload — cod_amount', () => {
  test('rejects negative and non-finite', () => {
    assert.equal(ok({ cod_amount: -1 }).ok, false);
    assert.equal(ok({ cod_amount: 'abc' }).ok, false);
    assert.equal(ok({ cod_amount: Number.POSITIVE_INFINITY }).ok, false);
  });
});

describe('shipment plan payload — parcels', () => {
  test('weight must be positive and a multiple of 10 grams', () => {
    assert.equal(
      ok({ parcels: [parcel({ actual_weight_grams: 5005 })] }).ok,
      false
    );
    assert.equal(
      ok({ parcels: [parcel({ actual_weight_grams: 0 })] }).ok,
      false
    );
  });

  test('dimensions must be positive integers (mm)', () => {
    assert.equal(ok({ parcels: [parcel({ width_mm: 0 })] }).ok, false);
    assert.equal(ok({ parcels: [parcel({ height_mm: 12.5 })] }).ok, false);
    assert.equal(ok({ parcels: [parcel({ length_mm: -1 })] }).ok, false);
  });

  test('insurance_cost must be > 0', () => {
    assert.equal(ok({ parcels: [parcel({ insurance_cost: 0 })] }).ok, false);
    assert.equal(ok({ parcels: [parcel({ insurance_cost: -5 })] }).ok, false);
  });

  test('cargo_category whitelisted', () => {
    assert.equal(ok({ parcels: [parcel({ cargo_category: 'elephant' })] }).ok, false);
    for (const c of ['parcel', 'documents', 'pallet']) {
      assert.ok(ok({ parcels: [parcel({ cargo_category: c })] }).ok, c);
    }
  });

  test('parcel_index must be contiguous from 1', () => {
    const two = [
      parcel({ parcel_index: 1 }),
      parcel({ parcel_index: 2 }),
    ];
    assert.ok(ok({ parcels: two }).ok, JSON.stringify(ok({ parcels: two })));
    assert.equal(
      ok({ parcels: [parcel({ parcel_index: 2 })] }).ok,
      false
    );
  });

  test('rejects more than MAX_PARCELS_PER_SHIPMENT', () => {
    const many = Array.from({ length: MAX_PARCELS_PER_SHIPMENT + 1 }, (_, i) =>
      parcel({ parcel_index: i + 1 })
    );
    assert.equal(ok({ parcels: many }).ok, false);
  });

  test('description nulls allowed, non-string rejected', () => {
    assert.ok(ok({ parcels: [parcel({ description: null })] }).ok);
    assert.equal(ok({ parcels: [parcel({ description: 42 })] }).ok, false);
  });
});

function parcel(overrides: Record<string, unknown> = {}) {
  return {
    parcel_index: 1,
    cargo_category: 'parcel',
    actual_weight_grams: 5000,
    width_mm: 400,
    length_mm: 300,
    height_mm: 200,
    insurance_cost: 1500,
    description: null,
    ...overrides,
  };
}
