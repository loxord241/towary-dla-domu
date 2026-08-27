/**
 * Nova Post shipment document operations (stage 2F) — parser + adapter tests.
 * Provider HTTP is always a stub (never a real Nova Post call).
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createNovaPostClient } from '../app/lib/delivery/novapost/client.ts';
import {
  createShipment,
  findShipmentsByClientOrder,
  deleteShipmentByRef,
  parseShipmentCreated,
  parseShipmentSummary,
} from '../app/lib/delivery/novapost/shipments.ts';
import { isNovaPostError } from '../app/lib/delivery/novapost/errors.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- sandbox-verified 201 body shape (2026-08-27 research) -------------------
const CREATED_201 = {
  id: '01a044c8-018a-7952-8e2d-d60ad39839b7',
  number: '20451522053811',
  scheduledDeliveryDate: '0001-01-01T00:00:00.000000Z',
  status: 'ReadyToShip',
  cost: 115,
  parcelsAmount: 1,
  createdAt: '2026-08-27T19:52:33.953004Z',
  updatedAt: '0001-01-01T00:00:00.000000Z',
  deletedAt: null,
  services: [{ payerType: 'Recipient', paymentStatus: 'NeedPay' }],
  parcels: [{ rowNumber: 1 }],
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

function stubClient(
  handler: (call: Call) => Response | Promise<Response>
): { calls: Call[]; client: ReturnType<typeof createNovaPostClient> } {
  const calls: Call[] = [];
  const client = createNovaPostClient({
    apiKey: 'stub-key',
    baseUrl: 'https://api-stage.novapost.com/v.1.0/',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : (input as URL).toString();
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      if (url.includes('clients/authorization')) {
        return new Response(JSON.stringify({ jwt: 'test-jwt' }), { status: 200 });
      }
      calls.push(call);
      return handler(call);
    }) as typeof fetch,
    now: () => Date.now(),
  });
  return { calls, client };
}

describe('nova post client deleteJson', () => {
  test('DELETE is sent without a JSON body to the given path', async () => {
    const { calls, client } = stubClient(() => new Response('{"success":true}', { status: 200 }));
    await client.deleteJson('shipments/01a044c8-018a-7952-8e2d-d60ad39839b7');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'DELETE');
    assert.ok(calls[0].url.endsWith('/v.1.0/shipments/01a044c8-018a-7952-8e2d-d60ad39839b7'));
    assert.equal(calls[0].body, undefined);
  });

  test('deleteJson surfaces 422 as provider_error with sanitized details', async () => {
    const { client } = stubClient(
      () => new Response('{"errors":{"errorMessage":"shipment_was_deleted"}}', { status: 422 })
    );
    await assert.rejects(
      () => client.deleteJson('shipments/x'),
      (err: unknown) => isNovaPostError(err) && err.kind === 'provider_error' &&
        err.providerDetails?.['errorMessage'] === 'shipment_was_deleted'
    );
  });
});

describe('parseShipmentCreated (strict 201 parsing)', () => {
  test('parses the sandbox-verified 201 body', () => {
    const parsed = parseShipmentCreated(CREATED_201);
    assert.ok(parsed);
    assert.equal(parsed.id, '01a044c8-018a-7952-8e2d-d60ad39839b7');
    assert.equal(parsed.number, '20451522053811');
    assert.equal(parsed.status, 'ReadyToShip');
    assert.equal(parsed.cost, 115);
    assert.equal(parsed.parcelsAmount, 1);
    assert.equal(parsed.deletedAt, null);
  });

  test('rejects missing/invalid required fields (provider is NOT trusted)', () => {
    assert.equal(parseShipmentCreated(null), null);
    assert.equal(parseShipmentCreated({}), null);
    assert.equal(parseShipmentCreated({ ...CREATED_201, id: 42 }), null);
    assert.equal(parseShipmentCreated({ ...CREATED_201, id: '' }), null);
    assert.equal(parseShipmentCreated({ ...CREATED_201, number: null }), null);
    assert.equal(parseShipmentCreated({ ...CREATED_201, cost: '115' }), null);
    assert.equal(parseShipmentCreated({ ...CREATED_201, cost: Number.NaN }), null);
    assert.equal(parseShipmentCreated({ ...CREATED_201, parcelsAmount: 0 }), null);
    assert.equal(parseShipmentCreated({ ...CREATED_201, status: 1 }), null);
  });

  test('nullable scheduledDeliveryDate / deletedAt accept null and strings', () => {
    const a = parseShipmentCreated({ ...CREATED_201, scheduledDeliveryDate: null });
    assert.equal(a?.scheduledDeliveryDate, null);
    const b = parseShipmentCreated({ ...CREATED_201, deletedAt: '2026-08-27T20:00:00Z' });
    assert.equal(b?.deletedAt, '2026-08-27T20:00:00Z');
    assert.equal(parseShipmentCreated({ ...CREATED_201, deletedAt: 5 }), null);
  });
});

describe('createShipment (POST /shipments adapter)', () => {
  test('POSTs the payload as JSON and returns the parsed 201', async () => {
    const payload = { clientOrder: 'abc', parcels: [] };
    const { calls, client } = stubClient(
      () => new Response(JSON.stringify(CREATED_201), { status: 201 })
    );
    const created = await createShipment(client, payload);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.ok(calls[0].url.endsWith('/v.1.0/shipments'));
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), payload);
    assert.equal(created.number, '20451522053811');
  });

  test('unexpected 201 payload -> unexpected_response (never half-parsed data)', async () => {
    const { client } = stubClient(
      () => new Response(JSON.stringify({ id: 'x' }), { status: 201 })
    );
    await assert.rejects(
      () => createShipment(client, {}),
      (err: unknown) => isNovaPostError(err) && err.kind === 'unexpected_response'
    );
  });

  test('provider 422 rejection -> provider_error with sanitized details', async () => {
    const { client } = stubClient(
      () => new Response(
        JSON.stringify({ errors: { 'parcels.0.cargoCategory': 'The parcels.0.cargoCategory field is required.' } }),
        { status: 422 }
      )
    );
    await assert.rejects(
      () => createShipment(client, {}),
      (err: unknown) => isNovaPostError(err) && err.kind === 'provider_error' &&
        err.providerDetails?.['parcels.0.cargoCategory'] ===
          'The parcels.0.cargoCategory field is required.'
    );
  });
});

describe('findShipmentsByClientOrder (GET /shipments?clientOrder=…)', () => {
  test('queries with clientOrder + limit and maps items', async () => {
    const { calls, client } = stubClient(
      () =>
        new Response(
          JSON.stringify({
            current_page: 1,
            last_page: 1,
            total: 1,
            items: [
              {
                id: '01a044c8-5b57-7d30-a4c4-3eb2a8cee77b',
                number: '20451522053870',
                clientOrder: 'ship-1',
                status: 'ReadyToShip',
                deletedAt: null,
              },
            ],
          }),
          { status: 200 }
        )
    );
    const items = await findShipmentsByClientOrder(client, 'ship-1');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('clientOrder=ship-1'));
    assert.ok(calls[0].url.includes('limit=15'));
    assert.equal(items.length, 1);
    assert.equal(items[0].id, '01a044c8-5b57-7d30-a4c4-3eb2a8cee77b');
    assert.equal(items[0].number, '20451522053870');
    assert.equal(items[0].clientOrder, 'ship-1');
    assert.equal(items[0].deletedAt, null);
  });

  test('empty result -> []', async () => {
    const { client } = stubClient(
      () => new Response(JSON.stringify({ total: 0, items: [] }), { status: 200 })
    );
    assert.deepEqual(await findShipmentsByClientOrder(client, 'none'), []);
  });

  test('malformed items are dropped, valid ones kept', async () => {
    const { client } = stubClient(
      () =>
        new Response(
          JSON.stringify({
            items: [
              { id: 'a', number: 'N1', clientOrder: 'c1', status: 'ReadyToShip', deletedAt: null },
              { id: 5 },
              null,
              { id: 'b' },
            ],
          }),
          { status: 200 }
        )
    );
    const items = await findShipmentsByClientOrder(client, 'c');
    assert.equal(items.length, 1);
    assert.equal(items[0].number, 'N1');
  });

  test('missing items array -> unexpected_response', async () => {
    const { client } = stubClient(() => new Response('{"weird":1}', { status: 200 }));
    await assert.rejects(
      () => findShipmentsByClientOrder(client, 'c'),
      (err: unknown) => isNovaPostError(err) && err.kind === 'unexpected_response'
    );
  });

  test('blank or overlong clientOrder -> invalid_input before any HTTP call', async () => {
    const { calls, client } = stubClient(() => new Response('{}', { status: 200 }));
    await assert.rejects(() => findShipmentsByClientOrder(client, '  '));
    await assert.rejects(() => findShipmentsByClientOrder(client, 'x'.repeat(51)));
    assert.equal(calls.length, 0);
  });
});

describe('parseShipmentSummary', () => {
  test('accepts minimal valid list item', () => {
    const s = parseShipmentSummary({
      id: '01a044c8-5b57-7d30-a4c4-3eb2a8cee77b',
      number: '20451522053870',
      clientOrder: 'ship-1',
      status: 'ReadyToShip',
      deletedAt: null,
    });
    assert.ok(s);
    assert.equal(s.status, 'ReadyToShip');
  });

  test('rejects items without id/number/status', () => {
    assert.equal(parseShipmentSummary({}), null);
    assert.equal(parseShipmentSummary({ id: 'a', number: 'b' }), null);
    assert.equal(parseShipmentSummary({ id: 'a', number: 'b', status: 'ReadyToShip', deletedAt: 7 }), null);
  });
});

describe('deleteShipmentByRef (DELETE /shipments/{ref})', () => {
  test('200 -> deleted', async () => {
    const { calls, client } = stubClient(
      () => new Response('{"success":true}', { status: 200 })
    );
    const result = await deleteShipmentByRef(client, '01a044c8-018a-7952-8e2d-d60ad39839b7');
    assert.equal(result, 'deleted');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'DELETE');
  });

  test('422 shipment_was_deleted -> already_deleted (idempotent signal)', async () => {
    const { client } = stubClient(
      () => new Response('{"errors":{"errorMessage":"shipment_was_deleted"}}', { status: 422 })
    );
    assert.equal(await deleteShipmentByRef(client, 'ref-1'), 'already_deleted');
  });

  test('other 422 rejections -> provider_error', async () => {
    const { client } = stubClient(
      () => new Response('{"errors":{"errorMessage":"shipment_cannot_be_deleted"}}', { status: 422 })
    );
    await assert.rejects(
      () => deleteShipmentByRef(client, 'ref-1'),
      (err: unknown) => isNovaPostError(err) && err.kind === 'provider_error'
    );
  });

  test('blank ref -> invalid_input', async () => {
    const { client } = stubClient(() => new Response('{}', { status: 200 }));
    await assert.rejects(() => deleteShipmentByRef(client, ' '));
  });
});

describe('route static invariants', () => {
  test('ttn route file exists under admin shipments API', () => {
    const src = readFileSync(
      path.join(root, 'app/api/admin/orders/[id]/shipments/ttn/route.ts'),
      'utf8'
    );
    assert.ok(src.includes('export async function POST'));
  });
});
