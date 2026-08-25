/**
 * Shared price formatter (2026-08 UX audit P8): storefront prices are
 * integer UAH, so «7399 UAH» everywhere — the cart must not render
 * «7399.00 UAH». Non-integer values keep 2 decimals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatPrice } = await import('../app/lib/format.ts');

test('formatPrice: integer prices render without decimals', () => {
  assert.equal(formatPrice(7399, 'UAH'), '7399 UAH');
  assert.equal(formatPrice(99, 'UAH'), '99 UAH');
  assert.equal(formatPrice(0, 'UAH'), '0 UAH');
});

test('formatPrice: fractional prices keep two decimals', () => {
  assert.equal(formatPrice(99.5, 'UAH'), '99.50 UAH');
  assert.equal(formatPrice(10.25, 'UAH'), '10.25 UAH');
});

test('formatPrice: floating-point noise is rounded, not exposed', () => {
  assert.equal(formatPrice(0.1 + 0.2, 'UAH'), '0.30 UAH');
});
