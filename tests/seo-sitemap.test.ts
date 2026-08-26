/**
 * Sitemap expansion: products enter the sitemap under the SAME visibility
 * contract as the storefront grid (active + ≥1 photo), reads stay bounded
 * (paged windows ≤1000, deterministic id tiebreaker), and no private route
 * ever enters the URL list (spec C of the SEO package).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectPaged } from '../app/lib/seo-sitemap.ts';

test('SITEMAP: collectPaged walks exact windows and stops on a short page', async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ slug: `s${i}` }));
  const calls: [number, number][] = [];
  const out = await collectPaged(async (from, limit) => {
    calls.push([from, limit]);
    return rows.slice(from, from + limit);
  }, { pageSize: 1000 });

  assert.deepEqual(calls, [[0, 1000], [1000, 1000], [2000, 1000]]);
  assert.equal(out.length, 2500);
  assert.equal(out[2499].slug, 's2499');
});

test('SITEMAP: collectPaged enforces pageSize ≤1000 and honors maxRows cap', async () => {
  const big = Array.from({ length: 999_999 }, (_, i) => i);
  const out = await collectPaged(
    async (from, limit) => big.slice(from, from + limit),
    { pageSize: 5000, maxRows: 2500 }
  );
  assert.equal(out.length, 2500);

  const seen: number[] = [];
  await collectPaged(
    async (_from, limit) => {
      seen.push(limit);
      return new Array(limit).fill(0);
    },
    { pageSize: 20000, maxRows: 10 }
  );
  assert.ok(seen.every((l) => l <= 1000), 'window must clamp to 1000');
});

test('SITEMAP: empty source resolves to an empty list without throwing', async () => {
  const out = await collectPaged(async () => [], { pageSize: 1000 });
  assert.deepEqual(out, []);
});

test('SITEMAP: product query mirrors storefront eligibility (source-level)', () => {
  const src = readFileSync('app/sitemap.ts', 'utf8');
  assert.match(src, /product_images!inner/, 'eligibility join required');
  assert.match(src, /\.eq\('is_active',\s*true\)/);
  assert.match(src, /\.order\('id'/, 'deterministic tiebreaker required');
  for (const banned of ['/cart', '/favorites', '/checkout', '/admin', '/api/']) {
    assert.ok(!src.includes(`'${banned}'`), `${banned} must not appear in sitemap paths`);
  }
});
