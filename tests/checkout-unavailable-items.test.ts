/**
 * F1: checkout must not dead-end on unavailable cart items.
 *
 * Bug: CheckoutForm hid unavailable lines (display-only `purchasable`
 * filter) but still POSTed every cart item, so /api/orders answered 422
 * and /checkout offered no way to remove the offending line.
 *
 * node:test cannot execute JSX client components (no transform in the
 * runner — same constraint as tests/checkout-shipping-notice.test.ts),
 * so per the established pattern these tests pin the SOURCE invariants:
 *
 * Behaviour contract:
 *   - unavailable = the cart page rule, reused verbatim:
 *     preview exists AND (!found || unitPrice === null || out_of_stock);
 *   - a missing preview (preview fetch failed / still loading) is UNKNOWN,
 *     never unavailable — the documented "previewError does not block
 *     submit, manager confirms the total" contract stays intact;
 *   - unavailable lines are VISIBLE on /checkout with a remove control
 *     wired to the existing cart-context removeItem();
 *   - submit is guarded client-side: POST /api/orders is never sent while
 *     an unavailable line exists (the server-side 422 stays as defence);
 *   - the server contract (422 mapping, error handling, redirect) is
 *     untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const form = (): string => src('app/checkout/CheckoutForm.tsx');
// 2026-09-13 mechanical split: the summary aside (unavailable-items block,
// remove control, preview-error notices) lives in parts/OrderSummary.tsx.
const summary = (): string => src('app/checkout/parts/OrderSummary.tsx');

// ---- 1. availability definition (reused from the cart page) ----

test('F1: CheckoutForm computes unavailable lines with the cart-page rule', () => {
  const f = form();
  // out_of_stock is part of the project's unavailable definition (cart page)
  assert.match(
    f,
    /availabilityStatus\s*===\s*'out_of_stock'/,
    'CheckoutForm must treat out_of_stock as unavailable (cart-page rule)'
  );
  // !found and missing price are part of the rule too
  assert.match(f, /!\w+\.found|!preview\.found/);
  assert.match(f, /unitPrice\s*===\s*null/);
});

test('F1: a missing preview is UNKNOWN, never unavailable (previewError contract preserved)', () => {
  const f = form();
  // The unavailable computation must require a preview line to exist —
  // otherwise a failed cart-preview fetch would block submit entirely.
  assert.match(
    f,
    /preview\s*(?:!==|===)\s*undefined|preview\s*\?\?/,
    'unavailable rule must distinguish "no preview yet" from "preview says unavailable"'
  );
  // The documented contract stays: preview failure alone does not block submit.
  assert.match(f, /previewError/);
  assert.match(
    summary(),
    /Не вдалося завантажити( частину)? цін/,
    'previewError notice must remain'
  );
});

// ---- 2. unavailable lines are visible with a remove control ----

test('F1: unavailable lines are rendered visibly, not silently hidden', () => {
  const f = form();
  // the rule is computed in CheckoutForm, rendered by OrderSummary
  assert.match(f, /unavailableItems/);
  assert.match(summary(), /unavailableItems/);
  // visible block with an explicit reason for the user
  assert.match(summary(), /більше недоступн/);
});

test('F1: each unavailable line has a remove button wired to cart-context removeItem', () => {
  const s = summary();
  assert.match(
    s,
    /removeItem/,
    'CheckoutForm must use the existing cart removeItem(), not a new mechanism'
  );
  assert.match(s, /Видалити/);
  assert.match(
    s,
    /removeItem\(\s*item\.productId\s*,\s*item\.variantId\s*\)/
  );
});

// ---- 3. submit guard: POST never sent while an unavailable line exists ----

test('F1: submit is guarded BEFORE the POST when unavailable lines exist', () => {
  const f = form();
  // guard must run before the fetch and before setSubmitting(true)
  const guard = f.indexOf('unavailableItems.length > 0');
  const fetchPos = f.indexOf("fetch('/api/orders'");
  const submittingPos = f.indexOf('setSubmitting(true)');
  assert.notEqual(guard, -1, 'submit guard for unavailable items is missing');
  assert.notEqual(fetchPos, -1);
  assert.ok(guard < fetchPos, 'guard must run before POST /api/orders');
  assert.ok(guard < submittingPos, 'guard must run before setSubmitting(true)');
  // an explicit notice explains WHY the order cannot be placed
  assert.match(f, /Видаліть (їх |непридатні товари|недоступні товари)/);
});

// ---- 4. totals keep using the existing purchasable logic ----

test('F1: totals still come from the purchasable-only subtotal (no second pricing mechanism)', () => {
  const f = form();
  // Since 2026-09-04 the subtotal is grouped per currency (mixed-currency
  // carts used to sum UAH+USD into one meaningless number) — the source of
  // truth is unchanged: ONLY purchasable lines feed the totals.
  assert.match(f, /subtotalByCurrency/);
  assert.match(f, /for \(const \{ item, preview \} of purchasable\)/);
  assert.doesNotMatch(f, /unavailableItems\.reduce/,
    'unavailable lines must never feed any total');
  // purchasable excludes unavailable lines (out_of_stock must not count)
  const purch = f.indexOf('const purchasable');
  const unavailable = f.indexOf('const unavailableItems');
  assert.notEqual(purch, -1);
  assert.notEqual(unavailable, -1);
  assert.ok(purch < unavailable || purch > unavailable); // both exist
  assert.match(f, /availabilityStatus !== 'out_of_stock'/);
});

// ---- 5. server contract untouched ----

test('F1: server-side 422 handling is intact (defence in depth stays)', () => {
  const route = src('app/api/orders/route.ts');
  assert.match(route, /P0422/);
  assert.match(
    route,
    /Товар недоступний або його недостатньо на складі/,
    'server must keep rejecting unavailable stock with 422'
  );
  assert.match(route, /place_order/, 'RPC contract unchanged');
});

test('F1: checkout redirect contract is unchanged', () => {
  const f = form();
  assert.match(f, /clearCart\(\)/);
  assert.match(
    f,
    /router\.replace\(\s*`\/checkout\/success\?order=/
  );
});

test('F1: cart page unavailable rule matches the checkout rule (single definition)', () => {
  const cart = src('app/cart/page.tsx');
  assert.match(cart, /availabilityStatus === 'out_of_stock'/);
  assert.match(cart, /Товар недоступний — видаліть його з кошика/);
});
