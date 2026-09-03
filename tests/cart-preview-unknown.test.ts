/**
 * P1 regression (2026-09-04): cart dead-ended when /api/cart-preview
 * failed — preview === undefined was treated as unavailable, so every row
 * read «Товар більше не доступний у каталозі» and the checkout CTA turned
 * into disabled «Немає доступних товарів».
 *
 * Contract (mirrors CheckoutForm.tsx, already pinned by
 * tests/checkout-unavailable-items.test.ts):
 *  - RECEIVED preview proving !found / no price / out_of_stock → unavailable;
 *  - MISSING preview (fetch failed) → UNKNOWN, never unavailable;
 *  - unknown rows keep an active «Оформити замовлення» CTA;
 *    place_order() revalidates server-side.
 *
 * Static source invariants (client components are not unit-mountable here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cart = readFileSync(path.join(root, 'app/cart/page.tsx'), 'utf8');
const form = readFileSync(
  path.join(root, 'app/checkout/CheckoutForm.tsx'),
  'utf8'
);

test('CART-P1: unavailable requires a received preview (unknown !== unavailable)', () => {
  // The regression shape was a bare `!preview?.found || ...` — undefined
  // previews matched and every row went red on transport failure.
  assert.ok(
    !/const unavailable =\s*\n?\s*!preview\?\.found/.test(cart),
    'row must not treat a missing preview as unavailable'
  );
  assert.match(cart, /preview !== undefined &&/);
  assert.match(cart, /!preview\.found/);
  assert.match(cart, /preview\.unitPrice === null/);
  assert.match(cart, /preview\.availabilityStatus === 'out_of_stock'/);
});

test('CART-P1: unknown rows render a neutral state, not «no longer available»', () => {
  // The «no longer available» copy must survive only for confirmed-missing
  // previews; unknown previews get their own honest branch.
  assert.match(cart, /Товар більше не доступний у каталозі/);
  assert.match(cart, /preview === undefined/);
  assert.match(cart, /Дані товару не завантажились/);
});

test('CART-P1: checkout CTA stays active while any row is unknown', () => {
  assert.match(cart, /const unknownRows = rows\.filter\(\(\{ preview \}\) => preview === undefined\)/);
  assert.match(
    cart,
    /purchasableRows\.length > 0 \|\| unknownRows\.length > 0/
  );
  // The honest empty end-state (every row PROVEN unavailable) is preserved.
  assert.match(cart, /Немає доступних товарів/);
});

test('CART-P1: purchasable rule unchanged (received + priced + not out_of_stock)', () => {
  assert.match(
    cart,
    /preview\?\.found === true &&\s*\n?\s*preview\.unitPrice !== null &&\s*\n?\s*preview\.availabilityStatus !== 'out_of_stock'/
  );
});

test('CART-P1: parity with CheckoutForm unknown-contract', () => {
  // Both surfaces must share the same guard shape: missing preview is
  // unknown on /cart exactly as on /checkout.
  for (const [name, src] of [
    ['cart', cart],
    ['checkout', form],
  ] as const) {
    assert.match(
      src,
      /preview !== undefined &&\s*\(?\s*!preview\.found/,
      `${name} must guard !found behind a received preview`
    );
  }
});
