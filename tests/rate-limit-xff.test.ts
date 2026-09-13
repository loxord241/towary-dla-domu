/**
 * Rate limiter IP-source invariants (2026-08-27 security hardening stage).
 *
 * AUDIT CONTEXT: x-forwarded-for.split(',')[0] is only a safe rate-limit key
 * if the upstream proxy strips/overwrites client-supplied XFF. This project
 * deploys on Vercel, whose edge OVERWRITES x-forwarded-for with the real
 * client IP and does not forward externally supplied values — vercel.com/docs
 * (System Headers → x-forwarded-for): "we currently overwrite the
 * X-Forwarded-For header and do not forward external IPs. This restriction
 * is in place to prevent IP spoofing." x-real-ip is documented as identical.
 *
 * DECISION (assumption pinned by these tests, no runtime change):
 *   clientIpOf keeps taking the first XFF element — on Vercel that element
 *   is the edge-verified client IP and cannot be attacker-controlled, so a
 *   spoofed XFF cannot bypass rate limits. These tests freeze that behavior;
 *   if the deployment ever moves behind another proxy, the first-element
 *   selection must be re-validated (see the trust note in rate-limit.ts).
 *
 * next/server is not resolvable under plain node:test, so the REAL source
 * of app/lib/rate-limit.ts is loaded with only the NextResponse import
 * stubbed out — clientIpOf itself runs unmodified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = path.join(root, 'app/lib/rate-limit.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');

let cached: ((request: Request) => string) | undefined;

/**
 * Loads the REAL source of clientIpOf with only the next/server import
 * stubbed. Node's native type stripping executes the .ts as-is; clientIpOf
 * itself runs unmodified.
 */
async function loadClientIpOf(): Promise<(request: Request) => string> {
  if (cached) return cached;
  const code = source
    .replace(
      /import\s*\{\s*NextResponse\s*\}\s*from\s*'next\/server';/,
      'const NextResponse = Object;'
    )
    // the shared layer rides along (builtins resolve; supabase stays
    // dynamic and is never hit — only clientIpOf is read here)
    .replace(/from '\.\/rate-limit-shared'/g, "from './rate-limit-shared.mts'");
  const dir = mkdtempSync(path.join(tmpdir(), 'rate-limit-xff-'));
  try {
    writeFileSync(
      path.join(dir, 'rate-limit-shared.mts'),
      readFileSync(path.join(root, 'app/lib/rate-limit-shared.ts'), 'utf8')
    );
    const file = path.join(dir, 'rate-limit-stubbed.mts');
    writeFileSync(file, code);
    const mod = await import(pathToFileURL(file).href);
    cached = mod.clientIpOf;
    return cached!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function req(headers: Record<string, string>): Request {
  return new Request('https://example.com/api', { headers });
}

test('XFF: ', async () => {
  const clientIpOf = await loadClientIpOf();
  assert.equal(
    clientIpOf(req({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })),
    '203.0.113.7'
  );
});

test('XFF: ', async () => {
  const clientIpOf = await loadClientIpOf();
  assert.equal(
    clientIpOf(req({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.2 , 10.0.0.3' })),
    '203.0.113.7'
  );
});

test('XFF: ', async () => {
  const clientIpOf = await loadClientIpOf();
  assert.equal(clientIpOf(req({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9');
});

test('XFF: ', async () => {
  const clientIpOf = await loadClientIpOf();
  assert.equal(clientIpOf(req({})), 'unknown');
});

test('XFF: Vercel trust assumption is documented in rate-limit.ts', () => {
  assert.match(
    source,
    /vercel\.com\/docs/,
    'the Vercel XFF-overwrite trust assumption must be documented with a source'
  );
  assert.match(
    source,
    /prevent IP spoofing/i,
    'the anti-spoofing rationale must be documented'
  );
});

test('XFF: selection logic is unchanged (first element, not last element)', () => {
  // Regression guard: the LAST XFF element is the one adjacent to our server
  // and would be attacker-controlled behind some proxy topologies; the
  // current Vercel-deployment contract is the FIRST (edge-written) element.
  assert.match(source, /fwd\.split\(','\)\[0\]/);
  assert.doesNotMatch(source, /split\(','\)\.pop\(\)/);
});
