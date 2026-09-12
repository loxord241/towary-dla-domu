/**
 * Order security model — static invariant tests (READ-ONLY audit lock-in).
 *
 * Expected security architecture (migrations 006–008 + code audit 2026-08,
 * updated 2026-09: place_order EXECUTE revoked from anon/authenticated):
 *  - orders/order_items/customers: RLS enabled, NO public SELECT policy
 *    → anon sees an empty set (invisible-table semantics), writes revoked;
 *  - the ONLY write path is place_order() SECURITY DEFINER, invoked
 *    server-side with the service-role key; anon/authenticated EXECUTE is
 *    revoked by migration 036 (closes the direct-RPC rate-limit bypass);
 *  - guest viewing requires an HMAC capability token bound to the order
 *    number, derived from the service-role key, verified constant-time,
 *    BEFORE any database read on the view pages;
 *  - lookup endpoint is brute-force-rate-limited, returns a generic 404 for
 *    every failure mode, and projects ONLY order_number;
 *  - service role never reaches a client bundle; storefront catalog code
 *    never touches order tables.
 *
 * These are characterization tests: they pin the CURRENT verified state so
 * any drift (new policy assumptions, moved verification, widened selects)
 * fails CI. They require no production data and perform no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- token mechanism ----

test('ORDER-SEC: capability token is an HMAC of the service key, verified constant-time', () => {
  const t = src('app/lib/order-token.ts');
  assert.match(t, /createHmac\('sha256', process\.env\.SUPABASE_SERVICE_ROLE_KEY!\)/);
  assert.match(t, /timingSafeEqual/, 'comparison must be constant-time');
  assert.match(t, /expected\.length !== provided\.length/,
    'length guard must precede timingSafeEqual');
  assert.match(t, /typeof token !== ['"]string['"]/,
    'malformed token types must be rejected before comparison');
});

// ---- guest order view page ----

test('ORDER-SEC: /orders/[orderNumber] verifies the token BEFORE any page-data read', () => {
  const p = src('app/orders/[orderNumber]/page.tsx');
  const verifyAt = p.indexOf('verifyOrderAccessToken(orderNumber, t)');
  const readAt = p.indexOf(".from('orders')");
  assert.ok(verifyAt >= 0, 'token verification call missing');
  // 2026-09-12 rotation: the ONLY pre-verify read is the minimal
  // access_token_hash lookup by order number (the token material itself,
  // explicitly whitelisted column); every PAGE-data read still comes
  // after verification.
  assert.ok(readAt !== -1 && readAt < verifyAt, 'hash lookup precedes verify');
  assert.match(p, /\.select\('access_token_hash'\)/);
  const pageDataAt = p.indexOf("'id, order_number, status");
  assert.ok(pageDataAt > verifyAt, 'page data read must come after verification');
  assert.doesNotMatch(p, /select\('\*'\)|select\("\*"\)/,
    'order reads must use explicit column whitelists');
  assert.match(p, /SUPABASE_SERVICE_ROLE_KEY/, 'view re-reads via service client server-side');
});

// ---- checkout success page ----

test('ORDER-SEC: /checkout/success verifies token first and whitelists columns', () => {
  const p = src('app/checkout/success/page.tsx');
  const verifyAt = p.indexOf('verifyOrderAccessToken(orderNumber, t)');
  const readAt = p.indexOf(".from('orders')");
  assert.ok(verifyAt >= 0 && readAt > verifyAt);
  assert.doesNotMatch(p, /select\('\*'\)/);
  assert.match(p, /from\('order_items'\)/);
  assert.ok(!p.includes("'use client'"), 'must stay a server component');
});

// ---- lookup API ----

test('ORDER-SEC: lookup API is POST-only, rate-limited, generic-404, minimal projection', () => {
  const r = src('app/api/orders/lookup/route.ts');
  assert.match(r, /export async function POST/);
  assert.doesNotMatch(r, /export async function GET/, 'no listing endpoint may exist');
  assert.match(r, /enforceRateLimit\(request, ['"]lookup['"]\)/);
  // same generic message for malformed input and for miss — no oracle
  const matches = r.match(/Замовлення не знайдено/g) ?? [];
  assert.ok(matches.length >= 2, 'generic 404 must cover every failure branch');
  assert.match(r, /\.select\('order_number'\)/,
    'lookup must project only order_number (no PII)');
  assert.match(r, /eq\('order_number', orderNumber\)/);
  assert.match(r, /eq\('email', email\)/,
    'pair must match BOTH number and email');
  assert.match(r, /maybeSingle/);
});

// ---- checkout creation API ----

test('ORDER-SEC: order creation uses service-role client, place_order RPC, strict output shape', () => {
  const r = src('app/api/orders/route.ts');
  assert.match(r, /SUPABASE_SERVICE_ROLE_KEY/,
    'the RPC is called with the service-role key (server-side only)');
  assert.match(r, /rpc\('place_order'/,
    'writes must go exclusively through the SECURITY DEFINER RPC');
  assert.match(r, /enforceRateLimit\(request, ['"]orders['"]\)/);
  // the item payload is a hardcoded whitelist of identifiers only
  assert.match(
    r,
    /product_id: i\.productId,[\s\S]*?variant_id: i\.variantId,[\s\S]*?quantity: i\.quantity/,
    'client contract may carry identifiers/quantities only — never money values'
  );
});

test('ORDER-SEC: no anon/publishable client may call the place_order RPC', () => {
  // The rate limit lives only in the route; a publishable-key RPC call is
  // an unbounded stock-holding DoS vector. Migration 036 revokes anon/
  // authenticated EXECUTE — pin that no app code reaches for it directly.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(path.join(root, 'app'));
  for (const f of files) {
    const content = readFileSync(f, 'utf8');
    if (!content.includes("rpc('place_order'")) continue;
    assert.ok(
      !content.includes('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
      `place_order RPC caller must not use the publishable key: ${path.relative(root, f)}`
    );
  }
});

// Migration 036's content invariants live in
// tests/place-order-execute-revoke-migration.test.ts (035 pattern).


test('ORDER-SEC: creation response exposes only number/total/currency/token', () => {
  const r = src('app/api/orders/route.ts');
  // The FINAL response is the last NextResponse.json in the file (earlier
  // ones are early error returns). F2 changed the literal `status: 201`
  // into `created ? 201 : 200`, so the old positional anchor broke — this
  // anchor is robust either way and pins the same contract.
  const body = r.slice(r.lastIndexOf('NextResponse.json'));
  for (const field of ['orderNumber', 'accessToken']) {
    assert.match(body, new RegExp(field));
  }
  assert.doesNotMatch(body, /email|phone|shipping/i,
    'contact data must never be echoed back');
});

// ---- admin surface ----

test('ORDER-SEC: every admin orders route guards with requireAdminApi', () => {
  for (const f of [
    'app/api/admin/orders/route.ts',
    'app/api/admin/orders/[id]/route.ts',
    'app/api/admin/orders/expire/route.ts',
  ]) {
    const s = src(f);
    const guards = s.match(/requireAdminApi\(\)/g) ?? [];
    const handlers = (s.match(/export async function (GET|POST|PUT|PATCH|DELETE)/g) ?? []).length;
    assert.ok(guards.length >= handlers, `${f}: each handler needs its own guard`);
  }
});

// ---- bundle boundaries ----

test('ORDER-SEC: service-role key is referenced by NO client component', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(path.join(root, 'app'));
  for (const f of files) {
    const content = readFileSync(f, 'utf8');
    if (!content.includes('SUPABASE_SERVICE_ROLE_KEY')) continue;
    assert.ok(
      !content.includes("'use client'"),
      `service key must stay server-side: ${path.relative(root, f)}`
    );
  }
});

test('ORDER-SEC: storefront catalog layer has zero order/customer references', () => {
  const c = src('app/lib/catalog.ts');
  assert.doesNotMatch(c, /from\(['"](orders|order_items|customers)['"]/);
});
