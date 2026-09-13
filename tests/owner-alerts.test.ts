/**
 * Owner error alerts (owner request 2026-09-13, «можно»): critical
 * server-side failures ring the owner's Telegram — checkout 500, payment
 * misconfiguration, LiqPay money-integrity anomalies and lost
 * auto-confirm. Throttled per scope, fire-and-forget, no new env.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const TG = src('app/lib/notifications/telegram.ts');

test('ALERTS: throttled, fire-and-forget, reuses the order-notification config', () => {
  assert.match(TG, /export function sendOwnerErrorAlert\(/);
  assert.match(TG, /resolveTelegramOrderConfig\(\)/, 'no new env — same bot + chats');
  assert.match(TG, /ERROR_ALERT_THROTTLE_MS = 5 \* 60_000/);
  assert.match(TG, /lastAlertAt\.get\(scope\)/);
  // an alerting failure must never become an error itself
  assert.match(TG, /} catch \{\n    \/\/ an alerting failure must never become an error itself/);
});

test('ALERTS: checkout 500 rings the bell with the RPC error detail', () => {
  const route = src('app/api/orders/route.ts');
  const alertAt = route.indexOf('sendOwnerErrorAlert(');
  const defaultAt = route.indexOf("case 'P0422'");
  assert.ok(alertAt > defaultAt, 'alert lives in the default (500) branch');
  assert.match(route, /checkout: не вдалося створити замовлення/);
  // client-visible errors (400/409/422) stay silent — no alert noise
  assert.equal(route.indexOf("sendOwnerErrorAlert("), route.lastIndexOf("sendOwnerErrorAlert("));
});

test('ALERTS: liqpay callback alerts on money anomalies + lost auto-confirm', () => {
  const cb = src('app/api/payment/liqpay/callback/route.ts');
  assert.match(cb, /amount-mismatch'\s*\|\|\s*res\.kind === 'currency-mismatch'/);
  assert.match(cb, /unknown-order'/);
  assert.match(cb, /оплата пройшла, авто-підтвердження/);
  // bot noise stays log-only: the first alert sits well AFTER the
  // bad-signature case (the comment mention doesn't count — measure from
  // the case label itself)
  const badAt = cb.indexOf("case 'bad-signature'");
  const firstAlert = cb.indexOf('sendOwnerErrorAlert(');
  assert.ok(firstAlert > badAt && firstAlert - badAt > 200,
    'bad-signature case must not alert');
});

test('ALERTS: payment init 503 (LiqPay unconfigured) alerts the owner', () => {
  const init = src('app/api/orders/[orderNumber]/payment/route.ts');
  assert.match(init, /sendOwnerErrorAlert\(/);
  assert.match(init, /LiqPay не налаштований/);
});
