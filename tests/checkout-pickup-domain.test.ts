/**
 * T-C (owner decision 2026-09-18): server-side fail-closed check
 * «точка самовывоза ↔ домен корзины» at POST /api/orders.
 *
 * Bug: the pickup point choice was filtered only in the UI
 * (CheckoutForm/PickupBlock offer only the points whose domain the cart
 * contains) — the API accepted ANY whitelisted PICKUP_POINTS id for ANY
 * cart, so a crafted payload could place a wallpaper cart «на точке
 * техніки». place_order() deliberately knows nothing about pickup
 * domains (prices/stock/identifiers only), so the check belongs in the
 * route — AFTER a cart-preview-like slug resolution of the cart's
 * product ids (sanitizeDelivery never sees slugs: the client sends
 * product ids only) and BEFORE the place_order RPC, which stays
 * untouched.
 *
 * Semantics = the established UI rule (union): a point is valid iff it
 * serves ≥1 product domain present in the cart; a mixed cart is served
 * by every compatible point (the whole order waits at the chosen one).
 * Failure → 400 «Обрана точка видачі не підходить для товарів у кошику»,
 * nothing is written (no RPC call).
 *
 * Layers:
 *  1. pure predicate pickupPointCoversDomains (checkout-delivery.ts) —
 *     real behaviour for all three owner-defined points + fail-closed
 *     edges;
 *  2. runtime behaviour of the REAL orders route source with only the
 *     untestable edges stubbed (project harness pattern:
 *     tests/callback-request.test.ts, tests/ukrposhta-routes.test.ts):
 *     mismatched point → 400 without any place_order call; pure and
 *     mixed carts keep working; a carrier order never triggers the slug
 *     read; a failed slug read keeps the existing «order dies in
 *     place_order» behavior (documented fail-open of the CHECK ONLY —
 *     the order itself still cannot complete).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// The REAL route re-derives the order-token secret from the service key
// at call time — provide it before the route module ever runs.
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---------------------------------------------------------------------------
// 1. Pure predicate: pickupPointCoversDomains (union semantics, fail-closed)
// ---------------------------------------------------------------------------

import {
  pickupPointCoversDomains,
  PICKUP_POINTS,
} from '../app/lib/checkout-delivery.ts';
import { domainOfSlug, type ProductDomain } from '../app/lib/domains.ts';

test('PICKUP-DOMAIN: owner fixtures — 87А serves tech, 83А wallpaper, 89А linoleum', () => {
  assert.deepEqual(
    PICKUP_POINTS.map((p) => [p.id, [...p.domains]]),
    [
      ['kr-mazepy-87a', ['tech']],
      ['kr-mazepy-83a', ['wallpaper']],
      ['kr-mazepy-89a', ['linoleum']],
    ]
  );
  // Slug→domain vocabulary agrees with the point split.
  assert.equal(domainOfSlug('wc-123'), 'wallpaper');
  assert.equal(domainOfSlug('ln-beauflor'), 'linoleum');
  assert.equal(domainOfSlug('elektrochajnik-bosch'), 'tech');
});

test('PICKUP-DOMAIN: predicate — point serves a cart only via a shared domain', () => {
  const d = (...names: ProductDomain[]) => new Set<ProductDomain>(names);
  // 87А (tech): pure carts.
  assert.equal(pickupPointCoversDomains('kr-mazepy-87a', d('tech')), true);
  assert.equal(pickupPointCoversDomains('kr-mazepy-87a', d('wallpaper')), false);
  assert.equal(pickupPointCoversDomains('kr-mazepy-87a', d('linoleum')), false);
  // Union: mixed tech+linoleum cart is served by BOTH compatible points.
  assert.equal(pickupPointCoversDomains('kr-mazepy-87a', d('tech', 'linoleum')), true);
  assert.equal(pickupPointCoversDomains('kr-mazepy-89a', d('tech', 'linoleum')), true);
  assert.equal(pickupPointCoversDomains('kr-mazepy-83a', d('tech', 'linoleum')), false);
  // All three domains — every point compatible.
  assert.equal(pickupPointCoversDomains('kr-mazepy-87a', d('tech', 'wallpaper', 'linoleum')), true);
  assert.equal(pickupPointCoversDomains('kr-mazepy-83a', d('tech', 'wallpaper', 'linoleum')), true);
  assert.equal(pickupPointCoversDomains('kr-mazepy-89a', d('tech', 'wallpaper', 'linoleum')), true);
});

test('PICKUP-DOMAIN: predicate is fail-closed on unknown point and empty domains', () => {
  const any = new Set<ProductDomain>(['tech', 'wallpaper', 'linoleum']);
  assert.equal(pickupPointCoversDomains('kr-nebugska-1', any), false);
  assert.equal(pickupPointCoversDomains('', any), false);
  assert.equal(pickupPointCoversDomains(undefined, any), false);
  assert.equal(pickupPointCoversDomains(null, any), false);
  assert.equal(pickupPointCoversDomains(42 as unknown as string, any), false);
  const empty = new Set<ProductDomain>();
  for (const p of PICKUP_POINTS) {
    assert.equal(pickupPointCoversDomains(p.id, empty), false, p.id);
  }
});

// ---------------------------------------------------------------------------
// 2. Runtime harness: the REAL orders route with stubbed edges
// ---------------------------------------------------------------------------

interface RouteTestGlobal {
  __pcClientArgs?: unknown[][];
  __pcRpcCalls?: { fn: string; args: unknown }[];
  __pcTables?: string[];
  __pcSlugQueryIds?: string[];
  __pcSlugError?: { message: string } | null;
  __pcProducts?: Record<string, string>;
  __pcRpcResult?: { data: unknown; error: unknown } | null;
}
const g = globalThis as RouteTestGlobal;

function resetRouteFakes() {
  g.__pcClientArgs = [];
  g.__pcRpcCalls = [];
  g.__pcTables = [];
  g.__pcSlugQueryIds = undefined;
  g.__pcSlugError = null;
  g.__pcProducts = {};
  g.__pcRpcResult = {
    data: { order_number: 'TD-100500', total: 320, currency: 'UAH', created: true },
    error: null,
  };
}

interface RouteModule {
  POST: (request: Request) => Promise<Response>;
}

const modUrl = (rel: string): string => pathToFileURL(path.join(root, rel)).href;

/**
 * Loads the REAL app/api/orders/route.ts with only the untestable edges
 * stubbed (project pattern): next/server (NextResponse+after), the
 * limiter, the same-origin gate and the telegram lib are stubs; the
 * order-token, checkout-delivery, domains and idempotency modules are
 * the REAL sources resolved by file URL; supabase routes through a
 * scripted createClient on globalThis.
 */
async function loadRoute(): Promise<RouteModule> {
  const nextShim = `const NextResponse = { json: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), init) };
const after = (_fn: unknown) => {};`;
  const rlStub = 'const enforceRateLimit = async (): Promise<null> => null;';
  const originStub = 'const assertSameOrigin = (_request: unknown): boolean => true;';
  const tgStub = `const sendTelegramOrderNotification = async (_n: string) => {};
const sendOwnerErrorAlert = async (_t: string, _d: string) => {};`;
  const sbStub = `const createClient = (...args: unknown[]) => {
  const gg = globalThis as RouteTestGlobal;
  (gg.__pcClientArgs = gg.__pcClientArgs ?? []).push(args);
  return {
    rpc(fn: string, rpcArgs: unknown) {
      (gg.__pcRpcCalls = gg.__pcRpcCalls ?? []).push({ fn, args: rpcArgs });
      return Promise.resolve(gg.__pcRpcResult ?? { data: null, error: null });
    },
    from(table: string) {
      (gg.__pcTables = gg.__pcTables ?? []).push(table);
      return {
        select(_cols: string) {
          return {
            in(_col: string, ids: string[]) {
              gg.__pcSlugQueryIds = ids;
              if (gg.__pcSlugError) {
                return Promise.resolve({ data: null, error: gg.__pcSlugError });
              }
              const rows = (ids ?? [])
                .map((id: string) => ({ id, slug: gg.__pcProducts?.[id] }))
                .filter((r: { slug: string | undefined }) => typeof r.slug === 'string');
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
        update(_payload: unknown) {
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
  };
};`;

  const rewritten = src('app/api/orders/route.ts')
    .replace(/import\s*\{\s*NextResponse\s*,\s*after\s*\}\s*from\s*'next\/server';/, nextShim)
    .replace(
      /import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/order-token';/,
      `const { generateOrderAccessToken, hashOrderAccessToken, orderAccessToken } = await import('${modUrl('app/lib/order-token.ts')}');`
    )
    .replace(/import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/rate-limit';/, rlStub)
    .replace(/import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/request-origin';/, originStub)
    .replace(
      /import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/checkout-delivery';/,
      `const { sanitizeDelivery, pickupPointCoversDomains } = await import('${modUrl('app/lib/checkout-delivery.ts')}');`
    )
    .replace(
      /import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/domains';/,
      `const { domainOfSlug } = await import('${modUrl('app/lib/domains.ts')}');`
    )
    .replace(
      /import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/idempotency';/,
      `const { parseIdempotencyKey } = await import('${modUrl('app/lib/idempotency.ts')}');`
    )
    .replace(/import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/notifications\/telegram';/, tgStub)
    .replace(/import\s*\{\s*createClient\s*\}\s*from\s*'@supabase\/supabase-js';/, sbStub);

  assert.ok(!rewritten.includes("'@/app/lib/"), 'harness drift: an @/ alias import is not stubbed');
  assert.ok(!rewritten.includes("'@supabase/supabase-js'"), 'harness drift: supabase not stubbed');
  assert.ok(!rewritten.includes("from 'next/server'"), 'harness drift: next/server not stubbed');

  const dir = mkdtempSync(path.join(tmpdir(), 'orders-route-'));
  try {
    const file = path.join(dir, 'route-stubbed.mts');
    writeFileSync(file, rewritten);
    return (await import(pathToFileURL(file).href)) as RouteModule;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UUID_TECH = 'aaaaaa11-0000-4000-8000-000000000001';
const UUID_WALL = 'aaaaaa22-0000-4000-8000-000000000002';
const UUID_LINO = 'aaaaaa33-0000-4000-8000-000000000003';

const pickup = (pickupPointId: string, over: Record<string, unknown> = {}) => ({
  serviceType: 'pickup',
  pickupPointId,
  ...over,
});

const postRequest = (body: unknown): Request =>
  new Request('https://example.com/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const cartBody = (
  productIds: string[],
  delivery: unknown
): Record<string, unknown> => ({
  contact: { name: 'Тест Тестовий', email: 't@e.example', phone: '' },
  shipping: delivery === undefined ? {} : { delivery },
  items: productIds.map((productId) => ({ productId, quantity: 1 })),
});

const route = await loadRoute();

async function post(
  productIds: string[],
  delivery: unknown,
  opts: {
    products?: Record<string, string>;
    slugError?: { message: string } | null;
  } = {}
): Promise<{ res: Response; body: Record<string, unknown> }> {
  resetRouteFakes();
  g.__pcProducts = opts.products ?? {};
  g.__pcSlugError = opts.slugError ?? null;
  const res = await route.POST(postRequest(cartBody(productIds, delivery)));
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

// ---------------------------------------------------------------------------
// 3. Runtime behaviour
// ---------------------------------------------------------------------------

test('PICKUP-DOMAIN route: REGRESSION — tech cart on the linoleum point (89А) is 400, nothing written', async () => {
  const { res, body } = await post([UUID_TECH], pickup('kr-mazepy-89a'), {
    products: { [UUID_TECH]: 'elektrochajnik-bosch' },
  });
  assert.equal(res.status, 400);
  assert.equal(body.error, 'Обрана точка видачі не підходить для товарів у кошику');
  assert.equal((g.__pcRpcCalls ?? []).length, 0, 'no place_order call before the 400');
});

test('PICKUP-DOMAIN route: wallpaper cart on the tech point (87А) is 400, nothing written', async () => {
  const { res, body } = await post([UUID_WALL], pickup('kr-mazepy-87a'), {
    products: { [UUID_WALL]: 'wc-100500-amber' },
  });
  assert.equal(res.status, 400);
  assert.equal(body.error, 'Обрана точка видачі не підходить для товарів у кошику');
  assert.equal((g.__pcRpcCalls ?? []).length, 0);
});

test('PICKUP-DOMAIN route: cash_on_pickup does not bypass the domain check', async () => {
  const { res, body } = await post(
    [UUID_TECH],
    pickup('kr-mazepy-89a', { paymentIntent: 'cash_on_pickup' }),
    { products: { [UUID_TECH]: 'elektrochajnik-bosch' } }
  );
  assert.equal(res.status, 400);
  assert.equal(body.error, 'Обрана точка видачі не підходить для товарів у кошику');
});

test('PICKUP-DOMAIN route: linoleum cart on 89А proceeds to place_order (201)', async () => {
  const { res, body } = await post([UUID_LINO], pickup('kr-mazepy-89a'), {
    products: { [UUID_LINO]: 'ln-beauflor-amber' },
  });
  assert.equal(res.status, 201);
  assert.equal(body.orderNumber, 'TD-100500');
  assert.equal((g.__pcRpcCalls ?? []).length, 1);
  assert.equal(g.__pcRpcCalls?.[0]?.fn, 'place_order');
  // The slug read queried exactly the cart's product ids.
  assert.deepEqual(g.__pcSlugQueryIds, [UUID_LINO]);
});

test('PICKUP-DOMAIN route: mixed tech+linoleum cart on 87А proceeds (union, same rule as the UI)', async () => {
  const mixed = {
    [UUID_TECH]: 'elektrochajnik-bosch',
    [UUID_LINO]: 'ln-beauflor-amber',
  };
  const { res, body } = await post(
    [UUID_TECH, UUID_LINO],
    pickup('kr-mazepy-87a'),
    { products: mixed }
  );
  assert.equal(res.status, 201);
  assert.equal(body.orderNumber, 'TD-100500');
  assert.equal((g.__pcRpcCalls ?? []).length, 1);
});

test('PICKUP-DOMAIN route: mixed tech+linoleum cart on 89А proceeds (other compatible point)', async () => {
  const mixed = {
    [UUID_TECH]: 'elektrochajnik-bosch',
    [UUID_LINO]: 'ln-beauflor-amber',
  };
  const { res } = await post([UUID_TECH, UUID_LINO], pickup('kr-mazepy-89a'), {
    products: mixed,
  });
  assert.equal(res.status, 201);
});

test('PICKUP-DOMAIN route: unknown point id → legacy 400 «Некоректні дані доставки», no DB reads', async () => {
  const { res, body } = await post([UUID_TECH], pickup('kr-nebugska-1'));
  assert.equal(res.status, 400);
  assert.equal(body.error, 'Некоректні дані доставки');
  assert.equal(g.__pcSlugQueryIds, undefined, 'sanitize rejects before any slug read');
  assert.equal((g.__pcRpcCalls ?? []).length, 0);
});

test('PICKUP-DOMAIN route: a carrier (NP warehouse) order never triggers the slug read', async () => {
  const { res } = await post(
    [UUID_TECH],
    {
      serviceType: 'nova_poshta_warehouse',
      settlementId: 5,
      settlementName: 'Кривий Ріг',
      divisionId: 1,
    },
    { products: { [UUID_TECH]: 'elektrochajnik-bosch' } }
  );
  assert.equal(res.status, 201);
  assert.equal(g.__pcSlugQueryIds, undefined, 'no products query for carrier orders');
  assert.equal((g.__pcRpcCalls ?? []).length, 1);
});

test('PICKUP-DOMAIN route: failed slug read keeps the existing behavior (order dies in place_order)', async () => {
  // Documented decision: the CHECK validates only successfully resolved
  // products; if the slug read errors, no validation happens here and the
  // order flows to place_order, which rejects unknown products itself.
  const { res, body } = await post([UUID_LINO], pickup('kr-mazepy-87a'), {
    products: { [UUID_LINO]: 'ln-beauflor-amber' },
    slugError: { message: 'db down' },
  });
  assert.equal(res.status, 201, 'route does not turn a slug-read error into a 4xx');
  assert.equal(body.orderNumber, 'TD-100500');
  assert.equal((g.__pcRpcCalls ?? []).length, 1);
});
