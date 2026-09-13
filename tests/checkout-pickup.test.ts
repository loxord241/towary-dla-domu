/**
 * «Самовивіз, Кривий Ріг» — checkout pickup flow (2026-09-12).
 *
 * Two pickup points split by cart domain (owner decision): техника —
 * вул. Гетьмана Івана Мазепи, 87А, шпалери (wc-*) — вул. Серафимовича,
 * 83А; a mixed cart offers BOTH points with a «весь заказ будет ждать на
 * обраній точці» warning. Payment: online LiqPay as usual OR cash at the
 * point (paymentIntent in shipping_info.delivery; the order page hides the
 * LiqPay button for cash_on_pickup).
 *
 * Covers:
 *  1. sanitizeDelivery — pickup branch: whitelisted points, canonical
 *     server-side address, default paymentIntent 'online',
 *     cash_on_pickup accepted; carrier fields on a pickup order, an
 *     unknown point, a bad paymentIntent and paymentIntent on a CARRIER
 *     order are all invalid (fail-closed); the carrier contract
 *     (settlementId required, ON CONFLICT of keys) is unchanged.
 *  2. CheckoutForm static pins — pickup branch first in deliveryObject,
 *     cart-domain detection via slug wc-, mixed-cart warning, payment
 *     radios, mobile contract (min-h-[44px]), «Безкоштовно (самовивіз)»
 *     cost line while the carrier line stays pinned.
 *  3. Telegram notice — «Самовивіз, <точка>» line + «готівка при
 *     отриманні» payment line; the Ukrposhta label bug (UP orders printed
 *     as «Нова Пошта») is fixed while we're in SERVICE_LABELS.
 *  4. Order page — LiqPay button hidden for cash_on_pickup, green
 *     «Оплата при отриманні» notice instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  describeDelivery,
  deliveryPaymentIntent,
  buildOrderNotificationMessage,
  type OrderNotificationData,
} from '../app/lib/notifications/telegram.ts';
import {
  sanitizeDelivery,
  PICKUP_POINTS,
  PICKUP_PAYMENT_INTENTS,
} from '../app/lib/checkout-delivery.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const FORM = src('app/checkout/CheckoutForm.tsx');
const ORDER_PAGE = src('app/orders/[orderNumber]/page.tsx');
// 2026-09-13 mechanical split: the pickup UI (points + payment radios +
// mixed-cart warning) lives in PickupBlock.tsx, the carrier/service buttons
// (min-h-[44px]) in DeliveryCarrierPicker.tsx, the cost lines in
// OrderSummary.tsx. Pins target the file where the pinned code lives.
const PICKUP_BLOCK = src('app/checkout/parts/PickupBlock.tsx');
const CARRIER_PICKER = src('app/checkout/parts/DeliveryCarrierPicker.tsx');
const ORDER_SUMMARY = src('app/checkout/parts/OrderSummary.tsx');
// NB: do NOT stripJsComments these sources — the naive block-comment
// regex trips on «(/api/delivery/ukrposhta/*)» in a CheckoutForm comment
// and swallows half the file. The pins below are comment-tolerant as-is.

// ---------------------------------------------------------------------------
// 1. sanitizeDelivery — pickup contract
// ---------------------------------------------------------------------------

const okPickup = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  serviceType: 'pickup',
  pickupPointId: 'kr-mazepy-87a',
  ...over,
});

test('PICKUP sanitize: whitelisted points, canonical address, default online', () => {
  for (const point of PICKUP_POINTS) {
    const res = sanitizeDelivery(okPickup({ pickupPointId: point.id }));
    assert.equal(res.kind, 'ok', `point ${point.id} must be accepted`);
    if (res.kind !== 'ok') continue;
    assert.equal(res.value.serviceType, 'pickup');
    assert.equal(res.value.pickupPointId, point.id);
    // The display address is canonical server-side — never client text.
    assert.equal(res.value.pickupPointName, `${point.city}, ${point.address}`);
    assert.equal(res.value.settlementName, point.city);
    assert.equal(res.value.paymentIntent, 'online', 'default is online');
    assert.equal(res.value.settlementId, undefined, 'pickup has no carrier ids');
  }
  // Both owner-defined points exist with the contracted addresses.
  assert.deepEqual(
    PICKUP_POINTS.map((p) => p.address),
    ['вул. Гетьмана Івана Мазепи, 87А', 'вул. Серафимовича, 83А']
  );
  assert.deepEqual([...PICKUP_PAYMENT_INTENTS], ['online', 'cash_on_pickup']);
});

test('PICKUP sanitize: cash_on_pickup accepted, client address text never trusted', () => {
  const res = sanitizeDelivery(
    okPickup({
      paymentIntent: 'cash_on_pickup',
      pickupPointName: 'Мій підвал',
      settlementName: 'Інше місто',
    })
  );
  assert.equal(res.kind, 'ok');
  if (res.kind !== 'ok') return;
  assert.equal(res.value.paymentIntent, 'cash_on_pickup');
  assert.equal(
    res.value.pickupPointName,
    'Кривий Ріг, вул. Гетьмана Івана Мазепи, 87А',
    'client text overridden by the canonical PICKUP_POINTS address'
  );
});

test('PICKUP sanitize: fail-closed — unknown point, carrier fields, bad intent', () => {
  // Unknown / missing / non-string point id.
  for (const pickupPointId of ['kr-nebugska-1', '', 42, null, undefined]) {
    const res = sanitizeDelivery(okPickup({ pickupPointId }));
    assert.equal(res.kind, 'invalid', `point ${String(pickupPointId)} must be rejected`);
  }
  // ANY carrier field on a pickup order rejects the whole object.
  for (const over of [
    { settlementId: 1 },
    { settlementId: 1, settlementName: 'Кривий Ріг' },
    { divisionId: 5 },
    { streetName: 'x' },
    { building: '1' },
    { flat: '2' },
  ]) {
    assert.equal(sanitizeDelivery(okPickup(over)).kind, 'invalid', JSON.stringify(over));
  }
  // Bad payment intent values.
  for (const paymentIntent of ['cash', 'on_delivery', 42, null]) {
    assert.equal(
      sanitizeDelivery(okPickup({ paymentIntent })).kind,
      'invalid',
      `intent ${String(paymentIntent)} must be rejected`
    );
  }
  // Unknown keys stay rejected.
  assert.equal(sanitizeDelivery(okPickup({ deliveryCost: 0 })).kind, 'invalid');
});

test('CARRIER sanitize: paymentIntent is pickup-only; carrier contract unchanged', () => {
  // A carrier order carrying paymentIntent (e.g. «cash on delivery») is
  // malformed — cash on pickup does not exist for NP/UP.
  const np = {
    serviceType: 'nova_poshta_warehouse',
    settlementId: 123,
    settlementName: 'Кривий Ріг',
    divisionId: 5,
    paymentIntent: 'cash_on_pickup',
  };
  assert.equal(sanitizeDelivery(np).kind, 'invalid');
  // …and the same NP order WITHOUT paymentIntent stays valid.
  const { paymentIntent: _drop, ...clean } = np;
  const res = sanitizeDelivery(clean);
  assert.equal(res.kind, 'ok');
  if (res.kind === 'ok') {
    assert.equal(res.value.paymentIntent, undefined);
    assert.equal(res.value.settlementId, 123);
  }
  // settlementId is still required for carriers.
  assert.equal(
    sanitizeDelivery({ serviceType: 'nova_poshta_warehouse', settlementName: 'x', divisionId: 1 }).kind,
    'invalid'
  );
});

// ---------------------------------------------------------------------------
// 2. CheckoutForm static pins
// ---------------------------------------------------------------------------

const formCode = FORM;

test('PICKUP form: deliveryObject branch — pickup first, wc- domain detection', () => {
  const pickupIdx = formCode.indexOf("if (deliveryType === 'pickup') {");
  const upIdx = formCode.indexOf("if (deliveryType === 'ukrposhta_warehouse') {");
  assert.ok(pickupIdx !== -1 && upIdx !== -1 && pickupIdx < upIdx, 'pickup branch first');
  // Cart-domain detection via the shared domains module (2026-09-13: the
  // inline wc- literal became isWallpaperSlug — single source of truth).
  assert.match(formCode, /cartHasWallpapers = lines\.some\(\(l\) => isWallpaperSlug\(l\.slug\)\)/);
  assert.match(formCode, /cartHasTech = lines\.some\(\(l\) => !isWallpaperSlug\(l\.slug\)\)/);
  // Both points offered on a mixed cart…
  assert.match(formCode, /availablePickupPoints = PICKUP_POINTS\.filter\(/);
  // …with the honest mixed-cart warning (rendered by PickupBlock).
  assert.match(PICKUP_BLOCK, /У кошику товари обох напрямків — усе замовлення буде\s+чекати на обраній точці\./);
  // NP city search must NOT render for pickup.
  assert.match(formCode, /deliveryType !== 'pickup' &&/);
});

test('PICKUP form: payment radios + cash flows through delivery.paymentIntent', () => {
  assert.match(PICKUP_BLOCK, /Карткою онлайн \(LiqPay\) після оформлення/);
  assert.match(PICKUP_BLOCK, /Готівкою при отриманні на точці/);
  assert.match(PICKUP_BLOCK, /name="pickup-payment"/);
  const branch = formCode.slice(
    formCode.indexOf("if (deliveryType === 'pickup') {"),
    formCode.indexOf("if (deliveryType === 'ukrposhta_warehouse') {")
  );
  assert.match(branch, /paymentIntent,/);
  assert.match(branch, /pickupPointId: point\.id/);
  // city for a pickup order is the point city (settlement state is null).
  assert.match(formCode, /deliveryType === 'pickup'\s*\?\s*'Кривий Ріг'/);
});

test('PICKUP form: mobile contract + cost line pins stay honest', () => {
  // Tap targets on the point buttons and payment labels. After the split
  // the same 5 occurrences live across the carrier picker (carrier blocks
  // + service buttons) and the pickup block (point buttons + labels) —
  // the combined count must stay ≥5, as before the split.
  const tapTargets =
    (CARRIER_PICKER.match(/min-h-\[44px\]/g) ?? []).length +
    (PICKUP_BLOCK.match(/min-h-\[44px\]/g) ?? []).length;
  assert.equal(
    tapTargets >= 5,
    true,
    'carrier blocks + service buttons + point buttons + payment labels ≥44px'
  );
  // Pickup cost line replaces the carrier one conditionally — both strings
  // stay in the source (stage2g money pin), now in OrderSummary.
  assert.match(ORDER_SUMMARY, /Безкоштовно \(самовивіз\)/);
  assert.match(ORDER_SUMMARY, /за тарифами перевізника/);
});

// ---------------------------------------------------------------------------
// 3. Telegram notice
// ---------------------------------------------------------------------------

const BASE_DATA: OrderNotificationData = {
  orderId: '11111111-2222-3333-4444-555555555555',
  orderNumber: 'TD-100500',
  total: 320,
  currency: 'UAH',
  customerName: 'Тест Тестовий',
  customerPhone: '+380971234567',
  customerEmail: 't@e.co',
  paymentMethod: null,
  delivery: null,
  items: [
    { name: 'Шпалери', variantName: null, sku: 'wc-x1', quantity: 1, price: 320, total: 320 },
  ],
};

test('TELEGRAM: pickup delivery line carries the point address', () => {
  const line = describeDelivery({
    serviceType: 'pickup',
    settlementName: 'Кривий Ріг',
    pickupPointName: 'Кривий Ріг, вул. Серафимовича, 83А',
    paymentIntent: 'cash_on_pickup',
  });
  assert.equal(line, 'Самовивіз, Кривий Ріг, вул. Серафимовича, 83А');
  // Degraded row (no point name) still names the city.
  assert.equal(
    describeDelivery({ serviceType: 'pickup', settlementName: 'Кривий Ріг' }),
    'Самовивіз, Кривий Ріг'
  );
});

test('TELEGRAM: cash_on_pickup order announces the cash payment line', () => {
  const cash = buildOrderNotificationMessage({
    ...BASE_DATA,
    delivery: {
      serviceType: 'pickup',
      pickupPointName: 'Кривий Ріг, вул. Серафимовича, 83А',
      paymentIntent: 'cash_on_pickup',
    },
  });
  // 2026-09-13: message rework — cash line now tells the owner what to do.
  assert.match(cash, /Оплата: 💰 готівка на точці — познач «Оплачено» після отримання коштів/);
  assert.match(cash, /НОВЕ ЗАМОВЛЕННЯ — підтверди його!/);
  assert.match(cash, /Доставка: Самовивіз, Кривий Ріг, вул\. Серафимовича, 83А/);
  // Online pickup order keeps the honest default line.
  const online = buildOrderNotificationMessage({
    ...BASE_DATA,
    delivery: { serviceType: 'pickup', pickupPointName: 'Кривий Ріг, вул. Гетьмана Івана Мазепи, 87А' },
  });
  assert.match(online, /Оплата: ще не вибрана \(посилання LiqPay у покупця\)/);
});

test('TELEGRAM: Ukrposhta orders no longer print as Нова Пошта (label bug fix)', () => {
  assert.equal(
    describeDelivery({
      serviceType: 'ukrposhta_warehouse',
      settlementName: 'Кривий Ріг',
      divisionName: 'Відділення № 1',
    }),
    'Укрпошта — відділення, Кривий Ріг, Відділення № 1'
  );
  assert.equal(deliveryPaymentIntent({ paymentIntent: 'cash_on_pickup' }), 'cash_on_pickup');
  assert.equal(deliveryPaymentIntent(null), '');
});

// ---------------------------------------------------------------------------
// 4. Order page — LiqPay hidden for cash_on_pickup
// ---------------------------------------------------------------------------

const orderPageCode = ORDER_PAGE;

test('ORDER PAGE: LiqPay hidden for cash_on_pickup, green notice instead', () => {
  // paymentIntent read from shipping_info.delivery (server-side row, no
  // URL trust)…
  assert.match(orderPageCode, /shipping_info/);
  assert.match(orderPageCode, /deliveryInfo\?\.paymentIntent === 'cash_on_pickup'/);
  // …LiqPay button gated OFF for cash…
  assert.match(orderPageCode, /!cashOnPickup &&\s*\(order\.payment_status === 'unpaid'/);
  // …and the honest notice in its place.
  assert.match(orderPageCode, /Оплата при отриманні: готівкою на точці самовивоза\./);
});
