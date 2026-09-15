/**
 * robots.txt contract: public storefront crawlable, every private/technical
 * surface disallowed, sitemap linked (spec D of the SEO package 2026-08-26).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import robots from '../app/robots.ts';

test('ROBOTS: all private surfaces disallowed for every crawler', () => {
  const rules = robots().rules;
  assert.ok(Array.isArray(rules));
  const star = rules.find((r) => r.userAgent === '*');
  assert.ok(star, 'must target all user agents');
  const disallow = Array.isArray(star.disallow) ? star.disallow : [star.disallow];
  for (const required of [
    '/admin',
    '/api/',
    '/checkout',
    // Audit R19 2026-09-15: the bare path is disallowed too — '/orders/'
    // alone would not cover a future /orders index page.
    '/orders',
    '/orders/',
    '/cart',
    '/favorites',
  ]) {
    assert.ok(disallow.includes(required), `missing Disallow: ${required}`);
  }
  const allow = Array.isArray(star.allow) ? star.allow : [star.allow];
  assert.ok(
    allow.includes('/'),
    'storefront must stay crawlable (CSS/JS/images included)'
  );
});

test('ROBOTS: sitemap URL points at /sitemap.xml of the configured origin', () => {
  const sitemap = robots().sitemap;
  assert.equal(typeof sitemap, 'string');
  assert.match(sitemap as string, /\/sitemap\.xml$/);
});

test('NOINDEX: technical routes carry robots noindex metadata (source-level)', () => {
  const sources: [string, RegExp][] = [
    ['app/cart/layout.tsx', /index:\s*false/],
    ['app/favorites/layout.tsx', /index:\s*false/],
    ['app/orders/layout.tsx', /index:\s*false/],
    ['app/checkout/layout.tsx', /index:\s*false/],
    ['app/admin/(dashboard)/layout.tsx', /index:\s*false/],
    ['app/admin/login/page.tsx', /index:\s*false/],
  ];
  for (const [file, re] of sources) {
    assert.match(readFileSync(file, 'utf8'), re, `${file} must declare noindex`);
  }
});
