/**
 * Regression tests for the checkout phone paste/autofill fix (B2, audit
 * 2026-08-28): the input must NOT carry maxLength — a browser truncates a
 * pasted "+380971234567" to 9 chars BEFORE onChange, so the old
 * maxLength={9} fed the normalizer a partial "+38097123" and silently lost
 * digits. The normalizer itself already caps at 9 national digits.
 *
 * The normalizers live in app/lib/phone.ts (pure, no JSX) so node:test can
 * import them; static pins keep CheckoutForm wired to the shared module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeUaPhoneDigits, toE164Ua } from '../app/lib/phone.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

test('PHONE-PASTE: pasted full international numbers keep all 9 digits', () => {
  assert.equal(normalizeUaPhoneDigits('+380971234567'), '971234567');
  assert.equal(normalizeUaPhoneDigits('380971234567'), '971234567');
});

test('PHONE-PASTE: pasted trunk-prefixed and bare national numbers', () => {
  assert.equal(normalizeUaPhoneDigits('0971234567'), '971234567');
  assert.equal(normalizeUaPhoneDigits('971234567'), '971234567');
});

test('PHONE-PASTE: pasted values with separators and stray characters', () => {
  // Mobile contacts apps commonly paste formatted numbers.
  assert.equal(normalizeUaPhoneDigits('+380 (97) 123-45-67'), '971234567');
  assert.equal(normalizeUaPhoneDigits('097 123 45 67'), '971234567');
  assert.equal(normalizeUaPhoneDigits('tel:+380971234567'), '971234567');
});

test('PHONE-PASTE: garbage and empty input degrade to empty, never partial', () => {
  assert.equal(normalizeUaPhoneDigits(''), '');
  assert.equal(normalizeUaPhoneDigits('abc'), '');
  // Foreign numbers are out of scope: digits are kept, capped at 9 — the
  // same graceful-degradation the field always had for such input.
  assert.equal(normalizeUaPhoneDigits('+1 555 000 1111'), '155500011');
});

test('PHONE-PASTE: longer digit runs are capped at 9 national digits', () => {
  assert.equal(normalizeUaPhoneDigits('380971234567999'), '971234567');
  assert.equal(normalizeUaPhoneDigits('0971234567890'), '971234567');
});

test('PHONE-PASTE: E.164 is emitted only for a complete 9-digit value', () => {
  assert.equal(toE164Ua('971234567'), '+380971234567');
  assert.equal(toE164Ua('97123456'), '');
  assert.equal(toE164Ua(''), '');
});

test('PHONE-PASTE: CheckoutForm has no maxLength on the phone input', () => {
  const f = src('app/checkout/CheckoutForm.tsx');
  // The ONLY historical maxLength={9} was the phone field; its removal is
  // the paste fix. The normalizer caps the value, so no length cap is needed.
  assert.ok(!f.includes('maxLength={9}'), 'phone input must not truncate paste');
  // Still wired to the shared normalizers (not re-implemented inline).
  assert.match(f, /normalizeUaPhoneDigits/);
  assert.match(f, /toE164Ua/);
  assert.match(f, /from '@\/app\/lib\/phone'/);
});

test('PHONE-PASTE: server-side UA E.164 validation is intact', () => {
  const r = src('app/api/orders/route.ts');
  assert.ok(
    r.includes(String.raw`phone !== '' && !/^\+380\d{9}$/.test(phone)`),
    'non-empty phone must still be validated as UA E.164'
  );
});
