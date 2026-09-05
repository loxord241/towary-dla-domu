/**
 * Data-error honesty for the catalog data layer (2026-08 finding fix).
 *
 * Previously every Supabase failure in catalog.ts was swallowed into an
 * empty result: a DB outage rendered the storefront as "no products exist"
 * and fetchProductBySlug turned a data error into a 404. These invariants
 * pin the corrected contract:
 *   - every catch block in catalog.ts rethrows → app/error.tsx renders;
 *   - an empty result can only ever mean "genuinely no rows".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = readFileSync(
  path.join(root, 'app/lib/catalog.ts'),
  'utf8'
);

test('CATALOG: every `if (error)` guard rethrows — errors never become empty results', () => {
  // one level of brace nesting allowed — template literals like ${error.message}
  const guards = catalog.match(/if \(error\) \{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
  assert.ok(
    guards.length >= 4,
    `expected the fetcher error guards to exist, found ${guards.length}`
  );
  for (const guard of guards) {
    assert.match(
      guard,
      /throw/,
      `error guard must rethrow, got: ${guard.slice(0, 80).replace(/\s+/g, ' ')}`
    );
  }
});

test('CATALOG: no silent swallow pattern (log-then-return-empty/null)', () => {
  assert.ok(
    !/if \(error\) \{(?:[^{}]|\{[^{}]*\})*return (null|\[\])/.test(catalog),
    'log-then-return-empty hides incidents from the storefront'
  );
});

test('CATALOG: countError guard rethrows — a count failure must not render an empty catalog (2026-09 UX audit #4)', () => {
  // The count guard names its variable `countError`, so the generic
  // `if (error)` scan above does not see it; pin it explicitly.
  const guard = catalog.match(/if \(countError\) \{(?:[^{}]|\{[^{}]*\})*\}/);
  assert.ok(guard, 'expected the countError guard to exist in catalog.ts');
  assert.match(
    guard[0],
    /throw/,
    'count failure must reach app/error.tsx, not an empty grid'
  );
});
