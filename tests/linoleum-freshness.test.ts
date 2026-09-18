/**
 * Freshness cron for the 1С linoleum stock channel (Task T-B):
 * app/api/cron/linoleum-freshness/route.ts — a mirror of the
 * wallpaper-freshness cron (tests/wallpaper-publish.test.ts, cron section):
 *
 *   - GET + bearer CRON_SECRET, constant-time comparison (sha256 +
 *     timingSafeEqual — the reconciliation-cron model), unset secret → 401
 *     fail-closed;
 *   - reads max(export_date) from linoleum_stock (migration 052: DATE,
 *     RLS on, service-role only) via a service-role client; STRICTLY
 *     read-only (no .update/.insert/.delete/.upsert/.rpc, nothing touches
 *     products);
 *   - 0 rows or export_date older than 26 h (age measured from the DATE's
 *     UTC midnight) → sendTelegramText to the owner (never-throw contract;
 *     Telegram failure does not fail the request);
 *   - the response is ALWAYS 200 { ok: true, lastExportDate, stale,
 *     notified } on any successfully read state; only infrastructure
 *     failures (env, DB) give 500; maxDuration = 30.
 *
 * vercel.json: three crons — the pre-existing reconciliation and
 * wallpaper-freshness entries preserved plus /api/cron/linoleum-freshness
 * at "0 15 * * *" (owner GO 2026-09-18); every cron path maps to an
 * existing route.ts in the repo.
 *
 * The DB is NEVER touched: runtime tests run against fake in-memory clients
 * (project pattern: next/server, @/ aliases and @supabase/supabase-js are
 * stubbed in a rewritten copy of the route source — the same harness as
 * tests/wallpaper-publish.test.ts).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = 'app/api/cron/linoleum-freshness/route.ts';
const routeSource = readFileSync(path.join(root, ROUTE), 'utf8');

// ---------------------------------------------------------------------------
// Static structure invariants — route source (comments stripped)
// ---------------------------------------------------------------------------

const routeCode = routeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('FRESHNESS route: GET-only cron handler with maxDuration 30', () => {
  assert.match(routeCode, /export const maxDuration = 30/);
  assert.match(routeCode, /export async function GET\(request: Request\)/);
  assert.doesNotMatch(routeCode, /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/);
});

test('FRESHNESS route: bearer CRON_SECRET, constant-time, fail-closed (cron model)', () => {
  assert.match(routeCode, /CRON_SECRET/);
  assert.match(routeCode, /createHash\('sha256'\)/);
  assert.match(routeCode, /timingSafeEqual/);
  assert.match(routeCode, /Bearer \$\{secret\}/);
  assert.match(routeCode, /status: 401/);
  assert.doesNotMatch(routeCode, /LINOLEUM_INGEST_SECRET/, 'must use the cron secret');
});

test('FRESHNESS route: strictly read-only — max(export_date) from staging, nothing else', () => {
  assert.match(routeCode, /from\('linoleum_stock'\)/);
  assert.match(routeCode, /select\('export_date'\)/);
  assert.doesNotMatch(routeCode, /from\('products'\)/, 'the cron never touches products');
  assert.match(routeCode, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(routeCode, /persistSession: false/);
  // The constant-time auth legitimately calls Hash.update() — neutralize the
  // crypto chains before scanning for DB mutation calls.
  const codeNoCrypto = routeCode.replace(
    /createHash\('sha256'\)\s*\.update\([^)]*\)\s*\.digest\(\)/g,
    ''
  );
  for (const call of ['.update(', '.insert(', '.delete(', '.upsert(', '.rpc(']) {
    assert.ok(!codeNoCrypto.includes(call), `forbidden DB call in freshness route: ${call}`);
  }
});

test('FRESHNESS route: 26 h threshold, owner alert text, always-200 summary, 500 on infra only', () => {
  assert.match(routeCode, /STALE_AFTER_HOURS = 26/);
  assert.match(routeCode, /не поступал более 26 ч/);
  assert.match(routeCode, /sendTelegramText/);
  assert.match(routeCode, /ok: true/);
  assert.match(routeCode, /status: 500/);
  assert.match(routeCode, /'Freshness check failed'/);
});

// ---------------------------------------------------------------------------
// Runtime harness (real source, stubbed next/server + supabase + telegram;
// project pattern from tests/wallpaper-publish.test.ts)
// ---------------------------------------------------------------------------

interface FreshTestGlobal {
  __linFreshRow?: { export_date: string } | null;
  __linFreshError?: { message: string } | null;
  __linFreshTables?: string[];
  __linFreshTelegram?: string[];
  __linFreshTelegramResult?: { sent: boolean; reason?: string } | null;
}
const g = globalThis as FreshTestGlobal;

function resetFakes() {
  g.__linFreshRow = null;
  g.__linFreshError = null;
  g.__linFreshTables = [];
  g.__linFreshTelegram = [];
  g.__linFreshTelegramResult = null;
}

interface FreshRouteModule {
  GET: (request: Request) => Promise<Response>;
}

async function loadFreshnessRoute(): Promise<FreshRouteModule> {
  const rewritten = routeSource
    .replace(
      /import\s*\{\s*NextResponse\s*\}\s*from\s*'next\/server';/,
      `const NextResponse = { json: (body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), init) };`
    )
    .replace(
      /import\s*\{\s*createClient\s*\}\s*from\s*'@supabase\/supabase-js';/,
      `const createClient = () => ({
        from(table: string) {
          const gg = globalThis as FreshTestGlobal;
          (gg.__linFreshTables = gg.__linFreshTables ?? []).push(table);
          const chain = {
            select: () => chain,
            order: () => chain,
            limit: () => chain,
            maybeSingle: () =>
              Promise.resolve({ data: gg.__linFreshRow ?? null, error: gg.__linFreshError ?? null }),
          };
          return chain;
        },
      });`
    )
    .replace(
      /import\s*\{\s*sendTelegramText\s*\}\s*from\s*'@\/app\/lib\/notifications\/telegram';/,
      `const sendTelegramText = async (text: string) => {
        const gg = globalThis as FreshTestGlobal;
        (gg.__linFreshTelegram = gg.__linFreshTelegram ?? []).push(text);
        return gg.__linFreshTelegramResult ?? { sent: true };
      };`
    );
  assert.ok(!rewritten.includes("'next/server'"), 'harness drift: next/server import not stubbed');
  assert.ok(!rewritten.includes("'@supabase/supabase-js'"), 'harness drift: supabase import not stubbed');
  assert.ok(!rewritten.includes("'@/app/lib/"), 'harness drift: @/ alias import not stubbed');
  const dir = mkdtempSync(path.join(tmpdir(), 'linoleum-freshness-'));
  try {
    const file = path.join(dir, 'route-stubbed.mts');
    writeFileSync(file, rewritten);
    return (await import(pathToFileURL(file).href)) as FreshRouteModule;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const TODAY = isoDate(Date.now());
const TWO_DAYS_AGO = isoDate(Date.now() - 2 * 24 * 60 * 60 * 1000); // always > 26 h

const get = (): Request =>
  new Request('https://example.com/api/cron/linoleum-freshness', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });

test('FRESHNESS runtime: missing/wrong/unset secret → 401, no DB read, no telegram', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  const route = await loadFreshnessRoute();
  resetFakes();

  const noHeader = await route.GET(
    new Request('https://example.com/api/cron/linoleum-freshness')
  );
  assert.equal(noHeader.status, 401);
  const wrong = await route.GET(
    new Request('https://example.com/api/cron/linoleum-freshness', {
      headers: { authorization: 'Bearer nope' },
    })
  );
  assert.equal(wrong.status, 401);

  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const unset = await route.GET(get());
    assert.equal(unset.status, 401, 'unset CRON_SECRET must fail closed');
  } finally {
    process.env.CRON_SECRET = saved;
  }
  assert.equal((g.__linFreshTables ?? []).length, 0, 'no DB access on 401');
  assert.equal((g.__linFreshTelegram ?? []).length, 0);
});

test('FRESHNESS runtime: fresh file → 200 {ok, stale:false, notified:false}, owner not pinged', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const route = await loadFreshnessRoute();
  resetFakes();
  g.__linFreshRow = { export_date: TODAY };

  const res = await route.GET(get());
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    lastExportDate: string | null;
    stale: boolean;
    notified: boolean;
  };
  assert.deepEqual(body, { ok: true, lastExportDate: TODAY, stale: false, notified: false });
  assert.deepEqual(g.__linFreshTables, ['linoleum_stock']);
  assert.equal((g.__linFreshTelegram ?? []).length, 0);
});

test('FRESHNESS runtime: stale file → 200, telegram alert with the 26 h text and last date', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const route = await loadFreshnessRoute();
  resetFakes();
  g.__linFreshRow = { export_date: TWO_DAYS_AGO };

  const res = await route.GET(get());
  assert.equal(res.status, 200, 'stale is still a successfully read state → 200');
  const body = (await res.json()) as { ok: boolean; stale: boolean; notified: boolean; lastExportDate: string };
  assert.equal(body.ok, true);
  assert.equal(body.stale, true);
  assert.equal(body.notified, true);
  assert.equal((g.__linFreshTelegram ?? []).length, 1);
  const text = (g.__linFreshTelegram ?? [])[0] ?? '';
  assert.match(text, /не поступал более 26 ч/);
  assert.match(text, /Linoleum sync/);
  assert.ok(text.includes(TWO_DAYS_AGO), 'alert carries the last export date');
});

test('FRESHNESS runtime: empty staging (0 rows) → stale, alert with the «—» placeholder, 200', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const route = await loadFreshnessRoute();
  resetFakes();

  const res = await route.GET(get());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; lastExportDate: string | null; stale: boolean; notified: boolean };
  assert.deepEqual(body, { ok: true, lastExportDate: null, stale: true, notified: true });
  const text = (g.__linFreshTelegram ?? [])[0] ?? '';
  assert.match(text, /не поступал более 26 ч/);
  assert.ok(text.includes('—'), 'no last date exists → placeholder in the alert');
});

test('FRESHNESS runtime: telegram failure never fails the request (notified:false, 200)', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const route = await loadFreshnessRoute();
  resetFakes();
  g.__linFreshRow = { export_date: TWO_DAYS_AGO };
  g.__linFreshTelegramResult = { sent: false, reason: 'disabled' };

  const res = await route.GET(get());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; stale: boolean; notified: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.stale, true);
  assert.equal(body.notified, false);
});

test('FRESHNESS runtime: infra failure (DB error) → 500 with no internals', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const route = await loadFreshnessRoute();
  resetFakes();
  g.__linFreshError = { message: 'connection refused' };

  const res = await route.GET(get());
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'Freshness check failed');
  assert.doesNotMatch(body.error, /connection refused/, 'no internals leak into the response');
});

// ---------------------------------------------------------------------------
// vercel.json — the third cron, existing entries preserved, paths real
// ---------------------------------------------------------------------------

test('vercel.json: valid JSON with three crons — linoleum freshness added at 15:00 UTC', () => {
  const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  assert.equal(vercel.crons.length, 3);
  const linoleum = vercel.crons.find((c) => c.path === '/api/cron/linoleum-freshness');
  assert.deepEqual(linoleum, { path: '/api/cron/linoleum-freshness', schedule: '0 15 * * *' });
  assert.ok(
    vercel.crons.some((c) => c.path === '/api/cron/reconciliation'),
    'reconciliation cron preserved'
  );
  assert.ok(
    vercel.crons.some((c) => c.path === '/api/cron/wallpaper-freshness'),
    'wallpaper freshness cron preserved'
  );
});

test('vercel.json: every cron path maps to an existing route.ts in the repo', () => {
  const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
    crons: Array<{ path: string }>;
  };
  for (const cron of vercel.crons) {
    const routeFile = path.join(root, 'app/api', cron.path.replace(/^\/api\//, ''), 'route.ts');
    assert.ok(existsSync(routeFile), `cron path ${cron.path} must exist (${routeFile})`);
  }
});
