/* eslint-disable @typescript-eslint/no-explicit-any -- provider body assertions need dynamic property access */
/**
 * Stage 2G — delivery-cost courier branch.
 *
 * Live-verified contract (docs/novapost-courier-addressparts-research.md):
 * courier recipient location resolves ONLY via the undocumented-but-stable
 * `recipient.settlementId` (integer from GET /settlements) + addressParts;
 * free-text city is ignored/rejected by the provider. The warehouse branch
 * (recipientDivisionId) must remain unchanged; payerType stays fixed
 * server-side as 'Recipient' (buyer pays delivery — never a discount and
 * never part of order totals).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDeliveryCostBody,
  toProviderBody,
  calculateDeliveryCost,
} from '../app/lib/delivery/novapost/delivery-cost.ts';

const parcel = {
  cargoCategory: 'parcel' as const,
  actualWeightGrams: 1000,
};

test('CALC-COURIER: settlementId + street + building parses (city optional display)', () => {
  const parsed = parseDeliveryCostBody({
    parcels: [parcel],
    recipientSettlementId: 119638,
    recipientAddress: { street: 'вул. Гетьмана Івана Мазепи', building: '64' },
  });
  assert.ok(parsed);
  assert.equal(parsed.recipientSettlementId, 119638);
  assert.equal(parsed.recipientDivisionId, null);
  assert.equal(parsed.recipientAddress!.street, 'вул. Гетьмана Івана Мазепи');
  assert.equal(parsed.recipientAddress!.building, '64');
  assert.equal(parsed.recipientAddress!.city, null);
  assert.equal(parsed.recipientAddress!.flat, null);
});

test('CALC-COURIER: settlementId must be a strict positive integer', () => {
  const cases = [0, -1, 1.5, '119638', null];
  for (const recipientSettlementId of cases) {
    assert.equal(
      parseDeliveryCostBody({
        parcels: [parcel],
        recipientSettlementId,
        recipientAddress: { street: 's', building: 'b' },
      }),
      null,
      `settlementId=${String(recipientSettlementId)} must be rejected`
    );
  }
});

test('CALC-COURIER: settlementId requires street + building address parts', () => {
  assert.equal(
    parseDeliveryCostBody({ parcels: [parcel], recipientSettlementId: 119638 }),
    null
  );
  assert.equal(
    parseDeliveryCostBody({
      parcels: [parcel],
      recipientSettlementId: 119638,
      recipientAddress: { street: 's' },
    }),
    null
  );
  assert.equal(
    parseDeliveryCostBody({
      parcels: [parcel],
      recipientSettlementId: 119638,
      recipientAddress: { building: 'b' },
    }),
    null
  );
  assert.ok(
    parseDeliveryCostBody({
      parcels: [parcel],
      recipientSettlementId: 119638,
      recipientAddress: { street: 's', building: 'b', flat: '5' },
    })
  );
});

test('CALC-COURIER: XOR — settlementId and divisionId are mutually exclusive', () => {
  assert.equal(
    parseDeliveryCostBody({
      parcels: [parcel],
      recipientDivisionId: 42,
      recipientSettlementId: 119638,
      recipientAddress: { street: 's', building: 'b' },
    }),
    null
  );
});

test('CALC-COURIER: legacy free-text address (no settlementId) still requires city', () => {
  assert.ok(
    parseDeliveryCostBody({
      parcels: [parcel],
      recipientAddress: { city: 'Київ', street: 's', building: 'b' },
    })
  );
  // courier-shaped address without settlementId is invalid (city required)
  assert.equal(
    parseDeliveryCostBody({
      parcels: [parcel],
      recipientAddress: { street: 's', building: 'b' },
    }),
    null
  );
});

test('CALC-COURIER: provider body carries recipient.settlementId + addressParts', () => {
  const parsed = parseDeliveryCostBody({
    parcels: [parcel],
    recipientSettlementId: 119638,
    recipientAddress: { city: 'Кривий Ріг', street: 'вул. Хрещатик', building: '22', flat: '7' },
  })!;
  const body = toProviderBody(parsed, 11654) as Record<string, any>;
  assert.equal(body.payerType, 'Recipient');
  assert.equal(body.sender.divisionId, 11654);
  assert.equal(body.recipient.countryCode, 'UA');
  assert.equal(body.recipient.settlementId, 119638);
  assert.equal(body.recipient.divisionId, undefined);
  assert.equal(body.recipient.addressParts.city, 'Кривий Ріг');
  assert.equal(body.recipient.addressParts.street, 'вул. Хрещатик');
  assert.equal(body.recipient.addressParts.building, '22');
  assert.equal(body.recipient.addressParts.flat, '7');
});

test('CALC-COURIER: flat omitted from provider body when absent', () => {
  const parsed = parseDeliveryCostBody({
    parcels: [parcel],
    recipientSettlementId: 118064,
    recipientAddress: { street: 's', building: 'b' },
  })!;
  const body = toProviderBody(parsed) as Record<string, any>;
  assert.equal(body.recipient.settlementId, 118064);
  assert.equal('flat' in body.recipient.addressParts, false);
  assert.equal('city' in body.recipient.addressParts, false);
});

test('CALC-COURIER: warehouse body unchanged (no settlementId key)', () => {
  const parsed = parseDeliveryCostBody({
    parcels: [parcel],
    recipientDivisionId: 42,
  })!;
  const body = toProviderBody(parsed, 11654) as Record<string, any>;
  assert.equal(body.recipient.divisionId, 42);
  assert.equal('settlementId' in body.recipient, false);
  assert.equal('addressParts' in body.recipient, false);
  assert.equal(body.payerType, 'Recipient');
});

test('CALC-COURIER: courier client never overrides payerType', () => {
  const parsed = parseDeliveryCostBody({
    parcels: [parcel],
    recipientSettlementId: 119638,
    recipientAddress: { street: 's', building: 'b' },
  })!;
  const body = toProviderBody(parsed) as Record<string, any>;
  assert.equal(body.payerType, 'Recipient');
  // money fields can only come from parcels; no client-controlled cost key
  assert.equal('cost' in body, false);
  assert.equal('deliveryCost' in body, false);
});

test('CALC-COURIER: calculateDeliveryCost posts settlementId branch and normalizes', async () => {
  const calls: unknown[] = [];
  const client = {
    async postJson(path: string, body: unknown) {
      calls.push({ path, body });
      return {
        scheduledDeliveryDate: '2026-09-01T00:00:00Z',
        recipient: { settlementId: 119638, divisionId: null },
        services: [{ deliveryTypeName: 'Courier', cost: 85.5 }],
      };
    },
  } as unknown as Parameters<typeof calculateDeliveryCost>[0];

  const parsed = parseDeliveryCostBody({
    parcels: [parcel],
    recipientSettlementId: 119638,
    recipientAddress: { street: 's', building: 'b' },
  })!;
  const quote = await calculateDeliveryCost(client, parsed);

  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { path: string; body: unknown }).path, 'shipments/calculations');
  const sent = (calls[0] as { path: string; body: Record<string, any> }).body;
  assert.equal(sent.recipient.settlementId, 119638);
  assert.equal(sent.payerType, 'Recipient');
  const service = quote.services[0];
  assert.ok(service !== undefined);
  assert.equal(service.cost, 85.5);
  assert.equal(quote.recipientSettlementId, 119638);
});
