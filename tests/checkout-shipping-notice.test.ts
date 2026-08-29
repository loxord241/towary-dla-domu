/**
 * Static invariants for the 2026-08-29 shipping-period notice + working hours.
 *
 * The success page and contacts page are server components with JSX, which
 * node:test cannot execute directly (no JSX transform in the test runner —
 * same constraint as tests/ux-fixes.test.ts). Following the established
 * ux-fixes / storefront-icons pattern, these tests pin the SOURCE invariants
 * so a revert or regression fails loudly.
 *
 * Behaviour contract:
 *   - after a successful checkout the user sees a modal with the shipping
 *     period text on /checkout/success (only when a valid order was loaded);
 *   - the NotFound branch (invalid token / unknown order) must NOT show it;
 *   - the checkout form itself is untouched (redirect flow stays as-is);
 *   - the contacts page block states the working hours.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const EXACT_SHIPPING_TEXT = 'Період відправлення замовлення від 3 до 5 робочих днів.';
const EXACT_HOURS_TEXT = 'Час роботи: 7:30–16:00';

// ---- 1. shipping-period notice component ----

test('ShippingPeriodNotice: modal renders the exact shipping-period text', () => {
  const notice = src('app/components/ShippingPeriodNotice.tsx');
  assert.ok(notice.includes(EXACT_SHIPPING_TEXT));
});

test('ShippingPeriodNotice: is a proper UI modal (no browser alert), with a close control', () => {
  const notice = src('app/components/ShippingPeriodNotice.tsx');
  assert.match(notice, /'use client'/);
  assert.match(notice, /role="dialog"/);
  assert.match(notice, /aria-modal="true"/);
  // explicit close/continue button — alert() is forbidden by the task
  assert.ok(!notice.includes('alert('), 'browser alert() must not be used');
  assert.match(notice, /aria-label="Закрити вікно"/);
  assert.match(notice, /Продовжити/);
  // mobile-safe: bottom sheet on small screens, centered from sm up
  assert.match(notice, /max-w-md/);
  assert.match(notice, /rounded-t-xl/);
  assert.match(notice, /sm:rounded-xl/);
});

// ---- 2. shown only on the successful success-page branch ----

test('success page: notice is rendered after a confirmed order loads', () => {
  const page = src('app/checkout/success/page.tsx');
  assert.match(page, /import ShippingPeriodNotice/);
  assert.match(page, /<ShippingPeriodNotice\b/);
});

test('success page: NotFound branch (invalid token / unknown order) never shows the notice', () => {
  const page = src('app/checkout/success/page.tsx');
  const notFoundStart = page.indexOf('function NotFound()');
  const notFoundEnd = page.indexOf('export default async function CheckoutSuccessPage');
  assert.ok(notFoundStart !== -1 && notFoundEnd > notFoundStart);
  const notFoundBranch = page.slice(notFoundStart, notFoundEnd);
  assert.ok(
    !notFoundBranch.includes('ShippingPeriodNotice'),
    'the notice must not render when the order could not be verified'
  );
});

// ---- 3. checkout flow did not regress ----

test('checkout: success redirect contract (order + access token) is unchanged', () => {
  const form = src('app/checkout/CheckoutForm.tsx');
  assert.match(form, /router\.replace\(\s*`\/checkout\/success\?order=/);
  assert.match(form, /data\.orderNumber/);
  assert.match(form, /data\.accessToken/);
  // the notice is success-flow only — the checkout form must not render it
  assert.ok(!form.includes('ShippingPeriodNotice'));
});

// ---- 4. working hours in the existing contact-information block ----

test('contacts page: existing contact block states the exact working hours', () => {
  const contacts = src('app/contacts/page.tsx');
  assert.ok(contacts.includes(EXACT_HOURS_TEXT));
  // must stay inside the existing "Контактна інформація" section
  const sectionStart = contacts.indexOf('Контактна інформація');
  assert.ok(sectionStart !== -1);
  assert.ok(
    contacts.indexOf(EXACT_HOURS_TEXT) > sectionStart,
    'working hours must live in the contact-information section'
  );
});
