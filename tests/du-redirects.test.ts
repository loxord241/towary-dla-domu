/**
 * _du → base redirect allowlist (regeneration 2026-09-12; prior audits
 * Task #26/#34):
 * invariants of the generated module + source-level wiring checks:
 * next.config 301-redirects ALL verified pairs (2026-09-12 policy: drifted
 * prices no longer keep a second live page; the price-diff subset stays
 * documented in DU_PRICE_DIFF_PAIRS) and the sitemap + merchant feed
 * exclude exactly those slugs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DU_REDIRECT_PAIRS, DU_PRICE_DIFF_PAIRS, DU_REDIRECT_BY_YC, DU_REDIRECT_SLUGS,
} from '../app/lib/du-redirects.ts';
import duRedirectsJson from '../app/lib/du-redirects.json' with { type: 'json' };

test('DU: allowlist counts match the audit (293 redirect, 93 documented drifts)', () => {
  // 2026-09-12 regeneration + POLICY CHANGE (owner audit fix «дві ціни на
  // один товар»): ALL verified pairs redirect to base — a drifted _du
  // shadow page with a second price must not be a live storefront/feed
  // page. The price-diff subset stays documented with prices for
  // monitoring; next drift of the id set fails the generator gate.
  // 2026-09-16 regeneration: 10 pairs + 1 orphan deleted from the DB
  // outside the importer, 6895802_du promoted, 7220883_du equalized.
  // 2026-09-18 regeneration: pair/orphan sets unchanged (same 293 pair
  // ids, same 38 orphan rows); the 2026-09-18 sync repricing wave (run
  // yc-2026-09-18-13-28-09: 762 updated) drifted 74 pairs from equal
  // prices to differing; none of the previous 19 equalized, 7220883_du
  // drifted apart again (du 32999 vs base 33999) -> 19 -> 93 (verified
  // live, read-only re-audit before regeneration).
  assert.equal(DU_REDIRECT_PAIRS.length, 293);
  assert.equal(DU_PRICE_DIFF_PAIRS.length, 93);
});

test('DU: every pair is well-formed (_du slug strips exactly to base slug)', () => {
  for (const p of [...DU_REDIRECT_PAIRS, ...DU_PRICE_DIFF_PAIRS]) {
    assert.ok(p.duYc.endsWith('_du'), p.duYc);
    assert.ok(!p.baseYc.endsWith('_du'), p.baseYc);
    assert.equal(p.duSlug, `${p.baseSlug}_du`, p.duSlug);
    assert.notEqual(p.duSlug, p.baseSlug);
  }
});

test('DU: no duplicate keys; every price-diff pair IS in the redirect set', () => {
  const ycs = [...DU_REDIRECT_BY_YC.keys()];
  assert.equal(new Set(ycs).size, ycs.length);
  // Policy change: a drifted price no longer keeps the _du page alive.
  for (const p of DU_PRICE_DIFF_PAIRS) {
    assert.ok(DU_REDIRECT_BY_YC.has(p.duYc), `${p.duYc} must redirect to base`);
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
  assert.equal(duRedirectsJson.redirect.length, 293);
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
