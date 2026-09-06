/**
 * Admin login hardening invariants (2026-09 security audit).
 *
 * The admin login server action previously called signInWithPassword
 * without any rate limiting and forwarded the RAW Supabase error message
 * to the client via ?error=... — auth error texts distinguish "unknown
 * email" from "wrong password", letting an attacker enumerate admin
 * addresses. Enforcement is static: the login flow must
 *   (a) rate-limit per IP via the `adminLogin` rules in
 *       app/lib/rate-limit.ts (5/min burst + 20/hour ceiling, applied
 *       through enforceRateLimitByKey because a server action has no
 *       Request object);
 *   (b) redirect with a GENERIC message only — never error.message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const LOGIN_PAGE = 'app/admin/login/page.tsx';
const RATE_LIMIT = 'app/lib/rate-limit.ts';

const stripLineComments = (s: string): string =>
  s
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

test('LOGIN-HARDENING: login flow applies the adminLogin rate-limit rule', () => {
  const page = src(LOGIN_PAGE);
  assert.match(
    page,
    /enforceRateLimitByKey\s*\(/,
    'handleLogin must apply a named rate-limit rule'
  );
  assert.match(
    page,
    /'adminLogin'/,
    'the applied rule must be adminLogin'
  );
  assert.match(
    page,
    /ipFromHeaders/,
    'the key must be built from request headers (per-IP)'
  );
});

test('LOGIN-HARDENING: rate-limit.ts defines adminLogin: 5/min burst + hourly ceiling', () => {
  const lib = src(RATE_LIMIT);
  assert.match(
    lib,
    /adminLogin:\s*\[\s*\{\s*max:\s*5,\s*windowMs:\s*60_000\s*\},\s*\{\s*max:\s*20,\s*windowMs:\s*60\s*\*\s*60_000\s*\},?\s*\]/,
    'adminLogin must be a 5/min burst plus a 20/hour ceiling, per IP'
  );
});

test('LOGIN-HARDENING: auth failures redirect with a generic message, never the raw Supabase error', () => {
  const body = stripLineComments(src(LOGIN_PAGE));
  assert.match(
    body,
    /Невірний email або пароль/,
    'login page must define and use the generic auth-error text'
  );
  assert.doesNotMatch(
    body,
    /error\s*=\s*\+\s*encodeURIComponent\s*\(\s*error\.message/,
    'raw error.message must never be forwarded to the client as ?error='
  );
  assert.doesNotMatch(
    body,
    /encodeURIComponent\(\s*error\.message\s*\)/,
    'error.message must not be encoded into the redirect URL'
  );
});

test('LOGIN-HARDENING: the raw failure reason is logged server-side only', () => {
  const body = stripLineComments(src(LOGIN_PAGE));
  assert.match(
    body,
    /console\.error\(\s*'?\[admin-login\]'?[^)]*error\.message/,
    'the real Supabase error must be logged server-side for diagnostics'
  );
});
