/**
 * /delivery page copy — static invariants.
 *
 * The page must describe the REAL checkout (Нова Пошта: відділення /
 * поштомат / кур'єр; Укрпошта: відділення; 100% онлайн LiqPay; оплата
 * частинами — за телефонами) and must NOT promise payment/delivery
 * options the store does not have (післяплата, IBAN, «оплата карткою» /
 * «банківський переказ» as separate methods, Делівері, кур'єр по місту,
 * самовивіз).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(path.join(root, 'app/delivery/page.tsx'), 'utf8');

test('DELIVERY-PAGE: describes the real carrier coverage', () => {
  assert.match(page, /«Нова Пошта» — відділення, поштомат або кур’єрська доставка/);
  assert.match(page, /«Укрпошта» — відділення/);
  assert.match(page, /за тарифами перевізника/);
});

test('DELIVERY-PAGE: payment is 100% online LiqPay', () => {
  assert.match(page, /100% онлайн через платіжний сервіс LiqPay/);
});

test('DELIVERY-PAGE: installments are offered via the real phone, as in checkout', () => {
  assert.match(page, /Оплата частинами|оплату частинами/);
  assert.match(page, /ПриватБанк|ПриватБанку/);
  assert.match(page, /ПУМБ/);
  assert.match(page, /А-Банк/);
  assert.match(page, /tel:\+380973144221/);
});

test('DELIVERY-PAGE: no false promises of unsupported payment/delivery options', () => {
  for (const banned of [
    'післяплата',
    'Післяплата',
    'IBAN',
    'банківський переказ',
    'оплата карткою',
    'Делівері',
    'самовивіз',
    'розрахунковий рахунок',
  ]) {
    assert.ok(!page.includes(banned), `must not promise: ${banned}`);
  }
});

test('DELIVERY-PAGE: metadata title stays stable (nav link contract)', () => {
  assert.match(page, /Доставка та оплата — Товари для дому/);
});
