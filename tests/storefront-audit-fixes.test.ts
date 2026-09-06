/**
 * Source invariants for the 2026-09-06 storefront audit fix batch (small
 * P2/P3 items). Same constraint as catalog-ux-cosmetics.test.ts: client
 * components and JSX pages are not unit-mountable in node:test, so the
 * behavior is pinned at the SOURCE level.
 *
 *  1. fetchSelectedProducts: in-stock first WITHIN the admin-curated
 *     «Обрані» set — mirrors the catalog default sort (ascending
 *     availability_status = in-stock-first contract, see
 *     fetchCatalogProducts). The is_selected SET is not touched; only the
 *     display order changes.
 *  2. SortSelect: the default option's label states what the default sort
 *     actually does (in-stock first, then newest). The value ('newest')
 *     is the URL contract and must NOT change.
 *  3. PDP og:type must stay 'website': Next's OpenGraphType union has no
 *     'product' and its og:type emitter throws E237 "Invalid OpenGraph
 *     type" for any value outside the handled set (verified in
 *     node_modules/next/dist/lib/metadata/metadata.js). A blind
 *     `type: 'product'` would 500 every product page.
 *  4. Root layout exports a static `viewport` with themeColor = #2563eb
 *     (blue-600 — the header/brand accent), per the Next 16
 *     generate-viewport convention.
 *  5. app/favicon.ico exists: /favicon.ico used to 404 (the icon worked
 *     only via the app/icon.jpg convention), which is console noise on
 *     every non-HTML route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string =>
  readFileSync(path.join(root, rel), 'utf8');

// ---- 1: selected shelf opens on in-stock products ----

test('SELECTED: in-stock products are ordered first within the selected set', () => {
  const lib = src('app/lib/catalog.ts');
  const fnStart = lib.indexOf('export async function fetchSelectedProducts');
  const fnBody = lib.slice(fnStart, fnStart + 2400);

  // availability_status asc FIRST in the order chain (the in-stock-first
  // contract: DB holds only 'in_stock'/'out_of_stock' and ascending puts
  // in_stock first), then the deterministic recency pair as tiebreakers.
  const avIdx = fnBody.indexOf(".order('availability_status', { ascending: true })");
  const createdIdx = fnBody.indexOf(".order('created_at', { ascending: false })");
  const idIdx = fnBody.indexOf(".order('id', { ascending: false })");
  assert.ok(avIdx > -1, 'must sort by availability_status ascending');
  assert.ok(createdIdx > -1 && idIdx > -1, 'recency tiebreakers must stay');
  assert.ok(
    avIdx < createdIdx && createdIdx < idIdx,
    'order: availability_status → created_at → id'
  );

  // Set semantics untouched: still exactly the admin-curated active set.
  assert.match(fnBody, /\.eq\('is_active', true\)/);
  assert.match(fnBody, /\.eq\('is_selected', true\)/);
  // Still a single bounded window of SELECTED_LIMIT rows.
  assert.match(fnBody, /\.range\(0, SELECTED_LIMIT - 1\)/);
  // And no availability FILTER sneaked in — OOS selected products must
  // still be shown, just later.
  assert.doesNotMatch(
    fnBody,
    /\.eq\('availability_status'/,
    'must order by availability, not filter it'
  );
});

// ---- 2: sort option label matches the actual default behavior ----

test('SORT-LABEL: default option reads «Спочатку в наявності», value stays newest', () => {
  const sel = src('app/catalog/SortSelect.tsx');
  assert.match(sel, /value: 'newest', label: 'Спочатку в наявності'/);
  // The URL contract must not drift with the label.
  assert.doesNotMatch(sel, /value: '(?!newest|price_asc|price_desc|name_asc)/);
});

// ---- 3: PDP og:type must not use the runtime-fatal 'product' value ----

test('OG-TYPE: PDP stays on a Next-supported og:type (product throws E237)', () => {
  const pdp = src('app/product/[slug]/page.tsx');
  assert.ok(
    !pdp.includes("type: 'product'"),
    "Next's og:type emitter throws E237 for 'product' — see metadata.js"
  );
  assert.match(pdp, /type: 'website'/);
});

// ---- 4: root layout exposes a themeColor viewport ----

test('VIEWPORT: root layout exports themeColor #2563eb via a static viewport', () => {
  const layout = src('app/layout.tsx');
  assert.match(layout, /import type \{ Metadata, Viewport \} from "next";/);
  assert.match(
    layout,
    /export const viewport: Viewport = \{\s*themeColor: '#2563eb',\s*\};/
  );
  // themeColor belongs in viewport, NOT in metadata (Next 14+ convention).
  assert.ok(
    !/metadata[^;]*themeColor/.test(layout),
    'themeColor must live in the viewport export, not metadata'
  );
});

// ---- 5: /favicon.ico resolves — no console noise on non-HTML routes ----

test('FAVICON: app/favicon.ico exists (a real multi-size ICO file)', () => {
  const p = path.join(root, 'app', 'favicon.ico');
  assert.ok(existsSync(p), 'app/favicon.ico missing — /favicon.ico 404s');
  const buf = readFileSync(p);
  // ICO magic bytes ("00 00 01 00"): guards against a placeholder text file.
  assert.equal(buf[0], 0x00);
  assert.equal(buf[1], 0x00);
  assert.equal(buf[2], 0x01);
  assert.equal(buf[3], 0x00);
  assert.ok(buf.length > 1000, 'ICO should carry real image data');
});

// Variant-stock honesty: the PDP «на складі: N шт» counter must render only
// for variant-less products — orders decrement the VARIANT row for products
// with variants, so the product-level quantity would be a lie there.
test('PDP stock counter renders only when the product has no variants', () => {
  const src = readFileSync(
    new URL('../app/product/[slug]/page.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    src,
    /variants\.length === 0 && product\.stock_quantity > 0/,
    'stock counter must be gated on the absence of variants'
  );
});
