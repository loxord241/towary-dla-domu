/**
 * Publish gate + freshness cron (wallpapers import, plan Task 9).
 *
 * Contracts under test:
 *
 * scripts/wallpaper-import.ts --publish (photo-presence gate, spec §4.4):
 *   - a THIRD standalone action, mutually exclusive with --plan/--run
 *     (mixing flags → usage, exit 1); it takes no options;
 *   - the publish executor is the ONLY writer of is_active in the whole CLI:
 *     exactly TWO batched UPDATEs — enable (has ≥1 product_images row) and
 *     hide (no images) — the SQL intent
 *       UPDATE products SET is_active = true  WHERE sku LIKE 'wc-%' AND EXISTS
 *         (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id);
 *       UPDATE products SET is_active = false WHERE sku LIKE 'wc-%' AND NOT EXISTS (...);
 *     resolved as a paged JS semi-join over the same domain the sync reads;
 *   - diff-aware: only rows that actually flip are written; a re-run is a
 *     no-op; every write batch ≤ BATCH_SIZE; no DELETE/upsert/rpc;
 *   - the publish branch runs BEFORE any staging read / planner call and
 *     returns its own summary («опубліковано X, приховано Y»);
 *   - the regular sync (--plan/--run) still NEVER updates is_active — new
 *     rows are inserted invisible (is_active: false), the storefront is
 *     owned exclusively by --publish.
 *
 * app/api/cron/wallpaper-freshness/route.ts (spec §6):
 *   - GET + bearer CRON_SECRET, constant-time comparison (sha256 +
 *     timingSafeEqual — the reconciliation-cron model), unset secret → 401
 *     fail-closed;
 *   - reads max(export_date) from wallpaper_stock via a service-role client;
 *     STRICTLY read-only (no .update/.insert/.delete/.upsert/.rpc, nothing
 *     touches products);
 *   - 0 rows or export_date older than 26 h → sendTelegramText to the owner
 *     (never-throw contract; Telegram failure does not fail the request);
 *   - the response is ALWAYS 200 { ok: true, lastExportDate, stale, notified }
 *     on any successfully read state; only infrastructure failures (env,
 *     DB) give 500; maxDuration = 30.
 *
 * vercel.json: valid JSON, three crons — the pre-existing reconciliation
 * one plus /api/cron/wallpaper-freshness at "0 15 * * *" and
 * /api/cron/linoleum-freshness (Task T-B, owner GO 2026-09-18); all paths
 * exist in the repo (the linoleum entry is asserted in detail in
 * tests/linoleum-freshness.test.ts).
 *
 * The DB is NEVER touched: runtime tests run against fake in-memory clients
 * (project pattern: next/server, @/ aliases and @supabase/supabase-js are
 * stubbed in a rewritten copy of the route source).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import { BATCH_SIZE, parseArgs, publishWallpapers } from '../scripts/wallpaper-import.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'scripts/wallpaper-import.ts';
const ROUTE = 'app/api/cron/wallpaper-freshness/route.ts';
const src = readFileSync(path.join(root, SCRIPT), 'utf8');

// ---------------------------------------------------------------------------
// Static structure invariants — scripts/wallpaper-import.ts (comments stripped)
// ---------------------------------------------------------------------------

const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const publishIdx = code.indexOf('async function publishWallpapers');

test('PUBLISH: --publish is a third action, mutually exclusive with --plan/--run (usage on mixing)', () => {
  assert.ok(publishIdx !== -1, 'publish executor (publishWallpapers) must exist');
  assert.match(code, /--publish/);
  assert.match(src, /--publish[^\n]*вітрина|--publish[^\n]*активні/, 'USAGE mentions --publish');
  // parseArgs rejects none/mixed modes (runtime coverage below)
});

test('PUBLISH: branch runs BEFORE staging/planner and returns before applyPlan is reachable', () => {
  const branchIdx = code.indexOf("args.mode === 'publish'");
  assert.ok(branchIdx !== -1, 'publish branch must exist in runImportCli');
  assert.ok(branchIdx < publishIdx, 'branch must precede the executor definition');
  const stagingIdx = code.indexOf('const rawStaging');
  assert.ok(stagingIdx > branchIdx, 'staging read comes after the publish branch');
  const branch = code.slice(branchIdx, stagingIdx);
  assert.doesNotMatch(branch, /\.from\(/, 'publish branch does no DB reads of its own');
  assert.doesNotMatch(branch, /applyPlan/, 'publish branch never reaches the sync executor');
  const calls = code.match(/await publishWallpapers\(/g) ?? [];
  assert.equal(calls.length, 1, 'publishWallpapers is called exactly once, from the branch');
});

test('PUBLISH: is_active UPDATEs exist ONLY in the publish executor — exactly two (enable + hide)', () => {
  // The Task 7 invariant, narrowed: everything a regular sync can execute
  // (everything defined before publishWallpapers) never UPDATEs is_active.
  const syncPart = code.slice(0, publishIdx);
  assert.equal(
    (syncPart.match(/is_active: false/g) ?? []).length,
    1,
    'only the products-insert payload pins is_active:false (new rows stay invisible)'
  );
  assert.doesNotMatch(syncPart, /is_active: true/);
  assert.doesNotMatch(syncPart, /\.update\([^)]*is_active/, 'sync never UPDATEs is_active');

  // The two publish writes, both inside the executor, both batched by id.
  const publish = code.slice(publishIdx);
  assert.equal((code.match(/is_active: true/g) ?? []).length, 1, 'exactly one enable-write');
  assert.equal(
    (code.match(/is_active: false/g) ?? []).length,
    2,
    'insert payload + exactly one hide-write'
  );
  assert.equal(
    (code.match(/\.update\(\{ is_active/g) ?? []).length,
    2,
    'is_active is written by exactly two UPDATE sites'
  );
  const enableIdx = publish.indexOf('.update({ is_active: true })');
  const hideIdx = publish.indexOf('.update({ is_active: false })');
  assert.ok(enableIdx !== -1 && hideIdx !== -1, 'enable and hide UPDATEs both present');
  for (const [name, at] of [['enable', enableIdx], ['hide', hideIdx]] as const) {
    const site = publish.slice(at, at + 220);
    assert.match(site, /\.in\('id'/, `${name} UPDATE must be batched by id (≤200)`);
  }
  assert.ok(hideIdx > enableIdx || enableIdx > hideIdx, 'both writes live in publishWallpapers');
});

test('PUBLISH: EXISTS/NOT EXISTS gate — paged product_images semi-join over the wc-* domain', () => {
  assert.match(src, /EXISTS\s*\(\s*SELECT 1 FROM product_images/i, 'SQL intent documented in the header');
  // The gate section = the paged photo-owner reader + the executor.
  const sectionIdx = code.indexOf('async function readProductIdsWithImages');
  assert.ok(sectionIdx !== -1, 'photo-owner reader must exist');
  assert.ok(sectionIdx < publishIdx, 'reader is defined before the executor (still sync-part safe)');
  const publish = code.slice(sectionIdx);
  assert.match(publish, /readExistingWallpaperProducts\(/, 'same domain the sync reads (wc-*)');
  assert.match(publish, /from\('product_images'\)/);
  assert.match(publish, /\.in\('product_id'/, 'photo ownership read windowed by ≤200 ids');
  assert.ok(
    (publish.match(/chunkRows\(/g) ?? []).length >= 3,
    'photo lookup + both update loops are batched'
  );
  assert.doesNotMatch(publish, /\.delete\(|\.upsert\(|\.rpc\(/);
});

// ---------------------------------------------------------------------------
// parseArgs — three mutually exclusive actions (runtime)
// ---------------------------------------------------------------------------

test('PUBLISH parseArgs: --publish alone → publish mode, no options', () => {
  assert.deepEqual(parseArgs(['--publish']), { mode: 'publish', categoryMapPath: null });
});

test('PUBLISH parseArgs: mixing --publish with --plan/--run → usage (null)', () => {
  assert.equal(parseArgs(['--plan', '--publish']), null);
  assert.equal(parseArgs(['--run', '--publish']), null);
  assert.equal(parseArgs(['--plan', '--run', '--publish']), null);
  assert.equal(parseArgs(['--publish', '--category-map', 'map.json']), null, 'publish takes no options');
  assert.equal(parseArgs([]), null);
  // pre-existing modes untouched
  assert.deepEqual(parseArgs(['--plan']), { mode: 'plan', categoryMapPath: null });
  assert.deepEqual(parseArgs(['--run', '--category-map', 'm.json']), {
    mode: 'run',
    categoryMapPath: 'm.json',
  });
});

// ---------------------------------------------------------------------------
// publishWallpapers — runtime gate over a fake in-memory client (NO real DB)
// ---------------------------------------------------------------------------

interface FakeProductRow {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock_quantity: number;
  is_active: boolean;
}

interface FakeDbState {
  products: FakeProductRow[];
  /** product_ids owning ≥1 product_images row. */
  photoOwners: string[];
  /** Injected error for the products UPDATE (infra failure simulation). */
  updateError: string | null;
}

interface RecordedUpdate {
  table: string;
  payload: Record<string, unknown>;
  ids: string[];
}

function makeFakeDb(state: FakeDbState): { client: SupabaseClient; updates: RecordedUpdate[] } {
  const updates: RecordedUpdate[] = [];

  const client = {
    from(table: string) {
      let updating = false;
      let payload: Record<string, unknown> = {};
      let inIds: string[] = [];
      let win: [number, number] = [0, 0];
      const b = {
        select() {
          return b;
        },
        update(p: Record<string, unknown>) {
          updating = true;
          payload = p;
          return b;
        },
        is() {
          return b;
        },
        like() {
          return b;
        },
        in(col: string, ids: readonly string[]) {
          if (updating || col === 'product_id' || col === 'id') inIds = [...ids];
          return b;
        },
        order() {
          return b;
        },
        range(from: number, to: number) {
          win = [from, to];
          return b;
        },
        returns<T>(): PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
          if (updating) {
            updates.push({ table, payload, ids: inIds });
            if (state.updateError !== null) {
              return Promise.resolve({ data: null, error: { message: state.updateError } });
            }
            const touched = state.products.filter((p) => inIds.includes(p.id));
            for (const p of touched) Object.assign(p, payload); // emulate the DB
            return Promise.resolve({ data: touched.map((p) => ({ id: p.id })) as T[], error: null });
          }
          if (table === 'products') {
            const page = state.products.slice(win[0], win[1] + 1);
            return Promise.resolve({ data: page as T[], error: null });
          }
          if (table === 'product_images') {
            const owners = state.photoOwners
              .filter((pid) => inIds.includes(pid))
              .slice(win[0], win[1] + 1)
              .map((product_id) => ({ product_id }));
            return Promise.resolve({ data: owners as T[], error: null });
          }
          return Promise.resolve({ data: null, error: { message: `unexpected table ${table}` } });
        },
      };
      return b;
    },
  };
  return { client: client as unknown as SupabaseClient, updates };
}

const product = (id: string, isActive: boolean): FakeProductRow => ({
  id,
  sku: `wc-x${id}`,
  name: `шпалери ${id}`,
  price: 100,
  stock_quantity: 3,
  is_active: isActive,
});

test('publishWallpapers: publishes only with photos, hides only without — diff-aware flip', async () => {
  const state: FakeDbState = {
    products: [
      product('a-no-photo-off', false), // untouched (already hidden)
      product('b-photo-off', false), // → published
      product('c-photo-on', true), // untouched (already published)
      product('d-no-photo-on', true), // → hidden
    ],
    photoOwners: ['b-photo-off', 'c-photo-on'],
    updateError: null,
  };
  const { client, updates } = makeFakeDb(state);

  const totals = await publishWallpapers(client);

  assert.deepEqual(totals, { published: 1, hidden: 1, withPhotos: 2, total: 4 });
  assert.equal(updates.length, 2);
  const enable = updates.find((u) => u.payload['is_active'] === true);
  const hide = updates.find((u) => u.payload['is_active'] === false);
  assert.deepEqual(enable?.ids, ['b-photo-off']);
  assert.deepEqual(hide?.ids, ['d-no-photo-on']);
  assert.equal(state.products.find((p) => p.id === 'b-photo-off')?.is_active, true);
  assert.equal(state.products.find((p) => p.id === 'd-no-photo-on')?.is_active, false);
  assert.equal(state.products.find((p) => p.id === 'a-no-photo-off')?.is_active, false);
  assert.equal(state.products.find((p) => p.id === 'c-photo-on')?.is_active, true);
});

test('publishWallpapers: idempotent — re-run over the applied state writes nothing', async () => {
  const state: FakeDbState = {
    products: [product('p1', false), product('p2', true), product('p3', false)],
    photoOwners: ['p1', 'p2'],
    updateError: null,
  };
  const db = makeFakeDb(state);
  assert.deepEqual(await publishWallpapers(db.client), {
    published: 1,
    hidden: 0,
    withPhotos: 2,
    total: 3,
  });
  const second = makeFakeDb(state);
  assert.deepEqual(await publishWallpapers(second.client), {
    published: 0,
    hidden: 0,
    withPhotos: 2,
    total: 3,
  });
  assert.equal(second.updates.length, 0, 'nothing left to flip → zero UPDATEs');
});

test('publishWallpapers: batches ≤200 ids per UPDATE (project write invariant)', async () => {
  const state: FakeDbState = {
    products: [
      ...Array.from({ length: 250 }, (_, i) => product(`on-${i}`, false)),
      ...Array.from({ length: 45 }, (_, i) => product(`off-${i}`, true)),
    ],
    photoOwners: Array.from({ length: 250 }, (_, i) => `on-${i}`),
    updateError: null,
  };
  const { client, updates } = makeFakeDb(state);
  const totals = await publishWallpapers(client);
  assert.deepEqual(totals, { published: 250, hidden: 45, withPhotos: 250, total: 295 });
  const enable = updates.filter((u) => u.payload['is_active'] === true);
  const hide = updates.filter((u) => u.payload['is_active'] === false);
  assert.deepEqual(
    enable.map((u) => u.ids.length),
    [BATCH_SIZE, 50]
  );
  assert.deepEqual(hide.map((u) => u.ids.length), [45]);
  for (const u of updates) assert.ok(u.ids.length <= BATCH_SIZE);
});

test('publishWallpapers: empty domain → totals zero, zero UPDATEs', async () => {
  const state: FakeDbState = { products: [], photoOwners: [], updateError: null };
  const { client, updates } = makeFakeDb(state);
  assert.deepEqual(await publishWallpapers(client), {
    published: 0,
    hidden: 0,
    withPhotos: 0,
    total: 0,
  });
  assert.equal(updates.length, 0);
});

test('publishWallpapers: a failing UPDATE batch throws with the batch number (no silent partial)', async () => {
  const state: FakeDbState = {
    products: [product('p1', false)],
    photoOwners: ['p1'],
    updateError: 'db went away',
  };
  const { client } = makeFakeDb(state);
  await assert.rejects(publishWallpapers(client), /publish/);
});

// ---------------------------------------------------------------------------
// Cron route — app/api/cron/wallpaper-freshness/route.ts
// ---------------------------------------------------------------------------

const routeSource = existsSync(path.join(root, ROUTE))
  ? readFileSync(path.join(root, ROUTE), 'utf8')
  : '';

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
  assert.doesNotMatch(routeCode, /WALLPAPER_INGEST_SECRET/, 'must use the cron secret');
});

test('FRESHNESS route: strictly read-only — max(export_date) from staging, nothing else', () => {
  assert.match(routeCode, /from\('wallpaper_stock'\)/);
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
// Cron route — runtime harness (real source, stubbed next/server + supabase
// + telegram; project pattern from tests/wallpaper-ingest.test.ts)
// ---------------------------------------------------------------------------

interface FreshTestGlobal {
  __freshRow?: { export_date: string } | null;
  __freshError?: { message: string } | null;
  __freshTables?: string[];
  __freshTelegram?: string[];
  __freshTelegramResult?: { sent: boolean; reason?: string } | null;
}
const g = globalThis as FreshTestGlobal;

function resetFakes() {
  g.__freshRow = null;
  g.__freshError = null;
  g.__freshTables = [];
  g.__freshTelegram = [];
  g.__freshTelegramResult = null;
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
          (gg.__freshTables = gg.__freshTables ?? []).push(table);
          const chain = {
            select: () => chain,
            order: () => chain,
            limit: () => chain,
            maybeSingle: () =>
              Promise.resolve({ data: gg.__freshRow ?? null, error: gg.__freshError ?? null }),
          };
          return chain;
        },
      });`
    )
    .replace(
      /import\s*\{\s*sendTelegramText\s*\}\s*from\s*'@\/app\/lib\/notifications\/telegram';/,
      `const sendTelegramText = async (text: string) => {
        const gg = globalThis as FreshTestGlobal;
        (gg.__freshTelegram = gg.__freshTelegram ?? []).push(text);
        return gg.__freshTelegramResult ?? { sent: true };
      };`
    );
  assert.ok(!rewritten.includes("'next/server'"), 'harness drift: next/server import not stubbed');
  assert.ok(!rewritten.includes("'@supabase/supabase-js'"), 'harness drift: supabase import not stubbed');
  assert.ok(!rewritten.includes("'@/app/lib/"), 'harness drift: @/ alias import not stubbed');
  const dir = mkdtempSync(path.join(tmpdir(), 'wallpaper-freshness-'));
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
  new Request('https://example.com/api/cron/wallpaper-freshness', {
    headers: { authorization: 'Bearer test-cron-secret' },
  });

test('FRESHNESS runtime: missing/wrong/unset secret → 401, no DB read, no telegram', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  const route = await loadFreshnessRoute();
  resetFakes();

  const noHeader = await route.GET(
    new Request('https://example.com/api/cron/wallpaper-freshness')
  );
  assert.equal(noHeader.status, 401);
  const wrong = await route.GET(
    new Request('https://example.com/api/cron/wallpaper-freshness', {
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
  assert.equal((g.__freshTables ?? []).length, 0, 'no DB access on 401');
  assert.equal((g.__freshTelegram ?? []).length, 0);
});

test('FRESHNESS runtime: fresh file → 200 {ok, stale:false, notified:false}, owner not pinged', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const route = await loadFreshnessRoute();
  resetFakes();
  g.__freshRow = { export_date: TODAY };

  const res = await route.GET(get());
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    lastExportDate: string | null;
    stale: boolean;
    notified: boolean;
  };
  assert.deepEqual(body, { ok: true, lastExportDate: TODAY, stale: false, notified: false });
  assert.deepEqual(g.__freshTables, ['wallpaper_stock']);
  assert.equal((g.__freshTelegram ?? []).length, 0);
});

test('FRESHNESS runtime: stale file → 200, telegram alert with the 26 h text and last date', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const route = await loadFreshnessRoute();
  resetFakes();
  g.__freshRow = { export_date: TWO_DAYS_AGO };

  const res = await route.GET(get());
  assert.equal(res.status, 200, 'stale is still a successfully read state → 200');
  const body = (await res.json()) as { ok: boolean; stale: boolean; notified: boolean; lastExportDate: string };
  assert.equal(body.ok, true);
  assert.equal(body.stale, true);
  assert.equal(body.notified, true);
  assert.equal((g.__freshTelegram ?? []).length, 1);
  const text = (g.__freshTelegram ?? [])[0] ?? '';
  assert.match(text, /не поступал более 26 ч/);
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
  const text = (g.__freshTelegram ?? [])[0] ?? '';
  assert.match(text, /не поступал более 26 ч/);
  assert.ok(text.includes('—'), 'no last date exists → placeholder in the alert');
});

test('FRESHNESS runtime: telegram failure never fails the request (notified:false, 200)', async () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const route = await loadFreshnessRoute();
  resetFakes();
  g.__freshRow = { export_date: TWO_DAYS_AGO };
  g.__freshTelegramResult = { sent: false, reason: 'disabled' };

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
  g.__freshError = { message: 'connection refused' };

  const res = await route.GET(get());
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'Freshness check failed');
  assert.doesNotMatch(body.error, /connection refused/, 'no internals leak into the response');
});

// ---------------------------------------------------------------------------
// vercel.json — two crons, both paths real
// ---------------------------------------------------------------------------

test('vercel.json: valid JSON with three crons — reconciliation preserved, freshness added', () => {
  const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8')) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  assert.equal(vercel.crons.length, 3);
  const reconciliation = vercel.crons.find((c) => c.path === '/api/cron/reconciliation');
  assert.deepEqual(reconciliation, { path: '/api/cron/reconciliation', schedule: '0 6 * * *' });
  const freshness = vercel.crons.find((c) => c.path === '/api/cron/wallpaper-freshness');
  assert.deepEqual(freshness, { path: '/api/cron/wallpaper-freshness', schedule: '0 15 * * *' });
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
