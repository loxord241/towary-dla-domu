/**
 * Ukrposhta public proxy routes — behavior tests, loaded from the REAL
 * route sources with only the untestable edges stubbed (project pattern:
 * next/server is not resolvable under plain node:test and @/ aliases need
 * rewriting; the parse/normalize/proxy logic itself runs unmodified).
 *
 * Pins:
 *   - settlements/offices: fail-closed 400 on bad params (no provider
 *     call), success proxy of the REAL classifier logic, and typed
 *     failure mapping (503 without any Ukrposhta configuration).
 *   - delivery-cost: fail-closed 503 BEFORE any provider call when the
 *     sender post index is not configured (no bearer environment), and
 *     400 on an invalid body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel: string): string =>
  pathToFileURL(path.join(root, rel)).href;

// The routes classify failures with isUkrposhtaError (instanceof), so the
// scripted failures must be REAL UkrposhtaError instances from the same
// module the generated route imports.
import { UkrposhtaError } from '../app/lib/delivery/ukrposhta/errors.ts';

type RouteModule = {
  GET?: (request: Request) => Promise<Response>;
  POST?: (request: Request) => Promise<Response>;
};

function loadRoute(
  routeRel: string,
  replacements: [RegExp, string][]
): Promise<RouteModule> {
  let source = readFileSync(path.join(root, routeRel), 'utf8');
  source = source
    .replace(
      /import\s*\{\s*NextResponse\s*\}\s*from\s*'next\/server';/,
      `const NextResponse = { json: (body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), init) };`
    )
    .replace(
      /import\s*\{\s*enforceRateLimit\s*\}\s*from\s*'@\/app\/lib\/rate-limit';/,
      'const enforceRateLimit = (): null => null;'
    );
  for (const [pattern, replacement] of replacements) {
    source = source.replace(pattern, replacement);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'up-route-'));
  try {
    const file = path.join(dir, 'route-stubbed.mts');
    writeFileSync(file, source);
    return import(pathToFileURL(file).href) as Promise<RouteModule>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const req = (url: string, init?: RequestInit) =>
  new Request(`http://localhost${url}`, init);

// ------------------------------------------------------------------
// Shared stub of getUkrposhtaClient: routes through a global hook so the
// REAL settlements/offices/delivery-cost logic runs against a scripted
// client.
// ------------------------------------------------------------------
type Hook = {
  calls: { path: string; params?: URLSearchParams; body?: unknown }[];
  result?: unknown;
  throw?: unknown;
};
const hookOf = (name: string): Hook => {
  return ((globalThis as Record<string, unknown>)[name] ??= {
    calls: [],
  }) as Hook;
};

const CLIENT_STUB = (hookName: string): string => `
  const getUkrposhtaClient = () => ({
    async classifierGet(p: string, params: URLSearchParams) {
      const hook = (globalThis as Record<string, unknown>)[
        '${hookName}'
      ] as Hook;
      hook.calls.push({ path: p, params });
      if (hook.throw) throw hook.throw;
      return hook.result;
    },
    async ecomPost(p: string, body: unknown) {
      const hook = (globalThis as Record<string, unknown>)[
        '${hookName}'
      ] as Hook;
      hook.calls.push({ path: p, body });
      if (hook.throw) throw hook.throw;
      return hook.result;
    },
  });
  type Hook = {
    calls: { path: string; params?: URLSearchParams; body?: unknown }[];
    result?: unknown;
    throw?: unknown;
  };
`;

// ------------------------------------------------------------------
// GET /api/delivery/ukrposhta/settlements
// ------------------------------------------------------------------

const SETTLEMENTS_MAP: [RegExp, string][] = [
  [
    /import\s*\{\s*getUkrposhtaClient\s*\}[^;]*;/,
    CLIENT_STUB('__upSettlementsHook'),
  ],
  [/import\s*\{\s*mapUkrposhtaFailure\s*\}[^;]*;/, `const mapUkrposhtaFailure = (await import('${mod('app/lib/delivery/ukrposhta/map-failure.ts')}')).mapUkrposhtaFailure;`],
  [/import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/delivery\/ukrposhta\/settlements';/, `const { parseSettlementsQuery, searchSettlements } = await import('${mod('app/lib/delivery/ukrposhta/settlements.ts')}');`],
];

test('SETTLEMENTS route: success proxies q → city_ua against the classifier', async () => {
  const hook = hookOf('__upSettlementsHook');
  hook.calls = [];
  hook.result = {
    Entries: {
      Entry: [
        {
          CITY_ID: '14288',
          CITY_UA: 'Львів',
          SHORTCITYTYPE_UA: 'м.',
          DISTRICT_UA: 'Львівський',
          REGION_UA: 'Львівська',
          CITY_KATOTTG: '46060250010015970',
          CITY_KOATUU: '4610100000',
        },
        { junk: true },
      ],
    },
  };
  const { GET } = await loadRoute(
    'app/api/delivery/ukrposhta/settlements/route.ts',
    SETTLEMENTS_MAP
  );
  const res = await GET!(
    req('/api/delivery/ukrposhta/settlements?q=%D0%9B%D1%8C%D0%B2%D1%96%D0%B2')
  );
  assert.equal(res.status, 200);
  assert.equal(hook.calls.length, 1);
  assert.equal(hook.calls[0]!.path, 'get_city_by_region_id_and_district_id_and_city_ua');
  assert.equal(hook.calls[0]!.params!.get('city_ua'), 'Львів');
  const data = (await res.json()) as { items: { id: number; name: string }[] };
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0]!.id, 14288);
  assert.equal(data.items[0]!.name, 'Львів');
});

test('SETTLEMENTS route: 400 on bad query (too short) with NO provider call', async () => {
  const hook = hookOf('__upSettlementsHook');
  hook.calls = [];
  const { GET } = await loadRoute(
    'app/api/delivery/ukrposhta/settlements/route.ts',
    SETTLEMENTS_MAP
  );
  const res = await GET!(req('/api/delivery/ukrposhta/settlements?q=%D0%9B'));
  assert.equal(res.status, 400);
  assert.equal(hook.calls.length, 0);
});

test('SETTLEMENTS route: typed unavailable failure maps to 503 with a safe message', async () => {
  const hook = hookOf('__upSettlementsHook');
  hook.calls = [];
  hook.throw = new UkrposhtaError('unavailable', 'classifier is unreachable');
  const { GET } = await loadRoute(
    'app/api/delivery/ukrposhta/settlements/route.ts',
    SETTLEMENTS_MAP
  );
  const res = await GET!(
    req('/api/delivery/ukrposhta/settlements?q=%D0%9B%D1%8C%D0%B2%D1%96%D0%B2')
  );
  assert.equal(res.status, 503);
  const data = (await res.json()) as { error?: string };
  assert.ok(data.error && data.error.length > 0 && !/unreachable/.test(data.error));
});

// ------------------------------------------------------------------
// GET /api/delivery/ukrposhta/offices
// ------------------------------------------------------------------

const OFFICES_MAP: [RegExp, string][] = [
  [
    /import\s*\{\s*getUkrposhtaClient\s*\}[^;]*;/,
    CLIENT_STUB('__upOfficesHook'),
  ],
  [/import\s*\{\s*mapUkrposhtaFailure\s*\}[^;]*;/, `const mapUkrposhtaFailure = (await import('${mod('app/lib/delivery/ukrposhta/map-failure.ts')}')).mapUkrposhtaFailure;`],
  [/import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/delivery\/ukrposhta\/offices';/, `const { parseOfficesQuery, findOfficesByCityId } = await import('${mod('app/lib/delivery/ukrposhta/offices.ts')}');`],
];

test('OFFICES route: success proxies cityId → poCityId; ONLY normalized active offices', async () => {
  const hook = hookOf('__upOfficesHook');
  hook.calls = [];
  hook.result = {
    Entries: {
      Entry: [
        { ID: '2700', PO_SHORT: 'Київ 1', POSTINDEX: '01001', POLOCK_UA: 'Активний запис' },
        // non-active records are structurally impossible in the response
        { ID: '999999', PO_SHORT: 'ЗАЧИНЕНО', POLOCK_UA: 'Запис видалено' },
        { junk: true },
      ],
    },
  };
  const { GET } = await loadRoute(
    'app/api/delivery/ukrposhta/offices/route.ts',
    OFFICES_MAP
  );
  const res = await GET!(req('/api/delivery/ukrposhta/offices?cityId=14288'));
  assert.equal(res.status, 200);
  assert.equal(hook.calls.length, 1);
  assert.equal(hook.calls[0]!.path, 'get_postoffices_by_postindex');
  assert.equal(hook.calls[0]!.params!.get('poCityId'), '14288');
  const data = (await res.json()) as { items: { id: number }[] };
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0]!.id, 2700);
});

test('OFFICES route: 400 on bad cityId with NO provider call', async () => {
  const hook = hookOf('__upOfficesHook');
  hook.calls = [];
  const { GET } = await loadRoute(
    'app/api/delivery/ukrposhta/offices/route.ts',
    OFFICES_MAP
  );
  for (const bad of ['abc', '0', '1e2', '']) {
    const res = await GET!(
      req(`/api/delivery/ukrposhta/offices?cityId=${encodeURIComponent(bad)}`)
    );
    assert.equal(res.status, 400, bad);
  }
  assert.equal(hook.calls.length, 0);
});

// ------------------------------------------------------------------
// POST /api/delivery/ukrposhta/delivery-cost — fail-closed
// ------------------------------------------------------------------

const COST_MAP = (senderPostIndex: string | null): [RegExp, string][] => [
  [
    /import\s*\{\s*getUkrposhtaClient\s*\}[^;]*;/,
    CLIENT_STUB('__upCostHook'),
  ],
  [
    /import\s*\{\s*mapUkrposhtaFailure\s*\}[^;]*;/,
    `const mapUkrposhtaFailure = (await import('${mod('app/lib/delivery/ukrposhta/map-failure.ts')}')).mapUkrposhtaFailure;`,
  ],
  [
    /import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/delivery\/ukrposhta\/delivery-cost';/,
    `const { parseDeliveryCostBody, calculateDeliveryCost } = await import('${mod('app/lib/delivery/ukrposhta/delivery-cost.ts')}');`,
  ],
  [
    /import\s*\{\s*readUkrposhtaSenderPostIndex\s*\}[^;]*;/,
    `const readUkrposhtaSenderPostIndex = (): string | null => ${JSON.stringify(senderPostIndex)};`,
  ],
];

const COST_BODY = JSON.stringify({
  recipientPostIndex: '79000',
  weightGrams: 1500,
  declaredPriceUah: 100,
});

test('COST route: fail-closed 503 when the sender post index is NOT configured', async () => {
  const hook = hookOf('__upCostHook');
  hook.calls = [];
  const { POST } = await loadRoute(
    'app/api/delivery/ukrposhta/delivery-cost/route.ts',
    COST_MAP(null)
  );
  const res = await POST!(
    req('/api/delivery/ukrposhta/delivery-cost', {
      method: 'POST',
      body: COST_BODY,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  assert.equal(res.status, 503);
  assert.equal(hook.calls.length, 0, 'no provider call may happen');
  const data = (await res.json()) as { error?: string };
  assert.ok(data.error && data.error.length > 0);
});

test('COST route: fail-closed 503 (not_configured) when the client has no bearer', async () => {
  const hook = hookOf('__upCostHook');
  hook.calls = [];
  hook.throw = new UkrposhtaError(
    'not_configured',
    'ukrposhta ecom bearer is not configured'
  );
  const { POST } = await loadRoute(
    'app/api/delivery/ukrposhta/delivery-cost/route.ts',
    COST_MAP('50000')
  );
  const res = await POST!(
    req('/api/delivery/ukrposhta/delivery-cost', {
      method: 'POST',
      body: COST_BODY,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  assert.equal(res.status, 503);
  const data = (await res.json()) as { error?: string };
  assert.ok(data.error && !/bearer/i.test(data.error));
});

test('COST route: 400 on an invalid body with NO provider call', async () => {
  const hook = hookOf('__upCostHook');
  hook.calls = [];
  const { POST } = await loadRoute(
    'app/api/delivery/ukrposhta/delivery-cost/route.ts',
    COST_MAP('50000')
  );
  const res = await POST!(
    req('/api/delivery/ukrposhta/delivery-cost', {
      method: 'POST',
      body: JSON.stringify({ recipientPostIndex: 'bad', weightGrams: 1 }),
      headers: { 'Content-Type': 'application/json' },
    })
  );
  assert.equal(res.status, 400);
  assert.equal(hook.calls.length, 0);
});

test('COST route: success path returns the normalized quote', async () => {
  const hook = hookOf('__upCostHook');
  hook.calls = [];
  hook.throw = undefined;
  hook.result = { deliveryPrice: 78, rawDeliveryPrice: null, calculationDescription: null };
  const { POST } = await loadRoute(
    'app/api/delivery/ukrposhta/delivery-cost/route.ts',
    COST_MAP('50000')
  );
  const res = await POST!(
    req('/api/delivery/ukrposhta/delivery-cost', {
      method: 'POST',
      body: COST_BODY,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(hook.calls.length, 1);
  assert.equal(hook.calls[0]!.path, 'domestic/delivery-price');
  const data = (await res.json()) as { quote: { deliveryPriceUah: number } };
  assert.equal(data.quote.deliveryPriceUah, 78);
});
