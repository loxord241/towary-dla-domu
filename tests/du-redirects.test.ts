/**
 * _du → base redirect allowlist (Task #34 regeneration; prior audits
 * 2026-08-31 and Task #26 2026-09-01):
 * invariants of the generated module + source-level wiring checks:
 * next.config 301-redirects ONLY allowlisted pairs (never the price-diff
 * pairs, never the 25 orphans) and the sitemap excludes exactly those slugs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DU_REDIRECT_PAIRS, DU_PRICE_DIFF_PAIRS, DU_REDIRECT_BY_YC, DU_REDIRECT_SLUGS,
} from '../app/lib/du-redirects.ts';
import duRedirectsJson from '../app/lib/du-redirects.json' with { type: 'json' };

test('DU: allowlist counts match the audit (105 redirect + 17 price-diff)', () => {
  // 2026-09-02 regeneration: 7290720_du drifted to equal prices and moved
  // from the price-diff list to the redirect list.
  assert.equal(DU_REDIRECT_PAIRS.length, 105);
  assert.equal(DU_PRICE_DIFF_PAIRS.length, 17);
});

test('DU: every pair is well-formed (_du slug strips exactly to base slug)', () => {
  for (const p of [...DU_REDIRECT_PAIRS, ...DU_PRICE_DIFF_PAIRS]) {
    assert.ok(p.duYc.endsWith('_du'), p.duYc);
    assert.ok(!p.baseYc.endsWith('_du'), p.baseYc);
    assert.equal(p.duSlug, `${p.baseSlug}_du`, p.duSlug);
    assert.notEqual(p.duSlug, p.baseSlug);
  }
});

test('DU: no duplicate keys, price-diff never overlaps the redirect set', () => {
  const ycs = [...DU_REDIRECT_BY_YC.keys()];
  assert.equal(new Set(ycs).size, ycs.length);
  for (const p of DU_PRICE_DIFF_PAIRS) {
    assert.ok(!DU_REDIRECT_BY_YC.has(p.duYc), `${p.duYc} must not redirect`);
  }
});

test('DU: price-diff pairs carry both prices for the pending decision', () => {
  for (const p of DU_PRICE_DIFF_PAIRS) {
    assert.ok(p.duPrice && p.basePrice && p.duPrice !== p.basePrice, p.duYc);
  }
});

test('DU: next.config 301-redirects exactly the JSON pairs, nothing else', () => {
  const src = readFileSync('next.config.ts', 'utf8');
  assert.match(src, /redirects\(\)/);
  assert.match(src, /statusCode:\s*301/);
  // the config's own comment documents "not permanent: true" — strip line
  // comments first so documentation doesn't trip the 308 invariant.
  const srcCode = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!srcCode.includes('permanent:'), 'must use statusCode 301, not permanent(308)');
  // JSON is the config source: same slugs as the TS allowlist.
  assert.equal(duRedirectsJson.redirect.length, 105);
  assert.deepEqual(
    duRedirectsJson.redirect.map((p) => p.duSlug).sort(),
    [...DU_REDIRECT_SLUGS].sort()
  );
  for (const p of duRedirectsJson.redirect) {
    assert.equal(p.baseSlug, p.duSlug.replace(/_du$/, ''));
  }
});

test('DU: sitemap filters redirected slugs', () => {
  const src = readFileSync('app/sitemap.ts', 'utf8');
  assert.match(src, /DU_REDIRECT_SLUGS\.has/);
});
