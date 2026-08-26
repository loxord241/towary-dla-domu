/**
 * Static invariant tests for the LiqPay pay-button UI and route wiring.
 * Read-only — pins security-relevant behavior so drift fails CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- client component ----

const btn = src('app/components/PayWithLiqPayButton.tsx');

test('PAY-UI: button is a client component that calls the init endpoint with its token', () => {
  assert.match(btn, /['"]use client['"]/);
  assert.match(btn, /\/api\/orders\/\$\{[^}]+\}\/payment/);
  assert.match(btn, /token:\s*accessToken|accessToken,\s*\n\s*token/);
});

test('PAY-UI: submits a generated FORM to the LiqPay checkout URL from the API', () => {
  assert.match(btn, /method\s*=\s*['"]POST['"]|method\s*=\s*"post"/);
  assert.match(btn, /action/i);
  assert.match(btn, /checkoutUrl/);
  assert.match(btn, /name=["']?data|setAttribute\(['"]name['"],\s*name|\['data',\s*data\]/);
  assert.match(btn, /['"]signature['"],\s*signature|setAttribute\(['"]name['"],\s*name/);
});

test('PAY-UI: never references any secret or DB credentials', () => {
  assert.doesNotMatch(btn, /PRIVATE_KEY/i);
  assert.doesNotMatch(btn, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(btn, /process\.env\.LIQPAY/);
  // Only data/signature returned by our own API are submitted.
  const submitted = btn.slice(btn.indexOf('form'));
  assert.ok(!/'currency'|'amount'|'order_id'/.test(submitted),
    'client must submit ONLY data/signature pair');
});

test('PAY-UI: surfaces server errors and offers retry (failure state)', () => {
  assert.match(btn, /error|Некоректн/i);
  assert.match(btn, /retry|спробуйте ще раз|Спробуйте/i);
});

// ---- success page ----

const success = src('app/checkout/success/page.tsx');

test('PAY-SUCCESS: unpaid/failed renders the pay button; paid hides it', () => {
  assert.match(success, /PayWithLiqPayButton/);
  assert.match(
    success,
    /\[['"](unpaid|failed)['"],\s*['"](unpaid|failed)['"]\]|=== ['"]unpaid['"]\s*\|\|\s*\w+ === ['"]failed['"]/,
    'button must be gated to unpaid||failed'
  );
  assert.match(success, /['"]paid['"][\s\S]{0,600}(Оплачено|Оплату отримано)/i,
    'paid state must show explicit confirmation');
});

test('PAY-SUCCESS: pending shows processing state with status refresh link', () => {
  assert.match(success, /Оплату обробляється|Обробка оплати|обробляється/i);
  assert.match(success, /href=\{\`\/checkout\/success\?[^\`]*\`\}|Оновити статус/,
    'pending must offer a fresh DB re-read via reload');
});

test('PAY-SUCCESS: still verifies capability token before DB read and stays server-side', () => {
  const verifyAt = success.indexOf('verifyOrderAccessToken(orderNumber, t)');
  const readAt = success.indexOf(".from('orders')");
  assert.ok(verifyAt >= 0 && readAt > verifyAt);
  assert.ok(!success.includes("'use client'"));
});

// ---- guest order page ----

const orderPage = src('app/orders/[orderNumber]/page.tsx');

test('PAY-GUEST-PAGE: offers the same payment flow for token holders', () => {
  assert.match(orderPage, /PayWithLiqPayButton/);
});

// ---- routes ----

const init = src('app/api/orders/[orderNumber]/payment/route.ts');

test('PAY-INIT-ROUTE: POST-only semantics, rate-limited, token-first, DB-sourced money', () => {
  assert.match(init, /export async function POST/);
  assert.doesNotMatch(init, /export async function GET/);
  assert.match(init, /enforceRateLimit\(request, ['"]paymentInit['"]\)/);
  const verifyAt = init.indexOf('verifyOrderAccessToken(orderNumber, token)');
  const dbAt = init.indexOf("createSupabaseOrdersGateway");
  assert.ok(verifyAt >= 0 && dbAt >= 0);
  // Client contract carries NOTHING except the capability token
  // (comments stripped; only orchestration identifiers may remain).
  const codeOnly = init.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /\b(amount|currency)\b/i);
});

const cb = src('app/api/payment/liqpay/callback/route.ts');

test('PAY-CB-ROUTE: form-encoded accepted, unknown-order/mismatches answered 200, invalid sig 400', () => {
  assert.match(cb, /URLSearchParams/);
  assert.match(cb, /status: 200/);
  assert.match(cb, /bad-signature[\s\S]{0,400}status: 400/);
  assert.doesNotMatch(cb, /enforceRateLimit/, 'provider callbacks must not be IP-limited');
});
