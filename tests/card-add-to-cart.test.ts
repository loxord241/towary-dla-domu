/**
 * Card-level «У кошик» (conversion fix, UI audit 2026-09-14): grid cards
 * gain a one-click add island so /catalog and /oboi no longer lose every
 * add that did not justify a PDP visit.
 *
 * Pins:
 *  - CardAddToCartButton is a client island on the shared cart-context
 *    API (addItem with quantity 1 and variantId null — the card
 *    projection carries no variant data; place_order prices product
 *    rows);
 *  - «Додано ✓» confirmation for 2s after the click; a full cart gets an
 *    honest label instead of a faked success flash; ADD_TO_CART
 *    analytics parity with the PDP button;
 *  - 44px touch target (min-h-[44px]);
 *  - ProductCard renders the island OUTSIDE the product Link (no nested
 *    interactive elements) and only for purchasable cards — out_of_stock
 *    hides it (availability ships in the card projection);
 *  - LCP contract untouched: the eager/lazy image pins of
 *    lcp-main-invariants.test.ts keep applying to the edited file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const ISLAND = 'app/components/CardAddToCartButton.tsx';
const CARD = 'app/components/ProductCard.tsx';

test('CARD-CART: island adds through the shared cart context, qty 1, no variant', () => {
  const s = src(ISLAND);
  assert.match(s, /'use client';/);
  assert.match(s, /useCart\(\)/);
  assert.match(s, /addItem\(productId, null, 1\)/);
});

test('CARD-CART: «Додано ✓» for 2s; a full cart is reported, not faked', () => {
  const s = src(ISLAND);
  assert.match(s, /Додано ✓/);
  assert.match(s, /ADDED_FEEDBACK_MS = 2000/);
  assert.match(s, /Кошик переповнений/);
  // Analytics parity with the PDP add-to-cart button.
  assert.match(s, /trackEvent\(ANALYTICS_EVENTS\.ADD_TO_CART/);
});

test('CARD-CART: 44px touch target', () => {
  assert.match(src(ISLAND), /min-h-\[44px\]/);
});

test('CARD-CART: ProductCard renders the island outside the Link, hidden for out_of_stock', () => {
  const card = src(CARD);
  assert.match(card, /import CardAddToCartButton from '\.\/CardAddToCartButton';/);
  assert.match(card, /\{!outOfStock && \(/);
  const linkEnd = card.indexOf('</Link>');
  const island = card.indexOf('<CardAddToCartButton');
  assert.ok(linkEnd !== -1 && island > linkEnd, 'the button must not nest inside the product Link');
  // LCP pins survive the edit (mirrors lcp-main-invariants.test.ts).
  assert.match(card, /eager = false/);
  assert.match(card, /loading=\{eager \? "eager" : "lazy"\}/);
  assert.match(card, /fetchPriority=\{eager \? "high" : "auto"\}/);
});
