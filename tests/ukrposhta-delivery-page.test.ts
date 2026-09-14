/**
 * /delivery page copy — static invariants.
 *
 * The page must describe the REAL checkout (Нова Пошта: відділення /
 * поштомат / кур'єр; Укрпошта: відділення; 2026-09-12: самовивіз у
 * Кривому Розі — дві точки, онлайн LiqPay АБО готівка на точці; оплата
 * частинами — за телефонами) and must NOT promise payment/delivery
 * options the store does not have (післяплата, IBAN, «оплата карткою» /
 * «банківський переказ» as separate methods, Делівері, кур'єр по місту).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(path.join(root, 'app/delivery/page.tsx'), 'utf8');
// Canonical pickup points live in the shared checkout contract — the page
// must quote the SAME addresses (single source of truth).
const { PICKUP_POINTS } = await import(
  pathToFileURL(path.join(root, 'app/lib/checkout-delivery.ts')).href
);

test('DELIVERY-PAGE: describes the real carrier coverage', () => {
  assert.match(page, /«Нова Пошта» — відділення, поштомат або кур’єрська доставка/);
  assert.match(page, /«Укрпошта» — відділення/);
  assert.match(page, /за тарифами перевізника/);
});

test('DELIVERY-PAGE: pickup section quotes the canonical pickup points', () => {
  assert.match(page, /Самовивіз у Кривому Розі — безкоштовно/);
  for (const point of PICKUP_POINTS) {
    assert.ok(
      page.includes(point.address),
      `pickup point ${point.id} address must be on the page`
    );
  }
  // Domain split matches the checkout (техніка vs шпалери).
  assert.match(page, /Мазепи, 87А — побутова техніка/);
  assert.match(page, /Мазепи, 83А — шпалери/);
});

test('DELIVERY-PAGE: payment is online LiqPay, cash allowed at pickup only', () => {
  assert.match(page, /Онлайн — через платіжний сервіс LiqPay/);
  assert.match(page, /готівкою безпосередньо\s+на пункті видачі/);
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
    'розрахунковий рахунок',
  ]) {
    assert.ok(!page.includes(banned), `must not promise: ${banned}`);
  }
});

test('DELIVERY-PAGE: metadata title stays stable (nav link contract)', () => {
  assert.match(page, /Доставка та оплата — Товари для дому/);
});
