/**
 * CSP enforcing invariants (2026-08-27 security hardening stage).
 *
 * The 2026-08-27 policy first shipped as Content-Security-Policy-Report-Only;
 * after the directive audit (scripts/styles/images/fonts/connect/form-action
 * all derived from real app usage — see next.config.ts buildCsp) it is now
 * ENFORCED. These tests exercise the REAL next.config.ts headers() output.
 *
 * Documented exception: script-src keeps 'unsafe-inline' because Next.js
 * App Router inline bootstrap/hydration scripts and the JSON-LD sinks need
 * it, and the nonce alternative forces dynamic rendering of every page
 * (ISR/static disabled) — an architectural rework, consciously deferred.
 * 'unsafe-eval' must NEVER appear in the production policy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.NEXT_PUBLIC_SUPABASE_URL ??=
  'https://fake-supabase-host.example.com';

const { default: nextConfig } = await import('../next.config.ts');

type HeaderEntry = { key: string; value: string };

async function allHeaders(): Promise<HeaderEntry[]> {
  const rules = (await nextConfig.headers?.()) ?? [];
  return rules.flatMap((rule) => (rule.headers as HeaderEntry[]) ?? []);
}

async function findHeader(key: string): Promise<HeaderEntry | undefined> {
  return (await allHeaders()).find((h) => h.key === key);
}

test('CSP: enforcing header is configured globally', async () => {
  const csp = await findHeader('Content-Security-Policy');
  assert.ok(csp, 'Content-Security-Policy (enforcing) must be present');
});

test('CSP: Report-Only is no longer used for the main policy', async () => {
  const keys = (await allHeaders()).map((h) => h.key);
  assert.ok(
    !keys.includes('Content-Security-Policy-Report-Only'),
    'Report-Only header must not ship alongside the enforcing policy'
  );
});

test('CSP: required directives are present with audited sources', async () => {
  const csp = (await findHeader('Content-Security-Policy'))?.value ?? '';
  const directives = Object.fromEntries(
    csp.split(';').map((d) => [d.trim().split(' ')[0], d.trim()])
  );
  assert.equal(directives['default-src'], "default-src 'self'");
  // 2026-09-13: GA4 + Clarity loaders joined script-src (пакет А) —
  // without them the analytics hits were CSP-blocked in production.
  assert.equal(
    directives['script-src'],
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.clarity.ms https://static.clarity.ms https://scripts.clarity.ms"
  );
  assert.match(directives['script-src'] ?? '', /googletagmanager\.com/);
  assert.equal(directives['style-src'], "style-src 'self' 'unsafe-inline'");
  assert.match(directives['img-src'] ?? '', /'self'/);
  assert.match(
    directives['img-src'] ?? '',
    /https:\/\/fake-supabase-host\.example\.com/
  );
  assert.match(directives['img-src'] ?? '', /https:\/\/b2b\.yugcontract\.ua/);
  assert.equal(directives['font-src'], "font-src 'self'");
  assert.match(
    directives['connect-src'] ?? '',
    /https:\/\/fake-supabase-host\.example\.com/
  );
  assert.equal(
    directives['form-action'],
    "form-action 'self' https://www.liqpay.ua",
    'LiqPay top-level form POST must stay permitted'
  );
  assert.equal(directives['frame-ancestors'], "frame-ancestors 'self'");
  assert.equal(directives['base-uri'], "base-uri 'self'");
  assert.equal(directives['object-src'], "object-src 'none'");
});

test('CSP: production policy contains NO unsafe-eval and NO dev relaxations', async () => {
  const env = process.env as { NODE_ENV?: string };
  const prev = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    const csp = (await findHeader('Content-Security-Policy'))?.value ?? '';
    assert.ok(csp.length > 0, 'sanity: header present');
    assert.ok(!csp.includes("'unsafe-eval'"), 'no eval in production');
    assert.ok(!/(^|; )connect-src [^;]*\bws:/.test(csp), 'no dev HMR ws:');
  } finally {
    env.NODE_ENV = prev;
  }
});

test('CSP: unsafe-inline decision is documented in next.config.ts', () => {
  const source = readFileSync(path.join(root, 'next.config.ts'), 'utf8');
  assert.match(
    source,
    /nonce-based CSP forces DYNAMIC rendering/i,
    'the exact reason for keeping unsafe-inline must be documented'
  );
});

test('CSP: other security headers are preserved', async () => {
  const keys = (await allHeaders()).map((h) => h.key);
  for (const key of [
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
    'Permissions-Policy',
    'Strict-Transport-Security',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
  ]) {
    assert.ok(keys.includes(key), `${key} must stay configured`);
  }
});

test('CSP: HSTS / COOP / CORP values', async () => {
  const hsts = await findHeader('Strict-Transport-Security');
  assert.equal(hsts?.value, 'max-age=31536000; includeSubDomains');
  const coop = await findHeader('Cross-Origin-Opener-Policy');
  assert.equal(coop?.value, 'same-origin');
  const corp = await findHeader('Cross-Origin-Resource-Policy');
  assert.equal(corp?.value, 'cross-origin');
});
