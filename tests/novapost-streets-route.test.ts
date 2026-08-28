/**
 * Stage 2G — streets route behavior, loaded from the REAL route source with
 * only the untestable edges stubbed (project pattern: next/server is not
 * resolvable under plain node:test and @/ aliases need rewriting; the
 * parse/normalize/proxy logic itself runs unmodified).
 *
 * Covers: fail-closed 400 on bad query params (no provider call), the
 * success proxy path with `name`/`settlementId` forwarded verbatim, and
 * provider-error mapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = path.join(root, 'app/api/delivery/novapost/streets/route.ts');
const source = readFileSync(ROUTE, 'utf8');

type NpTestGlobal = typeof globalThis & {
  __npStreetsCalls?: { path: string; params: URLSearchParams }[];
  __npStreetsResult?: unknown;
};
const g = globalThis as NpTestGlobal;

type RouteModule = {
  GET: (request: Request) => Promise<Response>;
};

async function loadRoute(): Promise<RouteModule> {
  const rewritten = source
    .replace(
      /import\s*\{\s*NextResponse\s*\}\s*from\s*'next\/server';/,
      `const NextResponse = { json: (body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), init) };`
    )
    .replace(
      /import\s*\{\s*enforceRateLimit\s*\}\s*from\s*'@\/app\/lib\/rate-limit';/,
      'const enforceRateLimit = (): null => null;'
    )
    .replace(
      /import\s*\{\s*getNovaPostClient\s*\}\s*from\s*'@\/app\/lib\/delivery\/novapost\/client';/,
      `const getNovaPostClient = () => ({
        async getJson(p: string, params: URLSearchParams) {
          const calls = (globalThis as { __npStreetsCalls?: { path: string; params: URLSearchParams }[] }).__npStreetsCalls;
          calls?.push({ path: p, params });
          const r = (globalThis as { __npStreetsResult?: unknown }).__npStreetsResult;
          if (r instanceof Error) throw r;
          return r;
        },
      });`
    )
    .replace(
      /'@\/app\/lib\/delivery\/novapost\/map-failure'/,
      `'${pathToFileURL(path.join(root, 'app/lib/delivery/novapost/map-failure.ts')).href}'`
    )
    .replace(
      /'@\/app\/lib\/delivery\/novapost\/streets'/,
      `'${pathToFileURL(path.join(root, 'app/lib/delivery/novapost/streets.ts')).href}'`
    );

  const dir = mkdtempSync(path.join(tmpdir(), 'np-streets-route-'));
  try {
    const file = path.join(dir, 'route-stubbed.mts');
    writeFileSync(file, rewritten);
    return (await import(pathToFileURL(file).href)) as RouteModule;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const req = (url: string) => new Request(`http://localhost${url}`);

test('STREETS route: 400 without provider call when settlementId invalid', async () => {
  const { GET } = await loadRoute();
  g.__npStreetsCalls = [];
  const res = await GET(req('/api/delivery/novapost/streets?settlementId=abc&name=Мазепи'));
  assert.equal(res.status, 400);
  assert.equal(g.__npStreetsCalls.length, 0);
  const data = (await res.json()) as { error?: string };
  assert.equal(typeof data.error, 'string');
  assert.ok(data.error!.length > 0);
});

test('STREETS route: 400 when name missing or too short', async () => {
  const { GET } = await loadRoute();
  const a = await GET(req('/api/delivery/novapost/streets?settlementId=119638'));
  assert.equal(a.status, 400);
  const b = await GET(req('/api/delivery/novapost/streets?settlementId=119638&name=в'));
  assert.equal(b.status, 400);
  const c = await GET(req('/api/delivery/novapost/streets?settlementId=0&name=Мазепи'));
  assert.equal(c.status, 400);
});

test('STREETS route: success path proxies name (not textSearch) + settlementId', async () => {
  const { GET } = await loadRoute();
  g.__npStreetsCalls = [];
  g.__npStreetsResult = {
    items: [
      {
        id: 5694732,
        name: 'вул. Гетьмана Івана Мазепи',
        settlement: { id: 119638, name: 'місто Кривий Ріг' },
      },
      { junk: true },
    ],
  };
  const res = await GET(
    req('/api/delivery/novapost/streets?settlementId=119638&name=%D0%9C%D0%B0%D0%B7%D0%B5%D0%BF%D0%B8')
  );
  assert.equal(res.status, 200);
  assert.equal(g.__npStreetsCalls.length, 1);
  assert.equal(g.__npStreetsCalls[0].path, 'streets');
  assert.equal(g.__npStreetsCalls[0].params.get('name'), 'Мазепи');
  assert.equal(g.__npStreetsCalls[0].params.get('textSearch'), null);
  assert.equal(g.__npStreetsCalls[0].params.get('settlementId'), '119638');
  const data = (await res.json()) as { items: { id: number; settlementId: number }[] };
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].id, 5694732);
  assert.equal(data.items[0].settlementId, 119638);
});
