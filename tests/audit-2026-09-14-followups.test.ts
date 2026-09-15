/**
 * Leftovers from the UI/UX audit 2026-09-14 that survived the 5869d73
 * batch: card photo подложка (white-on-white), negative price-bound
 * feedback, footer category naming sources. Source-pin pattern — see
 * tests/ux-fixes.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- audit #11: white items invisible on the white card

test('CARD-PHOTO: image wrapper carries a non-white подложка', () => {
  const card = src('app/components/ProductCard.tsx');
  // the wrapper is the first rounded-t-xl div inside the product Link
  const bg = card.match(/<Link[\s\S]*?rounded-t-xl ([^"]+)"/)?.[1];
  assert.ok(bg, 'card image wrapper not found');
  assert.doesNotMatch(bg, /bg-white/);
  assert.match(bg, /bg-gray-100/);
});

// ---- audit #9: negative «від»/«до» silently dropped (mobile sheet apply
// is type=button, so the native min="0" constraint never fires there)

test('PRICE-FILTER: negative bound is flagged inline and blocks both apply paths', () => {
  const f = src('app/catalog/CatalogFilters.tsx');
  assert.match(f, /priceNegative/);
  assert.match(f, /minNum < 0/);
  assert.match(f, /maxNum < 0/);
  assert.match(f, /від’ємною/);
  // applyFilters AND applyAndClose must stay gated on the combined flag
  assert.equal(
    (f.match(/if \(priceRangeInvalid\) return;/g) ?? []).length,
    2,
    'both apply paths must skip navigation for an invalid range'
  );
});

// ---- audit #14: footer renders DB category names verbatim; the importer
// mapping is their source, so clean names must live there

test('FOOTER-NAMES: importer mapping carries clean Ukrainian display names', () => {
  const s = src('app/lib/yugcontract/selection.ts');
  assert.doesNotMatch(s, /аксессуари/, 'russianism «аксессуари» must not reappear');
  assert.doesNotMatch(s, /ПОБУТОВА ТЕХНІКА/, 'all-caps display name must not reappear');
  assert.match(s, /Ножі та аксесуари/);
  assert.match(s, /Побутова техніка/);
});
