/**
 * Migration 040 (availability from stock) — static invariants.
 *
 * Spec: docs/superpowers/specs/2026-09-10-wallpapers-import-design.md §5
 * (GO владельца 2026-09-10). The migration adds a trigger function
 * set_availability_from_stock() plus two BEFORE UPDATE OF stock_quantity
 * triggers so that availability_status honestly follows the stock at every
 * write path (1C wallpaper sync, website sales via place_order, manual admin
 * edits). INSERT stays untouched: importers write both fields consistently.
 *
 * These tests pin the migration file content so the rule cannot silently
 * regress (pattern: tests/orders-revoke-migration.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/040_availability_from_stock.sql';

/** Migration content without prose comments (statements only). */
const statementsOnly = (m: string): string => m.replace(/^\s*--.*$/gm, '');

test('AVAILABILITY-040: migration file exists', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('040_availability_from_stock.sql'),
    `expected ${MIGRATION}; found: ${files.join(', ')}`
  );
});

test('AVAILABILITY-040: function is CREATE OR REPLACE (re-apply safe)', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /create\s+or\s+replace\s+function\s+set_availability_from_stock\s*\(\s*\)/i,
    'expected CREATE OR REPLACE FUNCTION set_availability_from_stock()'
  );
});

test('AVAILABILITY-040: both BEFORE UPDATE OF stock_quantity triggers exist', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /create\s+trigger\s+trg_products_availability_from_stock\s+before\s+update\s+of\s+stock_quantity\s+on\s+products\b/i,
    'missing trigger on products'
  );
  assert.match(
    m,
    /create\s+trigger\s+trg_product_variants_availability_from_stock\s+before\s+update\s+of\s+stock_quantity\s+on\s+product_variants\b/i,
    'missing trigger on product_variants'
  );
  assert.equal(
    (statementsOnly(m).match(/execute\s+function\s+set_availability_from_stock/gi) ?? []).length,
    2,
    'both triggers must execute set_availability_from_stock (exactly 2 references)'
  );
});

test('AVAILABILITY-040: stock 0 -> out_of_stock, stock > 0 -> in_stock', () => {
  const m = statementsOnly(src(MIGRATION));
  assert.match(
    m,
    /case\s+when\s+new\.stock_quantity\s*>\s*0\s+then\s+'in_stock'\s+else\s+'out_of_stock'/i,
    "expected CASE WHEN NEW.stock_quantity > 0 THEN 'in_stock' ELSE 'out_of_stock'"
  );
});

test('AVAILABILITY-040: INSERT path untouched — no INSERT-level trigger', () => {
  const m = statementsOnly(src(MIGRATION));
  assert.doesNotMatch(m, /before\s+insert/i);
  assert.doesNotMatch(m, /or\s+insert/i, 'must not extend the existing INSERT validation trigger');
});

test('AVAILABILITY-040: DDL only — no INSERT/UPDATE/DELETE data statements', () => {
  const m = statementsOnly(src(MIGRATION));
  assert.doesNotMatch(m, /insert\s+into/i);
  assert.doesNotMatch(m, /delete\s+from/i);
  assert.doesNotMatch(m, /update\s+\w+\s+set/i);
});

test('AVAILABILITY-040: header carries VERIFY-PRE/VERIFY-POST for the orchestrator', () => {
  const m = src(MIGRATION);
  assert.match(m, /VERIFY-PRE/, 'missing VERIFY-PRE select in the header');
  assert.match(m, /VERIFY-POST/, 'missing VERIFY-POST selects in the header');
});
