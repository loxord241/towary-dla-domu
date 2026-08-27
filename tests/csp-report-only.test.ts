/**
 * CSP Report-Only invariants (2026-08-27 security stage).
 *
 * The policy ships as Content-Security-Policy-Report-Only FIRST: gather
 * production violation evidence before any enforcement GO. The header is
 * therefore expected to be present globally, never enforced here.
 *
 * Directives are derived from audited facts:
 *  - scripts: Next self-hosted chunks + inline hydration & JSON-LD
 *    ('unsafe-inline' unavoidable today; 'unsafe-eval' NOT allowed);
 *  - styles: compiled CSS + React style attributes;
 *  - images: Supabase public bucket + Yugcontract hotlinks;
 *  - fonts: next/font self-hosted woff2;
 *  - connections: same-origin API + Supabase Auth/REST;
 *  - forms: LiqPay checkout POST navigates away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('next.config.ts', 'utf8');

test('CSP: a Report-Only policy is configured globally', () => {
  assert.match(
    config,
    /['"]Content-Security-Policy-Report-Only['"]/,
    'Content-Security-Policy-Report-Only header must be configured'
  );
});

test('CSP: enforcement mode must NOT be enabled by this change', () => {
  assert.doesNotMatch(
    config,
    /['"]Content-Security-Policy['"]\s*:\s*\[/,
    'report-only stage only — an enforcing header needs its own GO'
  );
});

test('CSP: required directive coverage', () => {
  for (const directive of [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    'img-src',
    'https://b2b.yugcontract.ua',
    "font-src 'self'",
    "connect-src 'self'",
    'https://${SUPABASE_HOST}',
    "form-action 'self' https://www.liqpay.ua",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ]) {
    assert.ok(config.includes(directive), `policy must contain ${directive}`);
  }
});

test('CSP: no eval source is granted', () => {
  // Strip line comments before scanning: only real directive text counts.
  const code = config
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(!code.includes("'unsafe-eval'"), 'production app has no eval need');
});
