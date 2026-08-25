/**
 * Static invariants for the discount presentation on ProductCard
 * (2026-08 client UX request).
 *
 * Pins the visual contract: discount badge pinned to the card top with a
 * high-contrast background, discounted price as the dominant red element,
 * strikethrough old price, untouched discount math, and a clean non-discount
 * path. No price data or cart logic may change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const card = readFileSync(
  path.join(root, 'app/components/ProductCard.tsx'),
  'utf8'
);

test('DISCOUNT: badge is pinned to the card top, high-contrast, no layout shift', () => {
  // absolute positioning inside the relative image container -> zero shift
  assert.match(card, /relative overflow-hidden rounded-t-xl/);
  assert.match(card, /absolute[^"]*\bleft-2\b[^"]*\btop-2\b|absolute[^"]*\btop-2\b[^"]*\bleft-2\b/);
  // solid contrast background, not a pale tint
  assert.match(card, /bg-red-600[^"]*text-white|text-white[^"]*bg-red-600/);
  // badge must sit in the relative image container at the top of the card,
  // above the product title
  assert.match(card, /relative overflow-hidden rounded-t-xl/);
  assert.ok(
    card.indexOf('absolute top-2 left-2') < card.indexOf('<h3'),
    'discount badge should render above the product title'
  );
});

test('DISCOUNT: discounted new price is the dominant red element', () => {
  assert.match(card, /text-red-600/);
  assert.match(card, /font-extrabold|font-bold/);
});

test('DISCOUNT: old price stays strikethrough and muted', () => {
  assert.match(card, /line-through/);
  assert.match(card, /text-gray-4\d0/);
});

test('DISCOUNT: discount math is unchanged (1 - price/old_price)', () => {
  assert.match(
    card,
    /Math\.round\(\(1 - product\.price \/ product\.old_price!\) \* 100\)/
  );
});

test('DISCOUNT: non-discount price path keeps its original presentation', () => {
  // the base price span keeps the blue treatment when there is no discount
  assert.match(card, /text-blue-700/);
  // hasDiscount gate still drives all discount UI
  assert.match(card, /hasDiscount\s*&&/);
});

test('DISCOUNT: no price/cart logic changes in the card', () => {
  assert.ok(!card.includes('localStorage'), 'card must stay a pure server component');
  assert.ok(!card.includes('fetch('), 'card must not fetch anything');
});
