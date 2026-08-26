/**
 * Exactly one primary <h1> per indexable page (spec H of the SEO package).
 * Source-level pin: these pages render their heading through a single
 * literal or a single heading variable; regressions that sneak a second h1
 * fail CI. Live SSR counts verified 2026-08-26: home=1, product=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGES: [string, string][] = [
  ['home hero', 'app/(home)/page.tsx'],
  ['catalog', 'app/catalog/page.tsx'],
  ['product', 'app/product/[slug]/page.tsx'],
  ['not-found', 'app/not-found.tsx'],
];

for (const [label, file] of PAGES) {
  test(`H1: ${label} declares exactly one <h1> literal`, () => {
    const src = readFileSync(file, 'utf8');
    const count = (src.match(/<h1/g) ?? []).length;
    assert.equal(count, 1, `${file} has ${count} <h1> literals`);
  });
}

test('H1: catalog heading covers category/brand/search views via one variable', () => {
  const src = readFileSync('app/catalog/page.tsx', 'utf8');
  assert.match(src, /function catalogHeading\(/);
  assert.match(src, /\{heading\}/, 'single heading variable must be rendered');
});

test('H1: info pages share the single-h1 InfoPage component', () => {
  const comp = readFileSync('app/components/InfoPage.tsx', 'utf8');
  assert.equal((comp.match(/<h1/g) ?? []).length, 1);
});
