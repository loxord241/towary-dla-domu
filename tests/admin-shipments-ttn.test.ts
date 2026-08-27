/**
 * Stage 2F — TTN creation builder + orchestration (pure logic, no HTTP/DB).
 * DB and Nova Post access are injected as stubs.
 * Run: npm test
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOVA_POST_SENDER_NAME_ENV,
  NOVA_POST_SENDER_PHONE_ENV,
  readNovaPostSenderName,
  readNovaPostSenderPhone,
} from '../app/lib/delivery/novapost/config.ts';
import {
  buildShipmentTtnPayload,
  createTtnForShipment,
  rollbackShipmentTtn,
  type TtnParcelRow,
  type TtnSourceShipment,
} from '../app/lib/admin-shipments-ttn.ts';
import { NovaPostError } from '../app/lib/delivery/novapost/errors.ts';
import type {
  NpShipmentCreated,
  NpShipmentSummary,
} from '../app/lib/delivery/novapost/shipments.ts';

// ---------------------------------------------------------------- config ---

describe('nova post sender env (fail-closed, server-only)', () => {
  const savedName = process.env[NOVA_POST_SENDER_NAME_ENV];
  const savedPhone = process.env[NOVA_POST_SENDER_PHONE_ENV];

  afterEach(() => {
    if (savedName === undefined) delete process.env[NOVA_POST_SENDER_NAME_ENV];
    else process.env[NOVA_POST_SENDER_NAME_ENV] = savedName;
    if (savedPhone === undefined) delete process.env[NOVA_POST_SENDER_PHONE_ENV];
    else process.env[NOVA_POST_SENDER_PHONE_ENV] = savedPhone;
  });

  test('reads trimmed values and returns null when absent/blank', () => {
    delete process.env[NOVA_POST_SENDER_NAME_ENV];
    delete process.env[NOVA_POST_SENDER_PHONE_ENV];
    assert.equal(readNovaPostSenderName(), null);
    assert.equal(readNovaPostSenderPhone(), null);
    process.env[NOVA_POST_SENDER_NAME_ENV] = '  Товари для дому  ';
    process.env[NOVA_POST_SENDER_PHONE_ENV] = ' 380671234567 ';
    assert.equal(readNovaPostSenderName(), 'Товари для дому');
    assert.equal(readNovaPostSenderPhone(), '380671234567');
    process.env[NOVA_POST_SENDER_NAME_ENV] = '   ';
    process.env[NOVA_POST_SENDER_PHONE_ENV] = '';
    assert.equal(readNovaPostSenderName(), null);
    assert.equal(readNovaPostSenderPhone(), null);
  });

  test('sender name over the provider limit (100) fails closed', () => {
    process.env[NOVA_POST_SENDER_NAME_ENV] = 'x'.repeat(101);
    assert.equal(readNovaPostSenderName(), null);
  });
});

// --------------------------------------------------------------- builder ---

const PARCEL: TtnParcelRow = {
  parcel_index: 1,
  cargo_category: 'parcel',
  actual_weight_grams: 1000,
  width_mm: 200,
  length_mm: 300,
  height_mm: 150,
  insurance_cost: 100,
};

function source(overrides: Partial<TtnSourceShipment> = {}): TtnSourceShipment {
  return {
    shipment_id: '0f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8',
    status: 'planned',
    service_type: 'nova_poshta_warehouse',
    warehouse_ref: '7162',
    parcels: [PARCEL],
    productNames: ['Чашка керамічна', 'Тарілка'],
    recipientName: 'Олена Тест',
    recipientPhone: '+380671234567',
    ...overrides,
  };
}

const SENDER = { divisionId: 42, name: 'Товари для дому', phone: '380671234567' };

describe('buildShipmentTtnPayload (sandbox-verified domestic UA warehouse)', () => {
  test('builds the minimal payload: no invoice, no status, no note', () => {
    const built = buildShipmentTtnPayload(source(), SENDER);
    assert.ok(built.ok, JSON.stringify(built));
    assert.equal(built.clientOrder, source().shipment_id);
    assert.deepEqual(built.payload, {
      clientOrder: '0f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8',
      payerType: 'Recipient',
      sender: {
        name: 'Товари для дому',
        phone: '380671234567',
        countryCode: 'UA',
        divisionId: 42,
      },
      recipient: {
        name: 'Олена Тест',
        phone: '380671234567',
        countryCode: 'UA',
        divisionId: 7162,
      },
      parcels: [
        {
          rowNumber: 1,
          cargoCategory: 'parcel',
          parcelDescription: 'Чашка керамічна, Тарілка',
          insuranceCost: 100,
          actualWeight: 1000,
          width: 200,
          length: 300,
          height: 150,
        },
      ],
    });
    assert.equal('invoice' in built.payload, false);
    assert.equal('status' in built.payload, false);
    assert.equal('note' in built.payload, false);
  });

  test('uses the camelCase divisionId key (sandbox: divisionID 422s)', () => {
    const built = buildShipmentTtnPayload(source(), SENDER);
    assert.ok(built.ok);
    assert.ok('divisionId' in built.payload.sender);
    assert.ok('divisionId' in built.payload.recipient);
  });

  test('parcelDescription = product names joined, capped at 255 chars', () => {
    const built = buildShipmentTtnPayload(
      source({ productNames: ['A'.repeat(300), 'B'.repeat(100)] }),
      SENDER
    );
    assert.ok(built.ok);
    const desc = built.payload.parcels[0].parcelDescription;
    assert.ok(desc.length <= 255);
    assert.ok(desc.startsWith('A'.repeat(200)));
  });

  test('description falls back when there are no product names', () => {
    const built = buildShipmentTtnPayload(source({ productNames: [] }), SENDER);
    assert.ok(built.ok);
    assert.ok(built.payload.parcels[0].parcelDescription.length > 0);
  });

  test('normalizes recipient phone (+, spaces) to digits', () => {
    const built = buildShipmentTtnPayload(
      source({ recipientPhone: '+38 (067) 123-45-67' }),
      SENDER
    );
    assert.ok(built.ok);
    assert.equal(built.payload.recipient.phone, '380671234567');
  });

  test('normalizes the sender phone from env the same way', () => {
    const built = buildShipmentTtnPayload(
      source(),
      { ...SENDER, phone: '+38 067 123 45 67' }
    );
    assert.ok(built.ok);
    assert.equal(built.payload.sender.phone, '380671234567');
  });

  test('multi-parcel shipments map 1:1 with rowNumber = parcel_index', () => {
    const second: TtnParcelRow = { ...PARCEL, parcel_index: 2, insurance_cost: 50 };
    const built = buildShipmentTtnPayload(
      source({ parcels: [PARCEL, second] }),
      SENDER
    );
    assert.ok(built.ok);
    assert.equal(built.payload.parcels.length, 2);
    assert.deepEqual(
      built.payload.parcels.map((p) => p.rowNumber),
      [1, 2]
    );
    assert.deepEqual(
      built.payload.parcels.map((p) => p.insuranceCost),
      [100, 50]
    );
  });

  test('courier shipments are rejected (not supported in 2F)', () => {
    const built = buildShipmentTtnPayload(
      source({ service_type: 'nova_poshta_courier', warehouse_ref: null }),
      SENDER
    );
    assert.ok(!built.ok);
    assert.equal(built.reason, 'courier_not_supported');
  });

  test('non-planned shipments are rejected', () => {
    const built = buildShipmentTtnPayload(source({ status: 'created' }), SENDER);
    assert.ok(!built.ok);
    assert.equal(built.reason, 'not_planned');
  });

  test('bad/non-integer warehouse_ref is rejected', () => {
    const built = buildShipmentTtnPayload(source({ warehouse_ref: 'abc' }), SENDER);
    assert.ok(!built.ok);
    assert.equal(built.reason, 'bad_destination');
  });

  test('shipments without parcels are rejected', () => {
    const built = buildShipmentTtnPayload(source({ parcels: [] }), SENDER);
    assert.ok(!built.ok);
    assert.equal(built.reason, 'no_parcels');
  });

  test('bad recipient name/phone fails closed', () => {
    assert.equal(
      buildShipmentTtnPayload(source({ recipientName: '   ' }), SENDER).ok,
      false
    );
    assert.equal(
      buildShipmentTtnPayload(source({ recipientPhone: '123' }), SENDER).ok,
      false
    );
    assert.equal(
      buildShipmentTtnPayload(source({ recipientPhone: null }), SENDER).ok,
      false
    );
  });
});

// --------------------------------------------------------- orchestration ---

interface FakeNp {
  lookupCalls: string[];
  createCalls: unknown[];
  deleteCalls: string[];
  lookup: (co: string) => Promise<NpShipmentSummary[]>;
  create: (payload: unknown) => Promise<NpShipmentCreated>;
  delete: (ref: string) => Promise<'deleted' | 'already_deleted'>;
}

function fakeNp(overrides: Partial<FakeNp> = {}): FakeNp {
  return {
    lookupCalls: [],
    createCalls: [],
    deleteCalls: [],
    lookup: (co) => {
      void co;
      return Promise.resolve([]);
    },
    create: () =>
      Promise.resolve({
        id: 'ref-1',
        number: '20450000000001',
        status: 'ReadyToShip',
        cost: 115,
        parcelsAmount: 1,
        scheduledDeliveryDate: null,
        deletedAt: null,
      }),
    delete: () => Promise.resolve('deleted'),
    ...overrides,
  };
}

const CREATED_SUMMARY = {
  id: 'orphan-ref-1',
  number: '20450000000009',
  clientOrder: '0f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8',
  status: 'ReadyToShip',
  deletedAt: null,
};

function deps(np: FakeNp, overrides: Record<string, unknown> = {}) {
  return {
    np: {
      findByClientOrder: (co: string) => {
        np.lookupCalls.push(co);
        return np.lookup(co);
      },
      create: (payload: unknown) => {
        np.createCalls.push(payload);
        return np.create(payload);
      },
      deleteByRef: (ref: string) => {
        np.deleteCalls.push(ref);
        return np.delete(ref);
      },
    },
    markCreated: () => Promise.resolve(true),
    saveProviderError: () => Promise.resolve(),
    ...overrides,
  };
}

const built = () => buildShipmentTtnPayload(source(), SENDER);

describe('createTtnForShipment orchestration', () => {
  test('invalid source → invalid, no NP calls', async () => {
    const np = fakeNp();
    const outcome = await createTtnForShipment({
      ...deps(np),
      built: { ok: false as const, reason: 'courier_not_supported' as const },
    });
    assert.equal(outcome.kind, 'invalid');
    assert.equal(np.createCalls.length, 0);
    assert.equal(np.lookupCalls.length, 0);
  });

  test('pre-check finds an active orphan TTN (crash window) → adopt, no POST', async () => {
    const np = fakeNp({ lookup: () => Promise.resolve([CREATED_SUMMARY]) });
    const outcome = await createTtnForShipment({
      ...deps(np),
      built: built(),
    });
    assert.equal(outcome.kind, 'adopted');
    if (outcome.kind === 'adopted') {
      assert.equal(outcome.ttnRef, 'orphan-ref-1');
      assert.equal(outcome.ttnNumber, '20450000000009');
      assert.equal(outcome.deliveryCost, null);
    }
    assert.equal(np.createCalls.length, 0, 'blind re-POST is forbidden');
    assert.equal(np.lookupCalls.length, 1);
  });

  test('deleted orphan TTNs are ignored in the pre-check', async () => {
    const np = fakeNp({
      lookup: () =>
        Promise.resolve([{ ...CREATED_SUMMARY, deletedAt: '2026-08-27T20:00:00Z' }]),
    });
    const outcome = await createTtnForShipment({ ...deps(np), built: built() });
    assert.equal(outcome.kind, 'created');
    assert.equal(np.createCalls.length, 1);
  });

  test('pre-check finds a TTN but marking loses the race → conflict', async () => {
    const np = fakeNp({ lookup: () => Promise.resolve([CREATED_SUMMARY]) });
    const outcome = await createTtnForShipment({
      ...deps(np, { markCreated: () => Promise.resolve(false) }),
      built: built(),
    });
    assert.equal(outcome.kind, 'conflict');
    assert.equal(np.createCalls.length, 0);
  });

  test('created → POST once, mark wins → created', async () => {
    const np = fakeNp();
    const marks: { ttnRef: string; ttnNumber: string; deliveryCost: number | null }[] = [];
    const outcome = await createTtnForShipment({
      ...deps(np, {
        markCreated: (input: { ttnRef: string; ttnNumber: string; deliveryCost: number | null }) => {
          marks.push(input);
          return Promise.resolve(true);
        },
      }),
      built: built(),
    });
    assert.equal(outcome.kind, 'created');
    assert.equal(np.createCalls.length, 1);
    assert.equal(np.lookupCalls.length, 1, 'exactly the pre-check lookup');
    assert.equal(marks.length, 1);
    assert.equal(marks[0].ttnRef, 'ref-1');
    assert.equal(marks[0].deliveryCost, 115);
  });

  test('POST ok but mark loses the race → best-effort DELETE of our TTN → conflict', async () => {
    const np = fakeNp();
    const outcome = await createTtnForShipment({
      ...deps(np, { markCreated: () => Promise.resolve(false) }),
      built: built(),
    });
    assert.equal(outcome.kind, 'conflict');
    assert.deepEqual(np.deleteCalls, ['ref-1']);
  });

  test('unknown POST outcome → recovery lookup finds orphan → adopt (no blind retry)', async () => {
    let createAttempts = 0;
    const np = fakeNp({
      create: () => {
        createAttempts += 1;
        return Promise.reject(new Error('network catastrophe'));
      },
    });
    // lookup: first call (pre-check) empty, second (recovery) finds orphan.
    np.lookup = (co) => {
      void co;
      return Promise.resolve(np.lookupCalls.length >= 2 ? [CREATED_SUMMARY] : []);
    };
    const outcome = await createTtnForShipment({ ...deps(np), built: built() });
    assert.equal(outcome.kind, 'adopted');
    assert.equal(createAttempts, 1, 'POST is never retried blindly');
    assert.equal(np.lookupCalls.length, 2);
  });

  test('unknown POST outcome and empty recovery → unknown_state', async () => {
    const np = fakeNp({ create: () => Promise.reject(new Error('timeout')) });
    const outcome = await createTtnForShipment({ ...deps(np), built: built() });
    assert.equal(outcome.kind, 'unknown_state');
    assert.equal(np.createCalls.length, 1);
  });

  test('422 rejection → provider error saved (np_last_error) → provider_rejected', async () => {
    const np = fakeNp({
      create: () =>
        Promise.reject(
          new NovaPostError('provider_error', 'rejected', {
            'parcels.0.cargoCategory': 'required',
          })
        ),
    });
    const saved: { code: string | null; message: string }[] = [];
    const outcome = await createTtnForShipment({
      ...deps(np, {
        saveProviderError: (code: string | null, message: string) => {
          saved.push({ code, message });
          return Promise.resolve();
        },
      }),
      built: built(),
    });
    assert.equal(outcome.kind, 'provider_rejected');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].code, 'parcels.0.cargoCategory');
    assert.match(saved[0].message, /required/);
    assert.equal(np.lookupCalls.length, 1, 'no recovery loop for validation errors');
  });
});

describe('rollbackShipmentTtn (admin rollback)', () => {
  test('deletes by ref then resets the DB row', async () => {
    const np = fakeNp();
    const resets: string[] = [];
    const outcome = await rollbackShipmentTtn({
      np: deps(np).np,
      ttnRef: 'ref-9',
      resetRow: (ref) => {
        resets.push(ref);
        return Promise.resolve(true);
      },
    });
    assert.equal(outcome.kind, 'rolled_back');
    assert.deepEqual(np.deleteCalls, ['ref-9']);
    assert.deepEqual(resets, ['ref-9']);
  });

  test('already-deleted provider side still resets the row (idempotent)', async () => {
    const np = fakeNp({ delete: () => Promise.resolve('already_deleted') });
    const outcome = await rollbackShipmentTtn({
      np: deps(np).np,
      ttnRef: 'ref-9',
      resetRow: () => Promise.resolve(true),
    });
    assert.equal(outcome.kind, 'rolled_back');
  });

  test('provider delete failure → no DB reset', async () => {
    const np = fakeNp({
      delete: () =>
        Promise.reject(new NovaPostError('unavailable', 'provider is down')),
    });
    let resetCalled = false;
    const outcome = await rollbackShipmentTtn({
      np: deps(np).np,
      ttnRef: 'ref-9',
      resetRow: () => {
        resetCalled = true;
        return Promise.resolve(true);
      },
    });
    assert.equal(outcome.kind, 'provider_failed');
    assert.equal(resetCalled, false);
  });

  test('provider ok but DB reset lost the race → reset_failed', async () => {
    const np = fakeNp();
    const outcome = await rollbackShipmentTtn({
      np: deps(np).np,
      ttnRef: 'ref-9',
      resetRow: () => Promise.resolve(false),
    });
    assert.equal(outcome.kind, 'reset_failed');
  });
});
