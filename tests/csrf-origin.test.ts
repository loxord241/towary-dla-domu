/**
 * Same-origin gate on public POST endpoints (audit P1, 2026-09-12).
 *
 * Covers:
 *  1. assertSameOrigin unit — Origin absent → proceed (curl/server-to-
 *     server); Origin matching Host or any X-Forwarded-Host element →
 *     proceed; mismatched or malformed Origin → reject (fail closed);
 *  2. static pins — every public POST endpoint (orders, feedback,
 *     reviews POST, restock-notify, callback-request, cart-preview)
 *     calls the gate right after the rate limiter and answers
 *     403 forbidden_origin; provider callbacks (LiqPay) and admin /
 *     bearer-keyed ingest routes are deliberately NOT gated (server-to-
 *     server, no browser Origin to match);
 *  3. the runtime harnesses of restock/callback tests stub the gate —
 *     they post without Origin, which the real gate admits anyway.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { assertSameOrigin } from '../app/lib/request-origin.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const GATED_ROUTES: [string, string][] = [
  ['app/api/orders/route.ts', 'orders'],
  ['app/api/feedback/route.ts', 'feedback'],
  ['app/api/reviews/route.ts', 'reviews'],
  ['app/api/products/restock-notify/route.ts', 'restockNotify'],
  ['app/api/products/callback-request/route.ts', 'callbackRequest'],
  ['app/api/cart-preview/route.ts', 'cartPreview'],
];

const req = (headers: Record<string, string>): Request =>
  new Request('https://towary-dla-domu.com/api/x', {
    method: 'POST',
    headers,
  });

test('ORIGIN unit: absent Origin proceeds (non-browser clients)', () => {
  assert.equal(assertSameOrigin(req({ host: 'towary-dla-domu.com' })), true);
  assert.equal(assertSameOrigin(req({})), true);
});

test('ORIGIN unit: matching Host or X-Forwarded-Host proceeds', () => {
  assert.equal(
    assertSameOrigin(
      req({ host: 'towary-dla-domu.com', origin: 'https://towary-dla-domu.com' })
    ),
    true
  );
  // Behind the edge proxy: Host is internal, XFH carries the public host.
  assert.equal(
    assertSameOrigin(
      req({
        host: 'internal:8080',
        'x-forwarded-host': 'towary-dla-domu.com',
        origin: 'https://towary-dla-domu.com',
      })
    ),
    true
  );
  // First XFF element wins over trailing junk; case-insensitive.
  assert.equal(
    assertSameOrigin(
      req({
        host: 'internal:8080',
        'x-forwarded-host': 'TOWARY-DLA-DOMU.com, other.example',
        origin: 'https://towary-dla-domu.com',
      })
    ),
    true
  );
});

test('ORIGIN unit: mismatched or malformed Origin fails closed', () => {
  assert.equal(
    assertSameOrigin(
      req({ host: 'towary-dla-domu.com', origin: 'https://evil.example' })
    ),
    false
  );
  assert.equal(
    assertSameOrigin(
      req({
        host: 'internal:8080',
        'x-forwarded-host': 'towary-dla-domu.com',
        origin: 'https://evil.example',
      })
    ),
    false
  );
  assert.equal(assertSameOrigin(req({ host: 'towary-dla-domu.com', origin: 'not a url' })), false);
});

test('GATE: every public POST route gates right after the rate limiter → 403', () => {
  for (const [route, rule] of GATED_ROUTES) {
    const code = src(route);
    const limitedIdx = code.indexOf(`enforceRateLimit(request, '${rule}')`);
    const gateIdx = code.indexOf('assertSameOrigin(request)');
    assert.ok(limitedIdx !== -1, `${route}: rate limiter missing`);
    assert.ok(gateIdx !== -1, `${route}: origin gate missing`);
    assert.ok(gateIdx > limitedIdx, `${route}: gate must follow the rate limiter`);
    assert.match(code, /forbidden_origin/);
    assert.match(code, /status: 403/);
    // Exactly one gate call per route file (the reviews GET must not gate).
    assert.equal((code.match(/assertSameOrigin\(request\)/g) ?? []).length, 1);
  }
});

test('GATE: provider callback and bearer-keyed ingest are NOT gated', () => {
  // LiqPay callback is server-to-server from the provider — no browser
  // Origin to match; ingest carries its own bearer key.
  assert.doesNotMatch(src('app/api/payment/liqpay/callback/route.ts'), /assertSameOrigin/);
  assert.doesNotMatch(src('app/api/ingest/1c-wallpaper/route.ts'), /assertSameOrigin/);
});
