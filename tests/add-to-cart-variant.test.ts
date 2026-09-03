/**
 * P0 regression (2026-09-03): variant products rendered disabled
 * «Немає в наявності» BEFORE a variant was chosen — the selector was
 * unreachable because an unselected variant read as stock 0.
 *
 * Contract pinned here:
 *  - unselected variant = "unknown" (null sentinel), never out-of-stock;
 *  - the «Варіант *» selector + disabled «Додати в кошик» stay reachable;
 *  - genuine out-of-stock paths (simple product, selected variant,
 *    parent kill-switch) are untouched.
 *
 * Static source invariants (components are not unit-mountable here —
 * same pattern as discount-ui.test.ts / security-remediation.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const btn = readFileSync(
  path.join(root, 'app/components/AddToCartButton.tsx'),
  'utf8'
);

test('VARIANT-P0: unselected variant is null-sentinel, not stock 0', () => {
  // The regression was `selectedVariant?.stockQuantity ?? 0` — every
  // variant product without a choice computed effectiveStock 0.
  assert.match(btn, /selectedVariant\?\.stockQuantity \?\? null/);
  assert.ok(
    !/selectedVariant\?\.stockQuantity \?\? 0/.test(btn),
    'unselected variant must not default to stock 0'
  );
});

test('VARIANT-P0: zero-stock check is null-guarded', () => {
  // Bare `effectiveStock <= 0` reintroduces the deadlock for null.
  assert.match(btn, /effectiveStock !== null && effectiveStock <= 0/);
});

test('VARIANT-P0: selector + disabled add stay reachable without a choice', () => {
  assert.match(btn, /Варіант \*/);
  assert.match(btn, /— Оберіть варіант —/);
  assert.match(btn, /disabled=\{hasVariants && !selectedVariant\}/);
  // Reachability: the out-of-stock early return must not swallow the
  // selector — with the null guard above, unselected + parent in_stock
  // falls through to the selector UI.
  assert.ok(
    btn.indexOf('if (outOfStock)') < btn.indexOf('{hasVariants && ('),
    'selector must render when not outOfStock'
  );
});

test('VARIANT-P0: genuine out-of-stock paths are preserved', () => {
  // Parent kill-switch still first.
  assert.match(btn, /availabilityStatus === 'out_of_stock'/);
  // Selected-variant stock/status checks still present.
  assert.match(
    btn,
    /hasVariants && selectedVariant\?\.availabilityStatus === 'out_of_stock'/
  );
  // The honest disabled state still exists for real stockouts.
  assert.match(btn, /Немає в наявності/);
});
