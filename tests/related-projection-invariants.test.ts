/**
 * Static egress invariant (2026-09-08): the «Схожі товари» path in
 * app/lib/catalog.ts must select ONLY the slim card projection —
 * CATALOG_CARD_SELECT, plus the junction suffix in the category stage. The
 * shelf renders ProductCard, which reads nothing beyond card fields, so a
 * silent regression to PRODUCT_SELECT ('*, …', ~9.8 KB/product live vs
 * ~2.3 KB) would roughly quadruple the largest storefront egress stream
 * (3 bounded stages × ≤8 products on every PDP render). Pattern follows the
 * other static invariant tests (source-level pin, comments stripped).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-09 refactor: the related-products code lives in app/lib/catalog/related.ts.
const src = readFileSync('app/lib/catalog/related.ts', 'utf8');
// Strip comments first: prose mentions of PRODUCT_SELECT elsewhere in the
// file must not mask (or falsely trigger) a regression inside the stage.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const start = code.indexOf('async function fetchRelatedStage');
const end = code.indexOf('export async function fetchRelatedProducts');

test('RELATED egress: fetchRelatedStage selects CATALOG_CARD_SELECT, never PRODUCT_SELECT or a wildcard literal', () => {
  assert.ok(start !== -1 && end > start, 'fetchRelatedStage must exist');
  const stage = code.slice(start, end);

  // CATALOG_CARD_SELECT is the unconditional prefix of the single select —
  // every stage (plain and junction) gets the card projection.
  assert.match(
    stage,
    /select\(\s*CATALOG_CARD_SELECT \+/,
    'card projection is the base of the select'
  );
  assert.match(
    stage,
    /', pc:product_categories!inner\(category_id\)'/,
    'junction suffix kept on the category stage'
  );
  // Hard guards: the heavy constant and any raw '*, ' projection literal are
  // banned inside the related stage body (PRODUCT_SELECT itself stays
  // available to the rest of the file — the ban is scoped to this slice).
  assert.doesNotMatch(stage, /PRODUCT_SELECT/, 'no PRODUCT_SELECT in related stage');
  assert.doesNotMatch(stage, /'\*,\s*'/, "no '*, ' wildcard literal in related stage");
  // Exactly one .select(): re-selecting a typed builder no longer
  // type-checks, and a second .select() here would hint at projection drift.
  assert.equal((stage.match(/\.select\(/g) ?? []).length, 1, 'single .select call');
});
