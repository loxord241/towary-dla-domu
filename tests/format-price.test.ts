/**
 * Shared price formatter — single presentation point for ALL storefront
 * prices (P3-R1 2026-08-26): uk-UA locale via Intl.NumberFormat gives
 * thousands grouping with a non-breaking space («17 599 грн») and comma
 * decimals for genuine fractions («99,50 грн»). Integers stay integer,
 * floating-point noise is rounded away. Display only: DB values, cart
 * totals and discount math are untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatPrice, pluralProducts } = await import('../app/lib/format.ts');

test('formatPrice: integer prices get uk-UA thousands grouping', () => {
  assert.equal(formatPrice(7399, 'UAH'), `7\u00A0399 грн`);
  assert.equal(formatPrice(17599, 'UAH'), `17\u00A0599 грн`);
  assert.equal(formatPrice(999, 'UAH'), '999 грн');
  assert.equal(formatPrice(0, 'UAH'), '0 грн');
});

test('formatPrice: fractional prices keep two decimals with uk-UA comma', () => {
  assert.equal(formatPrice(99.5, 'UAH'), '99,50 грн');
  assert.equal(formatPrice(10.25, 'UAH'), '10,25 грн');
});

test('formatPrice: grouped fractions keep both behaviors', () => {
  assert.equal(formatPrice(1234567.891, 'UAH'), `1\u00A0234\u00A0567,89 грн`);
});

test('formatPrice: floating-point noise is rounded, not exposed', () => {
  assert.equal(formatPrice(0.1 + 0.2, 'UAH'), '0,30 грн');
});

test('formatPrice: null/undefined currency renders the bare number', () => {
  assert.equal(formatPrice(17599, null), `17\u00A0599`);
  assert.equal(formatPrice(17599, ''), `17\u00A0599`);
});

test('pluralProducts: українська плюралізація (1 товар, 2-4 товари, 5 товарів)', () => {
  assert.equal(pluralProducts(1), '1 товар');
  assert.equal(pluralProducts(2), '2 товари');
  assert.equal(pluralProducts(3), '3 товари');
  assert.equal(pluralProducts(4), '4 товари');
  assert.equal(pluralProducts(5), '5 товарів');
  assert.equal(pluralProducts(11), '11 товарів');
  assert.equal(pluralProducts(12), '12 товарів');
  assert.equal(pluralProducts(14), '14 товарів');
  assert.equal(pluralProducts(21), '21 товар');
  assert.equal(pluralProducts(22), '22 товари');
  assert.equal(pluralProducts(25), '25 товарів');
  assert.equal(pluralProducts(101), '101 товар');
  assert.equal(pluralProducts(114), '114 товарів');
});

