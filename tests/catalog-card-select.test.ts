/**
 * Task #4 (2026-08-31): /catalog data query uses a slim card projection.
 *
 * fetchCatalogProducts previously reused PRODUCT_SELECT (the PDP-grade
 * projection) for grid cards, shipping description/specifications/variants/
 * full brand rows that ProductCard never reads (~9.8 KB/product vs ~2.3 KB).
 * These static invariants pin the architectural boundary:
 *   - CATALOG_CARD_SELECT exists and carries ONLY card-render fields;
 *   - the eligibility join product_images!inner is preserved;
 *   - the paged data query uses the card projection, PRODUCT_SELECT does not;
 *   - PRODUCT_SELECT itself and the count projections stay byte-identical
 *     (PDP / home / related and the count logic depend on them).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-09 refactor: the god-module was split into app/lib/catalog/* — the
// pins read every fragment (original file order) so the invariants stay whole.
const CATALOG_LIB_FILES = [
  'app/lib/catalog/shared.ts',
  'app/lib/catalog/filters.ts',
  'app/lib/catalog/slug-lookup.ts',
  'app/lib/catalog/product-feed.ts',
  'app/lib/catalog/counts.ts',
  'app/lib/catalog/listing.ts',
  'app/lib/catalog/wallpaper-listing.ts',
  'app/lib/catalog/reviews.ts',
  'app/lib/catalog/shelves.ts',
  'app/lib/catalog/categories.ts',
  'app/lib/catalog/search.ts',
  'app/lib/catalog/product-card.ts',
  'app/lib/catalog/related.ts',
];
const src = () =>
  CATALOG_LIB_FILES.map((rel) => readFileSync(rel, 'utf8')).join('\n');

function cardSelectLiteral(s: string): string {
  const m = s.match(/const CATALOG_CARD_SELECT =\s*'([^']+)';/);
  assert.ok(m, 'CATALOG_CARD_SELECT constant must exist in app/lib/catalog.ts');
  const literal = m[1];
  assert.ok(literal !== undefined, 'capture group must hold the select literal');
  return literal;
}

test('CARD-SELECT: /catalog card projection contains only card-render fields', () => {
  const sel = cardSelectLiteral(src());
  for (const field of [
    'id',
    'name',
    'slug',
    'price',
    'old_price',
    'currency',
    'availability_status',
    'brand:brands(name)',
    // Linoleum batch 3 (owner plan 2026-09-17): ln-* cards render the
    // «Ціна за м²» specification as THE card price — products.price on an
    // ln-* row is грн за погонный метр, not comparable across widths.
    'specifications',
  ]) {
    assert.ok(sel.includes(field), `card select must contain ${field}: ${sel}`);
  }
  // Eligibility: imageless products must stay hidden (same join semantics
  // as PRODUCT_SELECT — see the storefront-visibility invariants).
  assert.match(sel, /images:product_images!inner\(/);
  assert.match(sel, /image_url/);
  assert.match(sel, /is_main/);
  // normalizeProduct's image ordering relies on sort_order.
  assert.match(sel, /sort_order/);
  // getMainPublicImageUrl's parameter type requires product_id.
  assert.match(sel, /product_id/);
});

test('CARD-SELECT: card projection drops the heavy body payload (description/variants/category)', () => {
  // UPDATE (linoleum batch 3, 2026-09-17): `specifications` left the
  // forbidden list BY OWNER PLAN — ln-* cards need the «Ціна за м²» entry
  // (import-plan.ts canon) to show грн/м²; live measure 2026-09-17 showed
  // the specifications jsonb is cheap (avg ~0.5 KB/row, most appliance rows
  // NULL) unlike the description HTML that motivated the original pin.
  // Everything else that made cards heavy stays forbidden.
  const sel = cardSelectLiteral(src());
  assert.doesNotMatch(
    sel,
    /description|variants|sku|stock_quantity|category:categories|created_at|updated_at/
  );
});

test('CARD-SELECT: fetchCatalogProducts uses the card projection, not PRODUCT_SELECT', () => {
  const s = src();
  const start = s.indexOf('// ---- paged data query ----');
  const end = s.indexOf('// Every sort gets', start);
  assert.ok(start !== -1 && end !== -1, 'catalog data query markers must exist');
  const part = s.slice(start, end);
  assert.match(part, /CATALOG_CARD_SELECT/);
  assert.doesNotMatch(
    part,
    /PRODUCT_SELECT/,
    'catalog data query must not use the heavy PDP projection'
  );
});

test('CARD-SELECT: PRODUCT_SELECT and count projections stay untouched', () => {
  const s = src();
  assert.match(
    s,
    /const PRODUCT_SELECT =\s*'\*, category:categories!products_category_id_fkey\(id, name, slug\), brand:brands\(\*\), images:product_images!inner\(\*\), variants:product_variants\(\*\)';/
  );
  assert.match(s, /categoryId \? JUNCTION_COUNT_SELECT : ELIGIBLE_COUNT_SELECT/);
});
