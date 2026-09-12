/**
 * «Повідомити про наявність» (restock requests, v1 = owner Telegram digest).
 *
 * Covers the four moving parts end to end:
 *   1. migration 042 — service-role-only table: RLS enabled, SELECT/INSERT
 *      revoked from anon/authenticated (041/014 pattern), UNIQUE
 *      (product_id, email) for idempotent dedup, partial index on
 *      notified_at WHERE notified_at IS NULL, VERIFY-PRE/POST header;
 *   2. POST /api/products/restock-notify — anti-enumeration contract: the
 *      malformed-email 400 is the ONLY content error; a non-uuid product id,
 *      an unknown product, an in-stock product and a duplicate (product_id,
 *      email) ALL answer the same generic `200 { ok: true }`, and only the
 *      out-of-stock case writes; rate limit 5/10min per IP (REAL limiter
 *      source); service-role INSERT with ON CONFLICT DO NOTHING; no
 *      internals in any response;
 *   3. RestockNotify client component — «Повідомити про наявність» form,
 *      success state «Готово! Повідомимо, коли з'явиться», inline errors,
 *      never-stuck bounded fetch (AbortController + timeout, always settles),
 *      motion-reduce; PDP mounts it ONLY under the server-side OOS gate;
 *   4. the wallpaper-import hook — after a successful --run ONLY: pending
 *      restock_requests for products that NOW have stock (stock_quantity > 0
 *      AND is_active) → one sendTelegramText digest
 *      «Надійшли товари (N): sku — назва (запитів: X, emails: …)» →
 *      notified_at stamped ONLY after a confirmed send; 0 requests →
 *      telegram not called; a telegram/DB failure NEVER fails the import.
 *
 * Runtime coverage follows the project harness pattern (real route/script
 * source with only the untestable edges stubbed — next/server and @/ aliases
 * are not resolvable under plain node:test; see tests/wallpaper-ingest.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const stripComments = (sql: string): string => sql.replace(/^\s*--.*$/gm, '');
const stripJsComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const MIGRATION = 'database/migrations/042_restock_requests.sql';
const ROUTE = 'app/api/products/restock-notify/route.ts';
const COMPONENT = 'app/components/RestockNotify.tsx';
const PDP = 'app/product/[slug]/page.tsx';
const CLI = 'scripts/wallpaper-import.ts';

// ---------------------------------------------------------------------------
// 1. Migration 042 — static invariants
// ---------------------------------------------------------------------------

test('MIGRATION 042: file exists (next number after 041)', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(files.includes('042_restock_requests.sql'));
});

test('MIGRATION 042: creates restock_requests with the contracted column set', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /create\s+table\s+if\s+not\s+exists\s+(public\.)?restock_requests/i
  );
  assert.match(
    body,
    /\bid\s+uuid\s+default\s+gen_random_uuid\(\)\s+primary\s+key/i,
    'id uuid pk default gen_random_uuid()'
  );
  assert.match(
    body,
    /product_id\s+uuid\s+not\s+null\s+references\s+products\(id\)/i,
    'product_id uuid not null references products(id)'
  );
  assert.match(body, /email\s+text\s+not\s+null/i, 'email TEXT (not citext)');
  assert.match(
    body,
    /created_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i
  );
  assert.match(body, /notified_at\s+timestamptz/i);
});

test('MIGRATION 042: UNIQUE (product_id, email) — duplicate requests are a no-op', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /unique\s*\(\s*product_id\s*,\s*email\s*\)/i,
    'UNIQUE (product_id, email) required for ON CONFLICT DO NOTHING'
  );
});

test('MIGRATION 042: RLS enabled, no policies, SELECT+INSERT revoked from anon/authenticated', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /alter\s+table\s+(public\.)?restock_requests\s+enable\s+row\s+level\s+security/i,
    'RLS must be enabled'
  );
  assert.doesNotMatch(body, /create\s+policy/i, 'no policies — service role only');
  assert.match(
    body,
    /revoke\s+select\s*,\s*insert\s+on\s+(table\s+)?(public\.)?restock_requests\s+from\s+anon,\s*authenticated/i,
    'SELECT and INSERT must be revoked from anon, authenticated'
  );
});

test('MIGRATION 042: partial index on notified_at WHERE notified_at IS NULL', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /create\s+index\s+if\s+not\s+exists\s+idx_restock_requests_pending/i
  );
  assert.match(
    body,
    /on\s+(public\.)?restock_requests\s*\(\s*notified_at\s*\)\s*where\s+notified_at\s+is\s+null/i
  );
});

test('MIGRATION 042: DDL-only + VERIFY-PRE/POST header for the orchestrator', () => {
  const body = stripComments(src(MIGRATION));
  assert.doesNotMatch(body, /insert\s+into|update\s+\w+\s+set|delete\s+from/i);
  assert.doesNotMatch(body, /drop\s+(table|column|index)|truncate\b/i);
  const full = src(MIGRATION);
  assert.match(full, /VERIFY-PRE/);
  assert.match(full, /VERIFY-POST/);
  assert.match(full, /42501/, 'VERIFY-POST must pin the anon permission-denied probe');
});

// ---------------------------------------------------------------------------
// 2. API route — static invariants
// ---------------------------------------------------------------------------

const routeCode = stripJsComments(src(ROUTE));

test('ROUTE: POST-only public endpoint, service-role client (no session)', () => {
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(
    routeCode,
    /export\s+(?:async\s+)?function\s+(GET|PUT|PATCH|DELETE)\b/,
    'App Router answers 405 for everything else; no read surface'
  );
  assert.match(routeCode, /from '@supabase\/supabase-js'/);
  assert.match(routeCode, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(routeCode, /persistSession: false/);
});

test('ROUTE: rate limit 5/10min per IP via the named restockNotify rule', () => {
  assert.match(routeCode, /enforceRateLimit\(request, 'restockNotify'\)/);
  const rl = stripJsComments(src('app/lib/rate-limit.ts'));
  assert.match(
    rl,
    /restockNotify:\s*\[\s*\{\s*max:\s*5,\s*windowMs:\s*10 \* 60_000\s*\}\s*\]/
  );
});

test('ROUTE: anti-enumeration — one generic 200, OOS-only insert, no internals', () => {
  // Email is the only 400; uuid/OOS/duplicates answer the same ok:true.
  assert.match(routeCode, /Некоректний email/);
  assert.match(routeCode, /status: 400/);
  assert.ok(
    (routeCode.match(/\{ ok: true \}/g) ?? []).length >= 3,
    'generic 200 must cover non-uuid / unknown-or-not-OOS / success'
  );
  assert.match(
    routeCode,
    /availability_status\s*!==\s*'out_of_stock'/,
    'write ONLY when availability_status is out_of_stock'
  );
  // Insert restricted to the OOS branch: read happens first, insert after.
  const insertIdx = routeCode.indexOf(".from('restock_requests')");
  const oosIdx = routeCode.indexOf("availability_status !== 'out_of_stock'");
  assert.ok(oosIdx !== -1 && insertIdx > oosIdx, 'insert must follow the OOS check');
  // Duplicate collapse through ON CONFLICT DO NOTHING (upsert+ignore).
  assert.match(routeCode, /\.upsert\(/);
  assert.match(routeCode, /ignoreDuplicates: true/);
  assert.match(routeCode, /onConflict: 'product_id,email'/);
  // No raw DB error text can reach a response body.
  assert.doesNotMatch(routeCode, /error\.message/);
  assert.match(routeCode, /Не вдалося зберегти запит/);
  assert.match(routeCode, /status: 500/);
});

// ---------------------------------------------------------------------------
// 3. UI component + PDP gate — static invariants
// ---------------------------------------------------------------------------

const componentCode = src(COMPONENT);

test('COMPONENT: client form with the contracted strings and inline errors', () => {
  assert.match(componentCode, /'use client'/);
  assert.match(componentCode, /Повідомити про наявність/);
  assert.match(componentCode, /Готово! Повідомимо, коли з/);
  assert.match(componentCode, /RESTOCK_TIMEOUT_MS = 12_000/, 'bounded fetch budget');
  assert.match(componentCode, /role="alert"/, 'errors inline');
  assert.match(componentCode, /role="status"/, 'success is announced');
  assert.match(componentCode, /motion-reduce:transition-none/);
  assert.match(componentCode, /type="email"/);
});

test('COMPONENT: never-stuck — every submit settles (abort timer + finally + catch)', () => {
  assert.match(componentCode, /new AbortController\(\)/);
  assert.match(componentCode, /setTimeout\(\(\) => controller\.abort\(\), RESTOCK_TIMEOUT_MS\)/);
  assert.match(componentCode, /finally\s*\{[\s\S]*?clearTimeout\(timer\)/);
  assert.match(componentCode, /\} catch \{/, 'network/abort path resolves, never throws');
  assert.match(componentCode, /res\.json\(\)\.catch\(\(\) => null\)/, 'body parse cannot hang the flow');
  assert.doesNotMatch(componentCode, /window\.|document\./, 'no direct DOM');
});

test('PDP: RestockNotify mounted ONLY under the server-side OOS gate', () => {
  const page = src(PDP);
  assert.match(page, /import RestockNotify from '@\/app\/components\/RestockNotify'/);
  assert.match(
    page,
    /product\.availability_status === 'out_of_stock' && \(\s*<RestockNotify productId=\{product\.id\} \/>\s*\)/
  );
  assert.equal(
    (page.match(/<RestockNotify/g) ?? []).length,
    1,
    'exactly one mount site'
  );
});

// ---------------------------------------------------------------------------
// 4. Import hook — static invariants
// ---------------------------------------------------------------------------

const cliCode = stripJsComments(src(CLI));

test('HOOK: notifyRestockRequests is called exactly once, in the run branch after applyPlan', () => {
  const applyIdx = cliCode.indexOf('await applyPlan(');
  const hookIdx = cliCode.indexOf('await notifyRestockRequests(client)');
  assert.ok(applyIdx !== -1 && hookIdx !== -1);
  assert.ok(hookIdx > applyIdx, 'hook runs after a successful applyPlan');
  assert.equal((cliCode.match(/await notifyRestockRequests\(/g) ?? []).length, 1);
  // --plan branch sits between its check and applyPlan and must not reach the hook.
  const planBranch = cliCode.slice(cliCode.indexOf("args.mode === 'plan'"), applyIdx);
  assert.doesNotMatch(planBranch, /notifyRestockRequests/);
  // --publish returns BEFORE any sync logic.
  const publishBranch = cliCode.slice(
    cliCode.indexOf("args.mode === 'publish'"),
    cliCode.indexOf('const rawStaging = await readStagingRaw')
  );
  assert.match(publishBranch, /return 0;/, 'publish branch returns before sync + hook');
  assert.doesNotMatch(publishBranch, /notifyRestockRequests/);
});

test('HOOK: reads pending requests paged (notified_at IS NULL) and never writes products', () => {
  assert.match(cliCode, /\.from\('restock_requests'\)/);
  assert.match(cliCode, /\.is\('notified_at', null\)/);
  // The whole restock section (pure helpers + executor), defined AFTER the
  // publish executor and before the direct-run guard.
  const hook = cliCode.slice(cliCode.indexOf('export interface RestockRequestRow'));
  assert.match(hook, /\.order\('id'\)/, 'paged read needs the stable tiebreaker');
  assert.match(hook, /chunkRows\(/, '.in() windows stay ≤200');
  assert.doesNotMatch(hook, /\.delete\(|\.rpc\(|\.upsert\(/);
  assert.doesNotMatch(
    hook,
    /from\('products'\)\s*\.update/,
    'the hook must never write products (only restock_requests.notified_at)'
  );
  assert.match(hook, /from\('restock_requests'\)\s*\.update/);
  assert.match(hook, /stockQuantity > 0/, 'only products that actually got stock');
  assert.match(hook, /!product\.isActive/, 'only storefront-visible (active) products');
});

test('HOOK: telegram via sendTelegramText, digest carries emails, failure never fails the import', () => {
  assert.match(
    cliCode,
    /import\s*\{[^}]*sendTelegramText[^}]*\}\s*from\s*'\.\.\/app\/lib\/notifications\/telegram\.ts'/
  );
  assert.match(cliCode, /Надійшли товари \(/);
  assert.match(cliCode, /запитів: /);
  assert.match(cliCode, /emails: /);
  // notified_at is stamped ONLY after a confirmed send.
  const hook = cliCode.slice(cliCode.indexOf('export async function notifyRestockRequests'));
  const sentIdx = hook.indexOf('!result.sent');
  const updateIdx = hook.indexOf('.update({ notified_at:');
  assert.ok(sentIdx !== -1 && updateIdx !== -1 && updateIdx > sentIdx);
  // Whole hook wrapped: any throw resolves as ok:false, the run exits 0.
  assert.match(hook, /\} catch \(error\) \{/);
  assert.match(hook, /ok: false/);
});

// ---------------------------------------------------------------------------
// Runtime harness: real route source, stubbed supabase + REAL rate limiter
// ---------------------------------------------------------------------------

interface RouteTestGlobal {
  __restockClientCalls?: unknown[][];
  __restockTables?: string[];
  __restockInserts?: { payload: unknown; options: unknown }[];
  __restockInsertError?: { message: string } | null;
  __restockProductReadError?: { message: string } | null;
  __restockProducts?: Record<string, { availability_status: string }>;
  __restockQueriedProductId?: unknown;
  __restockClientThrow?: boolean;
}
const g = globalThis as RouteTestGlobal;

function resetRouteFakes() {
  g.__restockClientCalls = [];
  g.__restockTables = [];
  g.__restockInserts = [];
  g.__restockInsertError = null;
  g.__restockProductReadError = null;
  g.__restockProducts = {};
  g.__restockQueriedProductId = undefined;
  g.__restockClientThrow = false;
}

interface RouteModule {
  POST: (request: Request) => Promise<Response>;
  isRestockUuid: (value: unknown) => value is string;
  isValidRestockEmail: (value: string) => boolean;
}

/**
 * Loads the REAL route with only @supabase/supabase-js and @/app/lib/
 * rate-limit stubbed. The limiter is the REAL app/lib/rate-limit.ts source
 * with its next/server import shimmed, so the 5/10min window is the
 * production one (fresh module instance per loadRoute → fresh buckets).
 */
async function loadRoute(): Promise<RouteModule> {
  const rlShim = `const NextResponse = { json: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), init) };`;
  const rlUrl = pathToFileURL(path.join(root, 'app/lib/rate-limit.ts')).href;
  const rlLoader = `
const rlFs = await import('node:fs');
const rlOs = await import('node:os');
const rlUrlMod = await import('node:url');
const rlSource = rlFs.readFileSync(rlUrlMod.fileURLToPath('${rlUrl}'), 'utf8').replace(
  /import\\s*\\{\\s*NextResponse\\s*\\}\\s*from\\s*'next\\/server';/,
  ${JSON.stringify(rlShim)}
);
const rlDir = rlFs.mkdtempSync(rlOs.tmpdir() + '/restock-rl-');
const rlFile = rlDir + '/rate-limit.mts';
rlFs.writeFileSync(rlFile, rlSource);
const { enforceRateLimit } = await import(rlUrlMod.pathToFileURL(rlFile).href);
`;
  const rewritten = src(ROUTE)
    .replace(
      /import\s*\{\s*enforceRateLimit\s*\}\s*from\s*'@\/app\/lib\/rate-limit';/,
      rlLoader
    )
    .replace(
      /import\s*\{\s*assertSameOrigin\s*\}\s*from\s*'@\/app\/lib\/request-origin';/,
      // Tests post without an Origin header — the real gate admits that
      // (see tests/csrf-origin.test.ts for the gate's own coverage).
      'const assertSameOrigin = (_request: unknown): boolean => true;'
    )
    .replace(
      /import\s*\{\s*createClient\s*\}\s*from\s*'@supabase\/supabase-js';/,
      `const createClient = (...args: unknown[]) => {
        const gg = globalThis as RouteTestGlobal;
        (gg.__restockClientCalls = gg.__restockClientCalls ?? []).push(args);
        if (gg.__restockClientThrow) throw new Error('client init failed');
        return {
          from(table: string) {
            (gg.__restockTables = gg.__restockTables ?? []).push(table);
            return {
              select(_cols: string) {
                return {
                  eq(_col: string, value: unknown) {
                    (gg.__restockQueriedProductId = value);
                    return {
                      async maybeSingle() {
                        const pid = gg.__restockQueriedProductId as string;
                        if (gg.__restockProductReadError) {
                          return { data: null, error: gg.__restockProductReadError };
                        }
                        const row = pid ? (gg.__restockProducts ?? {})[pid] : undefined;
                        return { data: row ?? null, error: null };
                      },
                    };
                  },
                };
              },
              upsert(payload: unknown, options: unknown) {
                (gg.__restockInserts = gg.__restockInserts ?? []).push({ payload, options });
                const err = gg.__restockInsertError;
                return Promise.resolve(err ? { error: err } : { error: null });
              },
            };
          },
        };
      };`
    );

  assert.ok(!rewritten.includes("'@supabase/supabase-js'"), 'harness drift: supabase not stubbed');
  assert.ok(!rewritten.includes("'@/app/lib/"), 'harness drift: @/ alias not stubbed');
  const dir = mkdtempSync(path.join(tmpdir(), 'restock-route-'));
  try {
    const file = path.join(dir, 'route-stubbed.mts');
    writeFileSync(file, rewritten);
    return (await import(pathToFileURL(file).href)) as RouteModule;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

function postRequest(body: unknown, ip = '203.0.113.10'): Request {
  return new Request('https://example.com/api/products/restock-notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

test('ROUTE: isRestockUuid / isValidRestockEmail (pure validators)', async () => {
  const { isRestockUuid, isValidRestockEmail } = await loadRoute();
  assert.equal(isRestockUuid(UUID_A), true);
  assert.equal(isRestockUuid(UUID_A.toUpperCase()), true, 'case-insensitive uuid');
  assert.equal(isRestockUuid('not-a-uuid'), false);
  assert.equal(isRestockUuid(42), false);
  assert.equal(isRestockUuid(null), false);
  assert.equal(isValidRestockEmail('a@b.co'), true);
  assert.equal(isValidRestockEmail('USER+tag@Example.COM'), true);
  assert.equal(isValidRestockEmail('no-at-mark'), false);
  assert.equal(isValidRestockEmail('a b@c.d'), false);
  assert.equal(isValidRestockEmail('a@b'), false);
  assert.equal(isValidRestockEmail(''), false);
  assert.equal(isValidRestockEmail(`${'x'.repeat(250)}@x.co`), false, 'over 254 chars rejected');
});

test('ROUTE: valid OOS product → 200 {ok:true}, insert with normalized email + ON CONFLICT', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__restockProducts = { [UUID_A]: { availability_status: 'out_of_stock' } };
  const res = await POST(postRequest({ productId: UUID_A, email: '  Buyer@Example.COM ' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonBody(res), { ok: true });
  // service-role client, no session persistence
  assert.equal(g.__restockClientCalls!.length, 1);
  assert.deepEqual(g.__restockClientCalls![0]![2], { auth: { persistSession: false } });
  assert.deepEqual(g.__restockTables, ['products', 'restock_requests']);
  const insert = g.__restockInserts![0]!;
  assert.deepEqual(insert.payload, { product_id: UUID_A, email: 'buyer@example.com' });
  assert.deepEqual(insert.options, { onConflict: 'product_id,email', ignoreDuplicates: true });
});

test('ROUTE: duplicate (product_id, email) → same generic 200 (ON CONFLICT DO NOTHING)', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__restockProducts = { [UUID_A]: { availability_status: 'out_of_stock' } };
  const res = await POST(
    postRequest({ productId: UUID_A, email: 'buyer@example.com' }, '203.0.113.21')
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonBody(res), { ok: true });
  assert.equal(g.__restockInserts!.length, 1, 'collapse is DB-side; the route still answers success');
});

test('ROUTE: malformed email → 400 «Некоректний email», ZERO DB activity', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  const cases: unknown[] = ['not-an-email', '', '   ', 'a@b', 42, null, undefined];
  let n = 0;
  for (const email of cases) {
    const res = await POST(
      postRequest({ productId: UUID_A, email: email as unknown as string }, `203.0.113.30.${n++}`)
    );
    assert.equal(res.status, 400, `expected 400 for email=${String(email)}`);
    const json = await jsonBody(res);
    assert.deepEqual(Object.keys(json), ['error']);
    assert.equal(json.error, 'Некоректний email');
  }
  // Broken JSON body → same 400 (no valid email inside).
  const broken = await POST(postRequest('{not json', '203.0.113.31'));
  assert.equal(broken.status, 400);
  assert.equal(g.__restockClientCalls!.length, 0, 'email validation is DB-free');
  assert.equal(g.__restockInserts!.length, 0);
});

test('ROUTE: non-uuid productId → generic 200 {ok:true}, no read, no insert (no oracle)', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  const res = await POST(postRequest({ productId: 'garbage', email: 'a@b.co' }, '203.0.113.40'));
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonBody(res), { ok: true });
  assert.equal(g.__restockClientCalls!.length, 0);
  assert.equal(g.__restockInserts!.length, 0);
});

test('ROUTE: unknown product id → generic 200 {ok:true}, no insert', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__restockProducts = {}; // no such product
  const res = await POST(postRequest({ productId: UUID_A, email: 'a@b.co' }, '203.0.113.41'));
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonBody(res), { ok: true });
  assert.deepEqual(g.__restockTables, ['products']);
  assert.equal(g.__restockInserts!.length, 0);
});

test('ROUTE: in-stock (not OOS) product → generic 200 {ok:true}, NO insert (no oracle, no junk rows)', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  let n = 0;
  for (const status of ['in_stock', 'limited_availability']) {
    g.__restockProducts = { [UUID_B]: { availability_status: status } };
    const res = await POST(
      postRequest({ productId: UUID_B, email: 'a@b.co' }, `203.0.113.50.${n++}`)
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await jsonBody(res), { ok: true });
    assert.equal(g.__restockInserts!.length, 0, `${status} must not be recorded`);
  }
  // The 200 for in-stock is byte-identical to the success 200 (one contract).
  g.__restockProducts = { [UUID_B]: { availability_status: 'in_stock' } };
  const inStock = await POST(
    postRequest({ productId: UUID_B, email: 'a@b.co' }, '203.0.113.51')
  );
  g.__restockProducts = { [UUID_A]: { availability_status: 'out_of_stock' } };
  const success = await POST(
    postRequest({ productId: UUID_A, email: 'a@b.co' }, '203.0.113.52')
  );
  assert.equal(await inStock.text(), await success.text());
});

test('ROUTE: DB read/insert failures → 500 generic, no internals leaked', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__restockProducts = { [UUID_A]: { availability_status: 'out_of_stock' } };
  g.__restockProductReadError = { message: 'permission denied for table products' };
  let res = await POST(postRequest({ productId: UUID_A, email: 'a@b.co' }, '203.0.113.60'));
  assert.equal(res.status, 500);
  let json = await jsonBody(res);
  assert.equal(json.error, 'Не вдалося зберегти запит. Спробуйте пізніше.');
  assert.ok(!JSON.stringify(json).includes('permission denied'));

  resetRouteFakes();
  g.__restockProducts = { [UUID_A]: { availability_status: 'out_of_stock' } };
  g.__restockInsertError = { message: 'duplicate key value violates unique constraint "boom"' };
  res = await POST(postRequest({ productId: UUID_A, email: 'a@b.co' }, '203.0.113.61'));
  assert.equal(res.status, 500);
  json = await jsonBody(res);
  assert.ok(!JSON.stringify(json).includes('duplicate key'), 'DB internals must not leak');

  resetRouteFakes();
  g.__restockClientThrow = true;
  res = await POST(postRequest({ productId: UUID_A, email: 'a@b.co' }, '203.0.113.62'));
  assert.equal(res.status, 500);
});

test('ROUTE: rate limit — 5 accepted per IP per 10 min, 6th → 429 with Retry-After', async () => {
  const { POST } = await loadRoute();
  resetRouteFakes();
  g.__restockProducts = { [UUID_A]: { availability_status: 'out_of_stock' } };
  const ip = '198.51.100.77';
  for (let i = 0; i < 5; i++) {
    const res = await POST(postRequest({ productId: UUID_A, email: `u${i}@b.co` }, ip));
    assert.equal(res.status, 200, `request ${i + 1} must pass`);
  }
  const sixth = await POST(postRequest({ productId: UUID_A, email: 'u6@b.co' }, ip));
  assert.equal(sixth.status, 429);
  assert.ok(sixth.headers.get('retry-after') !== null);
  assert.equal(g.__restockInserts!.length, 5);
  // Another IP is unaffected.
  const other = await POST(
    postRequest({ productId: UUID_A, email: 'other@b.co' }, '198.51.100.78')
  );
  assert.equal(other.status, 200);
});

// ---------------------------------------------------------------------------
// Runtime harness: import hook on a stub client + spy sendTelegramText
// ---------------------------------------------------------------------------

import {
  buildRestockEntries,
  buildRestockMessage,
  notifyRestockRequests,
  RESTOCK_MAX_EMAILS_PER_PRODUCT,
  RESTOCK_MAX_PRODUCTS,
  type RestockRequestRow,
  type RestockProductRow,
  type RestockDigestEntry,
} from '../scripts/wallpaper-import.ts';
import type { TelegramSendResult } from '../app/lib/notifications/telegram.ts';

interface HookStubState {
  restockRows: RestockRequestRow[];
  productRows: Record<
    string,
    { sku: string; name: string; stock_quantity: number; is_active: boolean }
  >;
  readError: { message: string } | null;
  updateError: { message: string } | null;
  updatedIdGroups: string[][];
  updatedValues: unknown[];
  productInSizes: number[];
}

function stubClient(state: HookStubState): Parameters<typeof notifyRestockRequests>[0] {
  return {
    from(table: string) {
      if (table === 'restock_requests') {
        return {
          select() {
            return {
              is() {
                return {
                  order() {
                    return {
                      range(from: number) {
                        const page = state.readError
                          ? Promise.reject(new Error(state.readError.message))
                          : Promise.resolve({
                              data: state.restockRows.slice(from, from + 1000),
                              error: null,
                            });
                        return { returns: () => page };
                      },
                    };
                  },
                };
              },
            };
          },
          update(values: unknown) {
            state.updatedValues.push(values);
            return {
              in(_col: string, ids: string[]) {
                if (state.updateError) {
                  return Promise.resolve({ error: state.updateError });
                }
                state.updatedIdGroups.push([...ids]);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      // products: .select(...).in('id', group).returns()
      return {
        select() {
          return {
            in(...inArgs: [string, string[]]) {
              const ids = inArgs[1];
              state.productInSizes.push(ids.length);
              const data = ids
                .filter((id) => state.productRows[id] !== undefined)
                .map((id) => ({ id, ...state.productRows[id] }));
              return {
                returns: () => Promise.resolve({ data, error: null }),
              };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof notifyRestockRequests>[0];
}

function spySend(
  outcomes: TelegramSendResult[],
  texts: string[] = []
): (text: string) => Promise<TelegramSendResult> {
  return async (text: string) => {
    texts.push(text);
    const next = outcomes.shift();
    if (next === undefined) throw new Error('spy exhausted');
    return next;
  };
}

const REQ = (id: string, productId: string, email: string): RestockRequestRow => ({
  id,
  product_id: productId,
  email,
});
const PROD = (over: Partial<RestockProductRow> & { id: string }): RestockProductRow => ({
  sku: 'wc-x6647-04',
  name: 'Шпалери 6647-04',
  stockQuantity: 5,
  isActive: true,
  ...over,
});

function freshState(): HookStubState {
  return {
    restockRows: [],
    productRows: {},
    readError: null,
    updateError: null,
    updatedIdGroups: [],
    updatedValues: [],
    productInSizes: [],
  };
}

test('HOOK runtime: 0 pending requests → telegram NOT called, nothing updated, ok', async () => {
  const state = freshState();
  const texts: string[] = [];
  const result = await notifyRestockRequests(stubClient(state), spySend([{ sent: true }], texts));
  assert.deepEqual(result, {
    ok: true,
    pendingRequests: 0,
    matchedProducts: 0,
    telegramSent: false,
    markedNotified: 0,
  });
  assert.equal(texts.length, 0, 'telegram must not be called with no requests');
  assert.equal(state.updatedIdGroups.length, 0);
  assert.deepEqual(state.productInSizes, [], 'no product reads either');
});

test('HOOK runtime: digest groups by product, includes emails, stamps notified_at only for issued', async () => {
  const state = freshState();
  state.restockRows = [
    REQ('r1', UUID_A, 'a@b.co'),
    REQ('r2', UUID_A, 'A@B.CO'),
    REQ('r3', UUID_B, 'c@d.co'), // product B has no stock again → skipped
    REQ('r4', '33333333-3333-3333-3333-333333333333', 'e@f.co'), // unknown → skipped
  ];
  state.productRows = {
    [UUID_A]: { sku: 'wc-x6647-04', name: 'Шпалери 6647-04', stock_quantity: 5, is_active: true },
    [UUID_B]: { sku: 'wc-x30202', name: 'Шпалери 30202', stock_quantity: 0, is_active: true },
  };
  const texts: string[] = [];
  const result = await notifyRestockRequests(stubClient(state), spySend([{ sent: true }], texts));
  assert.equal(result.ok, true);
  assert.equal(result.pendingRequests, 4);
  assert.equal(result.matchedProducts, 1);
  assert.equal(result.telegramSent, true);
  assert.equal(result.markedNotified, 2, 'only the two requests of the in-stock product');
  assert.equal(texts.length, 1);
  const message = texts[0]!;
  assert.match(message, /Надійшли товари \(1\):/);
  assert.match(
    message,
    /wc-x6647-04 — Шпалери 6647-04 \(запитів: 2, emails: a@b\.co, A@B\.CO\)/
  );
  assert.doesNotMatch(message, /c@d\.co/, 'still-OOS product must not be announced');
  assert.doesNotMatch(message, /e@f\.co/, 'unknown product must not be announced');
  // .in() windows ≤200 (project invariant)
  assert.ok(state.productInSizes.every((n) => n <= 200));
  assert.deepEqual(state.updatedIdGroups, [['r1', 'r2']]);
  const stamped = state.updatedValues[0] as { notified_at?: unknown } | undefined;
  assert.ok(stamped && typeof stamped.notified_at === 'string');
  assert.ok(!Number.isNaN(Date.parse(stamped.notified_at as string)), 'notified_at is an ISO stamp');
});

test('HOOK runtime: inactive or re-OOS products are skipped (requests stay pending)', async () => {
  const state = freshState();
  state.restockRows = [REQ('r1', UUID_A, 'a@b.co')];
  state.productRows = {
    [UUID_A]: { sku: 'wc-x1', name: 'Шпалери 1', stock_quantity: 7, is_active: false },
  };
  const texts: string[] = [];
  const result = await notifyRestockRequests(stubClient(state), spySend([{ sent: true }], texts));
  assert.deepEqual(result, {
    ok: true,
    pendingRequests: 1,
    matchedProducts: 0,
    telegramSent: false,
    markedNotified: 0,
  });
  assert.equal(texts.length, 0, 'no digest when nothing qualified');
  assert.equal(state.updatedIdGroups.length, 0);
});

test('HOOK runtime: telegram failure (sent:false) → NO notified_at stamp, import unaffected', async () => {
  const state = freshState();
  state.restockRows = [REQ('r1', UUID_A, 'a@b.co')];
  state.productRows = {
    [UUID_A]: { sku: 'wc-x1', name: 'Шпалери 1', stock_quantity: 3, is_active: true },
  };
  const texts: string[] = [];
  const result = await notifyRestockRequests(
    stubClient(state),
    spySend([{ sent: false, reason: 'http_error', detail: 'HTTP 500' }], texts)
  );
  assert.equal(result.ok, true, 'a telegram failure must NOT fail the run');
  assert.equal(result.telegramSent, false);
  assert.equal(result.markedNotified, 0);
  assert.equal(texts.length, 1, 'the send was attempted');
  assert.equal(state.updatedIdGroups.length, 0, 'requests stay pending for the next run');
});

test('HOOK runtime: telegram throw / DB failures resolve as ok:false — never propagate', async () => {
  const throwingSend = async (): Promise<TelegramSendResult> => {
    throw new Error('network unreachable');
  };

  const s1 = freshState();
  s1.restockRows = [REQ('r1', UUID_A, 'a@b.co')];
  s1.productRows = {
    [UUID_A]: { sku: 'wc-x1', name: 'Шпалери 1', stock_quantity: 3, is_active: true },
  };
  const t1 = await notifyRestockRequests(stubClient(s1), throwingSend);
  assert.equal(t1.ok, false);
  assert.equal(t1.markedNotified, 0);

  const s2 = freshState();
  s2.restockRows = [REQ('r1', UUID_A, 'a@b.co')];
  s2.readError = { message: 'relation "restock_requests" does not exist' };
  const t2 = await notifyRestockRequests(stubClient(s2), spySend([{ sent: true }]));
  assert.equal(t2.ok, false, 'migration not applied yet → hook aborts, run unaffected');

  const s3 = freshState();
  s3.restockRows = [REQ('r1', UUID_A, 'a@b.co')];
  s3.productRows = {
    [UUID_A]: { sku: 'wc-x1', name: 'Шпалери 1', stock_quantity: 3, is_active: true },
  };
  s3.updateError = { message: 'boom' };
  const t3 = await notifyRestockRequests(stubClient(s3), spySend([{ sent: true }]));
  assert.equal(t3.ok, false);
});

// ---------------------------------------------------------------------------
// Pure: buildRestockEntries + buildRestockMessage
// ---------------------------------------------------------------------------

test('buildRestockEntries: dedupe emails per product, first-appearance order, OOS/unknown skipped', () => {
  const products = new Map<string, RestockProductRow>([
    ['p2', PROD({ id: 'p2', sku: 's2', name: 'n2', stockQuantity: 0 })],
    ['p3', PROD({ id: 'p3', sku: 's3', name: 'n3', stockQuantity: 1, isActive: false })],
    ['p1', PROD({ id: 'p1', sku: 's1', name: 'n1' })],
  ]);
  const entries = buildRestockEntries(
    [
      REQ('r1', 'p1', 'a@b.co'),
      REQ('r2', 'p2', 'x@y.co'),
      REQ('r3', 'p1', 'a@b.co'), // exact duplicate → one email
      REQ('r4', 'p1', 'd@e.co'),
      REQ('r5', 'p3', 'z@z.co'), // inactive → skipped
      REQ('r6', 'pX', 'q@q.co'), // unknown → skipped
    ],
    products
  );
  assert.deepEqual(entries, [
    { productId: 'p1', sku: 's1', name: 'n1', requestCount: 2, emails: ['a@b.co', 'd@e.co'] },
  ]);
});

test('buildRestockMessage: contracted format, caps, hard cap', () => {
  const one: RestockDigestEntry[] = [
    {
      productId: 'p1',
      sku: 'wc-x6647-04',
      name: 'Шпалери 6647-04, 53см*10м',
      requestCount: 2,
      emails: ['a@b.co', 'd@e.co'],
    },
  ];
  assert.equal(
    buildRestockMessage(one),
    'Надійшли товари (1):\n• wc-x6647-04 — Шпалери 6647-04, 53см*10м (запитів: 2, emails: a@b.co, d@e.co)'
  );

  // >10 emails per product → «+N» collapse.
  const many: RestockDigestEntry[] = [
    {
      productId: 'p1',
      sku: 's1',
      name: 'n1',
      requestCount: RESTOCK_MAX_EMAILS_PER_PRODUCT + 3,
      emails: Array.from(
        { length: RESTOCK_MAX_EMAILS_PER_PRODUCT + 3 },
        (_, i) => `u${i}@b.co`
      ),
    },
  ];
  const msg = buildRestockMessage(many);
  assert.match(msg, /u9@b\.co \+3\)/);
  assert.doesNotMatch(msg, /u10@b\.co/);

  // >50 products → overflow summarized.
  const flood: RestockDigestEntry[] = Array.from(
    { length: RESTOCK_MAX_PRODUCTS + 2 },
    (_, i) => ({
      productId: `p${i}`,
      sku: `s${i}`,
      name: `n${i}`,
      requestCount: 1,
      emails: ['a@b.co'],
    })
  );
  const floodMsg = buildRestockMessage(flood);
  assert.match(floodMsg, /Надійшли товари \(52\):/);
  assert.match(floodMsg, /…та ще 2 товарів/);
  assert.doesNotMatch(floodMsg, /• s51 /);

  // Hard message cap (Telegram 4096 headroom).
  const huge: RestockDigestEntry[] = [
    { productId: 'p1', sku: 's1', name: 'x'.repeat(5000), requestCount: 1, emails: ['a@b.co'] },
  ];
  assert.ok(buildRestockMessage(huge).length <= 3901);
});
