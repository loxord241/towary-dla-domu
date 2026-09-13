/**
 * Order handling in one tap (owner 2026-09-13, «перший заказ!»):
 *   1. Telegram inline keyboard under the order notification
 *      (✅ Підтвердити / 💰 Оплачено [cash only] / ❌ Скасувати / 🌐 Адмінка);
 *   2. /api/telegram/webhook — secret-header verified callback handler that
 *      applies actions through the SAME admin RPCs and ALWAYS answers 200;
 *   3. POST /api/admin/orders/[id]/mark-paid — manual cash payment
 *      confirmation (conditional paid + pending→confirmed);
 *   4. LiqPay auto-confirm: a `paid` callback advances pending→confirmed.
 *
 * Runtime coverage for the pure action layer (parse/authorize/apply) runs
 * the REAL app/lib/telegram-order-actions.ts; routes are pinned statically
 * per the admin-route test convention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const actions = await import(
  pathToFileURL(path.join(root, 'app/lib/telegram-order-actions.ts')).href
);
const {
  webhookSecret,
  isAuthorizedRequest,
  parseCallbackData,
  parseUpdate,
  applyAction,
  withStatusLine,
} = actions;

// ---------------------------------------------------------------------------
// 1. auth + parsing
// ---------------------------------------------------------------------------

const TOKEN = 'TESTTOKEN:abc123';

test('WEBHOOK AUTH: derived secret is stable and header check is timing-safe', () => {
  assert.equal(webhookSecret(TOKEN), webhookSecret(TOKEN));
  assert.match(webhookSecret(TOKEN), /^[0-9a-f]{64}$/);
  assert.equal(isAuthorizedRequest(webhookSecret(TOKEN), TOKEN), true);
  for (const bad of [null, undefined, '', 'garbage', webhookSecret('OTHER')]) {
    assert.equal(isAuthorizedRequest(bad as never, TOKEN), false, String(bad));
  }
  assert.equal(isAuthorizedRequest(webhookSecret(TOKEN), null), false);
});

test('WEBHOOK PARSE: callback data and update shapes', () => {
  const ok = parseCallbackData('ord:ORD-20260913-ABC123:confirm');
  assert.deepEqual(ok, { orderNumber: 'ORD-20260913-ABC123', action: 'confirm' });
  assert.equal(parseCallbackData('ord:ORD-1:paid')?.action, 'paid');
  assert.equal(parseCallbackData('ord:ORD-1:cancel')?.action, 'cancel');
  for (const bad of [
    null, undefined, 42, '', 'ord', 'ord:', 'ord:ORD-1:refund',
    'other:ORD-1:confirm', 'ord:ORD:1:extra:confirm', 'ord::confirm',
  ]) {
    assert.equal(parseCallbackData(bad), null, String(bad));
  }
  const update = {
    callback_query: {
      id: 'cbq1',
      data: 'ord:ORD-20260913-ABC123:paid',
      message: { message_id: 77, chat: { id: 424242 } },
    },
  };
  assert.deepEqual(parseUpdate(update), {
    id: 'cbq1',
    orderNumber: 'ORD-20260913-ABC123',
    action: 'paid',
    chatId: 424242,
    messageId: 77,
  });
  assert.equal(parseUpdate({ message: { text: 'hi' } }), null);
  assert.equal(parseUpdate({ callback_query: { id: 'x', data: 'junk', message: {} } }), null);
  assert.equal(parseUpdate('string'), null);
});

// ---------------------------------------------------------------------------
// 2. applyAction over a stub gateway
// ---------------------------------------------------------------------------

interface StubState {
  row: ReturnType<typeof makeRow> | null;
  confirmCalls: number;
  cancelCalls: number;
  paidCalls: number;
  confirmResult: 'ok' | 'conflict';
  cancelResult: 'ok' | 'conflict';
  paidResult: 'ok' | 'already-paid';
}

function makeRow(over: Partial<Parameters<typeof applyAction>[1]> = {}) {
  return {
    id: 'uuid-1',
    order_number: 'ORD-1',
    status: 'pending',
    payment_status: 'unpaid',
    payment_method: null,
    ...over,
  };
}

function stub(state: StubState): Parameters<typeof applyAction>[2] {
  return {
    async order() { return state.row; },
    async confirm() { state.confirmCalls += 1; return state.confirmResult; },
    async cancel() { state.cancelCalls += 1; return state.cancelResult; },
    async markPaid() { state.paidCalls += 1; return state.paidResult; },
  };
}

test('APPLY confirm: pending → confirmed; already-confirmed is a noop', async () => {
  const s1: StubState = {
    row: makeRow(), confirmCalls: 0, cancelCalls: 0, paidCalls: 0,
    confirmResult: 'ok', cancelResult: 'ok', paidResult: 'ok',
  };
  const r1 = await applyAction('confirm', makeRow(), stub(s1));
  assert.equal(r1.kind, 'ok');
  assert.equal(s1.confirmCalls, 1);
  assert.match((r1 as { statusLine: string }).statusLine, /Підтверджено/);

  const s2: StubState = {
    row: makeRow({ status: 'confirmed' }), confirmCalls: 0, cancelCalls: 0, paidCalls: 0,
    confirmResult: 'ok', cancelResult: 'ok', paidResult: 'ok',
  };
  const r2 = await applyAction('confirm', makeRow({ status: 'confirmed' }), stub(s2));
  assert.equal(r2.kind, 'noop');
  assert.equal(s2.confirmCalls, 0, 'no RPC for a wrong state');
});

test('APPLY cancel: pending/confirmed allowed, shipped refuses, RPC = admin_cancel_order', async () => {
  const s1: StubState = {
    row: makeRow(), confirmCalls: 0, cancelCalls: 0, paidCalls: 0,
    confirmResult: 'ok', cancelResult: 'ok', paidResult: 'ok',
  };
  const r1 = await applyAction('cancel', makeRow(), stub(s1));
  assert.equal(r1.kind, 'ok');
  assert.equal(s1.cancelCalls, 1);

  const s2: StubState = {
    row: makeRow({ status: 'shipped' }), confirmCalls: 0, cancelCalls: 0, paidCalls: 0,
    confirmResult: 'ok', cancelResult: 'ok', paidResult: 'ok',
  };
  const r2 = await applyAction('cancel', makeRow({ status: 'shipped' }), stub(s2));
  assert.equal(r2.kind, 'noop');
  assert.equal(s2.cancelCalls, 0);
});

test('APPLY paid: marks paid and confirms pending in one tap; respects already-paid', async () => {
  const s1: StubState = {
    row: makeRow(), confirmCalls: 0, cancelCalls: 0, paidCalls: 0,
    confirmResult: 'ok', cancelResult: 'ok', paidResult: 'ok',
  };
  const r1 = await applyAction('paid', makeRow(), stub(s1));
  assert.equal(r1.kind, 'ok');
  assert.equal(s1.paidCalls, 1);
  assert.equal(s1.confirmCalls, 1, 'pending order is confirmed in the same tap');
  assert.match((r1 as { statusLine: string }).statusLine, /Оплачено/);

  // already paid → pure noop (no double confirmation either)
  const s2: StubState = {
    row: makeRow({ payment_status: 'paid', payment_method: 'card:privat24' }),
    confirmCalls: 0, cancelCalls: 0, paidCalls: 0,
    confirmResult: 'ok', cancelResult: 'ok', paidResult: 'ok',
  };
  const r2 = await applyAction('paid', makeRow({ payment_status: 'paid' }), stub(s2));
  assert.equal(r2.kind, 'noop');
  assert.equal(s2.paidCalls, 0);
  assert.equal(s2.confirmCalls, 0);

  // confirmed order: paid stamps WITHOUT a confirm RPC
  const s3: StubState = {
    row: makeRow({ status: 'confirmed' }), confirmCalls: 0, cancelCalls: 0, paidCalls: 0,
    confirmResult: 'ok', cancelResult: 'ok', paidResult: 'ok',
  };
  const r3 = await applyAction('paid', makeRow({ status: 'confirmed' }), stub(s3));
  assert.equal(r3.kind, 'ok');
  assert.equal(s3.paidCalls, 1);
  assert.equal(s3.confirmCalls, 0);

  // cancelled orders refuse everything
  const s4: StubState = {
    row: makeRow({ status: 'cancelled' }), confirmCalls: 0, cancelCalls: 0, paidCalls: 0,
    confirmResult: 'ok', cancelResult: 'ok', paidResult: 'ok',
  };
  const r4 = await applyAction('paid', makeRow({ status: 'cancelled' }), stub(s4));
  assert.equal(r4.kind, 'noop');
  assert.equal(s4.paidCalls, 0);
});

test('STATUS LINE: appends once, replaces on a second press', () => {
  const once = withStatusLine('🔔🛒 НОВЕ ЗАМОВЛЕННЯ\n№: X', '✅ Підтверджено');
  assert.match(once, /\n—+\n✅ Підтверджено$/);
  const twice = withStatusLine(once, '❌ Скасовано');
  assert.equal((twice.match(/\n—+\n/g) ?? []).length, 1, 'old status line replaced');
  assert.match(twice, /\n—+\n❌ Скасовано$/);
  assert.ok(twice.startsWith('🔔🛒 НОВЕ ЗАМОВЛЕННЯ\n№: X'), 'original text preserved');
});

// ---------------------------------------------------------------------------
// 3. Static pins: webhook route, mark-paid route, keyboard, admin UI
// ---------------------------------------------------------------------------

const WH = src('app/api/telegram/webhook/route.ts');
const MP = src('app/api/admin/orders/[id]/mark-paid/route.ts');
const TG = src('app/lib/notifications/telegram.ts');

test('ROUTE webhook: secret gate BEFORE parse; always-200 contract', () => {
  assert.match(WH, /isAuthorizedRequest\(request\.headers\.get\('x-telegram-bot-api-secret-token'\), token\)/);
  assert.match(WH, /status: 401/);
  // broken JSON and non-callback updates answer ok:true (no retries)
  assert.match(WH, /return Response\.json\(\{ ok: true \}\)/);
  // actions go through the admin RPCs
  assert.match(WH, /admin_set_order_status/);
  assert.match(WH, /admin_cancel_order/);
  // paid is conditional (never overwrites a paid order)
  assert.match(WH, /\.neq\('payment_status', 'paid'\)/);
  // no parse_mode anywhere in the webhook
  assert.doesNotMatch(WH, /parse_mode/);
});

test('TELEGRAM keyboard: buttons wired into the order send path', () => {
  assert.match(TG, /buildOrderNotificationKeyboard/);
  assert.match(TG, /ord:\$\{data\.orderNumber\}:confirm/);
  assert.match(TG, /ord:\$\{data\.orderNumber\}:cancel/);
  assert.match(TG, /ord:\$\{data\.orderNumber\}:paid/);
  // paid button only for cash-on-pickup without a stamped method
  assert.match(TG, /deliveryPaymentIntent\(data\.delivery\) === 'cash_on_pickup' &&\s+!data\.paymentMethod/);
  // the send path passes the keyboard as reply_markup
  assert.match(TG, /reply_markup: replyMarkup/);
  // admin deep link button
  assert.match(TG, /admin\/orders\/\$\{data\.orderId\}/);
});

test('ROUTE mark-paid: admin guard, conditional paid, pending→confirmed RPC', () => {
  assert.match(MP, /requireAdminApi\(\)/);
  assert.match(MP, /isUuid\(id\)/);
  assert.match(MP, /payment_status: 'paid', payment_method: 'готівка на точці'/);
  assert.match(MP, /\.neq\('payment_status', 'paid'\)/);
  assert.match(MP, /admin_set_order_status/);
  assert.match(MP, /p_new_status: 'confirmed'/);
  // unknown order → 404
  assert.match(MP, /Замовлення не знайдено/);
});

test('LIQPAY auto-confirm: only for paid, through the admin RPC, P0409-tolerant', () => {
  const cb = src('app/api/payment/liqpay/callback/route.ts');
  assert.match(cb, /res\.kind === 'updated' && res\.status === 'paid'/);
  assert.match(cb, /admin_set_order_status/);
  assert.match(cb, /P0409/);
  // the lib carries the order id out for the paid branch only
  const lib = src('app/lib/payment/order-payment-update.ts');
  assert.match(lib, /order_id: order\.id/);
});

test('ADMIN UI: one-tap actions in the list, modal and order page', () => {
  const list = src('app/admin/(dashboard)/orders/page.tsx');
  // list row: confirm for pending only
  assert.match(list, /\{order\.status === 'pending' && \(/);
  assert.match(list, /✅ Підтвердити/);
  assert.match(list, /status: 'confirmed'/);
  // modal: mark-paid for unpaid pending/confirmed
  assert.match(list, /💰 Оплачено \(готівка\)/);
  assert.match(list, /\/mark-paid/);

  const card = src('app/admin/(dashboard)/orders/[id]/page.tsx');
  assert.match(card, /✅ Підтвердити замовлення/);
  assert.match(card, /💰 Оплачено \(готівка\)/);
  assert.match(card, /❌ Скасувати/);
  // mobile contract on the action bar
  assert.match(card, /min-h-\[44px\]/);
});
