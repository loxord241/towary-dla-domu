/**
 * Ingest endpoint POST /api/ingest/1c-wallpaper (wallpapers import, Task 5).
 *
 * Contract under test:
 *   - bearer-token-only auth: `Authorization: Bearer ${WALLPAPER_INGEST_SECRET}`;
 *     missing, wrong or UNCONFIGURED secret → generic 401 with NO write
 *     executed (fail-closed); comparison is constant-time (sha256 +
 *     timingSafeEqual — the cron-route model), so no timing/length oracle;
 *   - body is text/csv, ≤ 2 MB (413), ≤ 2000 data lines (413); the optional
 *     header line and BOM are tolerated; per-line validation (price
 *     50..5000, qty 0..999 — spec windows) is delegated to parseWallpaperCsv — bad lines
 *     land in `errors` (rejected) and never fail the whole file;
 *   - `X-Export-Date: YYYYMMDD` is mandatory, must be a real calendar date
 *     and not older than 400 days → otherwise 400;
 *   - accepted rows are APPENDED to the `wallpaper_stock` staging table
 *     (migration 041) with a service-role client (persistSession: false) in
 *     chunks of ≤ 500; response 202 { accepted, rejected, exportDate,
 *     errors: first 20 };
 *   - DB/infra failure → 500 { error: 'Ingest failed' } with no internals;
 *   - POST is the only exported handler (App Router answers 405 for the
 *     rest) and maxDuration is bounded at 60.
 *
 * Route behavior is loaded from the REAL route source with only the
 * untestable edges stubbed (project pattern: next/server and @/ aliases are
 * not resolvable under plain node:test — see cron-reconciliation /
 * pagination-hardening tests). The real parseWallpaperCsv and the real
 * constant-time auth run unstubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = 'app/api/ingest/1c-wallpaper/route.ts';
const routeSource = readFileSync(path.join(root, ROUTE), 'utf8');

process.env.WALLPAPER_INGEST_SECRET = 'test-ingest-secret';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const parseUrl = pathToFileURL(path.join(root, 'app/lib/wallpapers/parse.ts')).href;

// ---------------------------------------------------------------------------
// Static structure invariants (raw source, comments stripped)
// ---------------------------------------------------------------------------

const routeCode = routeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('INGEST route: POST-only — no GET/data-export handler exists', () => {
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(routeCode, /export\s+(?:async\s+)?function\s+(GET|PUT|PATCH|DELETE)\b/);
});

test('INGEST route: constant-time bearer auth against WALLPAPER_INGEST_SECRET (cron model)', () => {
  assert.match(routeCode, /WALLPAPER_INGEST_SECRET/);
  assert.match(routeCode, /createHash\('sha256'\)/);
  assert.match(routeCode, /timingSafeEqual/);
  assert.match(routeCode, /Bearer \$\{secret\}/);
  assert.doesNotMatch(routeCode, /CRON_SECRET/, 'must use its own secret, not the cron one');
});

test('INGEST route: limits pinned in code (2 MB body, 2000 rows, 500-row chunks, 20 errors, 400 days)', () => {
  assert.match(routeCode, /MAX_BODY_BYTES = 2 \* 1024 \* 1024/);
  assert.match(routeCode, /MAX_ROWS = 2000/);
  assert.match(routeCode, /DB_CHUNK = 500/);
  assert.match(routeCode, /ERROR_SAMPLE_LIMIT = 20/);
  assert.match(routeCode, /EXPORT_DATE_MAX_AGE_DAYS = 400/);
  assert.match(routeCode, /maxDuration = 60/);
});

test('INGEST route: service-role staging write only (RLS table, insert-only, parser reused)', () => {
  assert.match(routeCode, /from '@supabase\/supabase-js'/);
  assert.match(routeCode, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(routeCode, /persistSession: false/);
  assert.match(routeCode, /from\('wallpaper_stock'\)/);
  assert.match(routeCode, /\.insert\(/);
  // Append-only staging: no update/delete/upsert/rpc from the ingest path.
  // The constant-time auth legitimately calls Hash.update() — neutralize the
  // crypto chains before scanning for DB mutation calls.
  const codeWithoutCrypto = routeCode.replace(
    /createHash\('sha256'\)\s*\.update\([^)]*\)\s*\.digest\(\)/g,
    ''
  );
  for (const call of ['.update(', '.delete(', '.upsert(', '.rpc(']) {
    assert.ok(!codeWithoutCrypto.includes(call), `forbidden DB call in ingest route: ${call}`);
  }
  assert.match(routeCode, /'@\/app\/lib\/wallpapers\/parse'/, 'CSV parsing delegated to the Task 3 parser');
  assert.doesNotMatch(routeCode, /STRICT_NUMBER_RE|PRICE_MIN|QTY_MAX/, 'parser internals must not be reimplemented');
  assert.match(routeCode, /'Ingest failed'/, 'DB failures answer the generic 500');
  assert.match(routeCode, /status: 202/);
  assert.match(routeCode, /status: 401/);
  assert.match(routeCode, /status: 413/);
  assert.match(routeCode, /status: 400/);
});

// ---------------------------------------------------------------------------
// Runtime harness: real route source, stubbed next/server + supabase client
// ---------------------------------------------------------------------------

interface IngestTestGlobal {
  /** One entry per createClient() call: [url, serviceKey, options]. */
  __ingestClientCalls?: unknown[][];
  __ingestTables?: string[];
  __ingestInserts?: unknown[][];
  __ingestInsertError?: { message: string } | null;
  __ingestClientThrow?: boolean;
}
const g = globalThis as IngestTestGlobal;

function resetFakes() {
  g.__ingestClientCalls = [];
  g.__ingestTables = [];
  g.__ingestInserts = [];
  g.__ingestInsertError = null;
  g.__ingestClientThrow = false;
}

interface CsvErrorLike {
  line: number;
  reason: string;
}

interface RowLike {
  code: string;
  name: string;
  article: string | null;
  rollSize: { widthCm: number; lengthM: number } | null;
  priceRetail: number;
  qty: number;
}

interface RouteModule {
  POST: (request: Request) => Promise<Response>;
  validateIngestPayload?: (
    body: string,
    headers: { exportDate?: string | null }
  ) =>
    | { ok: true; exportDate: string; rows: RowLike[]; errors: CsvErrorLike[] }
    | { ok: false; status: number; error: string };
}

async function loadRoute(): Promise<RouteModule> {
  const rewritten = routeSource
    .replace(
      /import\s*\{\s*NextResponse\s*\}\s*from\s*'next\/server';/,
      `const NextResponse = { json: (body: unknown, init?: ResponseInit) =>
        new Response(JSON.stringify(body), init) };`
    )
    .replace(
      /import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/wallpapers\/parse';/,
      `const { parseWallpaperCsv } = await import('${parseUrl}');
type CsvError = { line: number; reason: string };
type WallpaperRow = { code: string; name: string; article: string | null; rollSize: { widthCm: number; lengthM: number } | null; priceRetail: number; qty: number };`
    )
    .replace(
      /import\s*\{\s*createClient\s*\}\s*from\s*'@supabase\/supabase-js';/,
      `const createClient = (...args: unknown[]) => {
        const gg = globalThis as IngestTestGlobal;
        (gg.__ingestClientCalls = gg.__ingestClientCalls ?? []).push(args);
        if (gg.__ingestClientThrow) throw new Error('client init failed');
        return {
          from(table: string) {
            (gg.__ingestTables = gg.__ingestTables ?? []).push(table);
            return {
              insert(rows: unknown[]) {
                (gg.__ingestInserts = gg.__ingestInserts ?? []).push(rows);
                const err = gg.__ingestInsertError;
                return Promise.resolve(err ? { error: err } : { error: null });
              },
            };
          },
        };
      };`
    );
  assert.ok(!rewritten.includes("'next/server'"), 'harness drift: next/server import not stubbed');
  assert.ok(!rewritten.includes("'@supabase/supabase-js'"), 'harness drift: supabase import not stubbed');
  assert.ok(!rewritten.includes("'@/app/lib/"), 'harness drift: @/ alias import not stubbed');
  const dir = mkdtempSync(path.join(tmpdir(), 'wallpaper-ingest-'));
  try {
    const file = path.join(dir, 'route-stubbed.mts');
    writeFileSync(file, rewritten);
    return (await import(pathToFileURL(file).href)) as RouteModule;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const yyyymmdd = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');
const TODAY = yyyymmdd(new Date());
const FRESH = yyyymmdd(new Date(Date.now() - 399 * 86400000)); // inside the 400-day window
const TOO_OLD = yyyymmdd(new Date(Date.now() - 402 * 86400000)); // beyond 400 days

const HEADER = 'code;name;article;unit;price_retail;qty';

function dataRow(code: string, price: string | number = 100, qty: string | number = 5): string {
  return `${code};Шпалери ${code}, 53см*10м;ART-${code};шт;${price};${qty}`;
}

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/ingest/1c-wallpaper', {
    method: 'POST',
    headers: { 'content-type': 'text/csv', ...headers },
    body,
  });
}

const authed = (body: string, headers: Record<string, string> = {}): Request =>
  makeRequest(body, {
    authorization: 'Bearer test-ingest-secret',
    'x-export-date': TODAY,
    ...headers,
  });

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runtime: auth (fail-closed)
// ---------------------------------------------------------------------------

test('INGEST: 401 without Authorization header, nothing written', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const res = await POST(makeRequest(HEADER));
  assert.equal(res.status, 401);
  assert.deepEqual(await jsonBody(res), { error: 'Unauthorized' });
  assert.equal(g.__ingestClientCalls!.length, 0, 'no DB client must be created');
});

test('INGEST: 401 with a wrong bearer, nothing written', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const res = await POST(authed(HEADER, { authorization: 'Bearer wrong-secret' }));
  assert.equal(res.status, 401);
  assert.equal(g.__ingestClientCalls!.length, 0);
});

test('INGEST: 401 fail-closed when WALLPAPER_INGEST_SECRET is not configured at all', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const saved = process.env.WALLPAPER_INGEST_SECRET;
  delete process.env.WALLPAPER_INGEST_SECRET;
  try {
    const res = await POST(authed(HEADER));
    assert.equal(res.status, 401);
    assert.equal(g.__ingestClientCalls!.length, 0);
  } finally {
    process.env.WALLPAPER_INGEST_SECRET = saved;
  }
});

// ---------------------------------------------------------------------------
// Runtime: happy path
// ---------------------------------------------------------------------------

test('INGEST: valid CSV (BOM + header) → 202, rows staged with export_date, service-role client', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const body = `\uFEFF${HEADER}\n6647-04;Шпалери 6647-04, 53см*10м;6647-04;шт;250,50;12\n30202;бузкова лілея шпалери;;шт;180;0\n`;
  const res = await POST(authed(body));
  assert.equal(res.status, 202);
  const json = await jsonBody(res);
  assert.deepEqual(json, {
    accepted: 2,
    rejected: 0,
    exportDate: `${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}`,
    errors: [],
  });
  // service-role client, no session persistence (one client per request)
  const clientCalls = g.__ingestClientCalls!;
  assert.equal(clientCalls.length, 1);
  assert.deepEqual(clientCalls[0]![2], { auth: { persistSession: false } });
  // single chunk into the staging table
  assert.deepEqual(g.__ingestTables, ['wallpaper_stock']);
  const inserts = g.__ingestInserts!;
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0], [
    {
      code: '6647-04',
      name: 'Шпалери 6647-04, 53см*10м',
      price_retail: 250.5,
      qty: 12,
      export_date: `${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}`,
    },
    {
      code: '30202',
      name: 'бузкова лілея шпалери',
      price_retail: 180,
      qty: 0,
      export_date: `${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}`,
    },
  ]);
});

test('INGEST: staging is append-only — chunks never exceed 500 rows', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const lines = Array.from({ length: 1200 }, (_, i) => dataRow(String(i + 1).padStart(6, '0')));
  const res = await POST(authed(`${HEADER}\n${lines.join('\n')}\n`));
  assert.equal(res.status, 202);
  const inserts = g.__ingestInserts!;
  assert.deepEqual(
    inserts.map((c) => c.length),
    [500, 500, 200]
  );
  assert.equal((await jsonBody(res)).accepted, 1200);
});

test('INGEST: header-only file → 202 accepted 0, zero DB writes', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const res = await POST(authed(`${HEADER}\n`));
  assert.equal(res.status, 202);
  const json = await jsonBody(res);
  assert.equal(json.accepted, 0);
  assert.equal(json.rejected, 0);
  assert.equal(g.__ingestInserts!.length, 0);
});

// ---------------------------------------------------------------------------
// Runtime: per-line rejection (parser contract, never a file-level failure)
// ---------------------------------------------------------------------------

test('INGEST: a line with price -1 → rejected, the rest accepted', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const body = `${HEADER}\n6647-04;Шпалери 6647-04;6647-04;шт;250;12\n9999-99;Крива ціна;9999-99;шт;-1;5\n`;
  const res = await POST(authed(body));
  assert.equal(res.status, 202, 'rejected lines never fail the file');
  const json = await jsonBody(res);
  assert.equal(json.accepted, 1);
  assert.equal(json.rejected, 1);
  const errors = json.errors as CsvErrorLike[];
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 3);
  assert.match(errors[0]!.reason, /price_retail/);
  assert.equal(g.__ingestInserts![0]!.length, 1, 'only valid rows reach staging');
});

test('INGEST: 25 bad lines → rejected=25, only the first 20 errors returned', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const lines = Array.from({ length: 25 }, (_, i) => dataRow(String(i + 1), -1, 5));
  const res = await POST(authed(`${HEADER}\n${lines.join('\n')}\n`));
  assert.equal(res.status, 202);
  const json = await jsonBody(res);
  assert.equal(json.accepted, 0);
  assert.equal(json.rejected, 25);
  assert.equal((json.errors as CsvErrorLike[]).length, 20);
  assert.equal(g.__ingestInserts!.length, 0);
});

// ---------------------------------------------------------------------------
// Runtime: X-Export-Date contract
// ---------------------------------------------------------------------------

test('INGEST: missing / malformed X-Export-Date → 400', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const body = `${HEADER}\n${dataRow('6647-04')}\n`;
  // Built manually: authed() would inject the default TODAY export date.
  const bearerOnly = (extra: Record<string, string> = {}): Request =>
    makeRequest(body, { authorization: 'Bearer test-ingest-secret', ...extra });
  for (const date of [undefined, '', '2026091', '2026-09-10', '20261332', '00000000', 'abcdefghi']) {
    const res = await POST(bearerOnly(date === undefined ? {} : { 'x-export-date': date }));
    assert.equal(res.status, 400, `expected 400 for x-export-date=${String(date)}`);
    assert.deepEqual(await jsonBody(res), { error: 'Invalid X-Export-Date' });
  }
  assert.equal(g.__ingestInserts!.length, 0, 'nothing written on invalid export date');
});

test('INGEST: export date older than 400 days → 400; inside the window → 202', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const body = `${HEADER}\n${dataRow('6647-04')}\n`;
  const tooOld = await POST(authed(body, { 'x-export-date': TOO_OLD }));
  assert.equal(tooOld.status, 400);
  assert.deepEqual(await jsonBody(tooOld), { error: 'X-Export-Date is too old' });

  resetFakes();
  const fresh = await POST(authed(body, { 'x-export-date': FRESH }));
  assert.equal(fresh.status, 202);
});

// ---------------------------------------------------------------------------
// Runtime: size limits → 413
// ---------------------------------------------------------------------------

test('INGEST: body > 2 MB → 413, nothing written', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const huge = `${HEADER}\n${'x'.repeat(2 * 1024 * 1024 + 1)}`;
  const res = await POST(authed(huge));
  assert.equal(res.status, 413);
  assert.deepEqual(await jsonBody(res), { error: 'Payload too large' });
  assert.equal(g.__ingestClientCalls!.length, 0, 'no DB client for oversized uploads');
});

test('INGEST: 2001 data rows → 413; 2000 data rows → 202 (boundary)', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const tooMany = Array.from({ length: 2001 }, (_, i) => dataRow(String(i + 1).padStart(6, '0')));
  const resTooMany = await POST(authed(`${HEADER}\n${tooMany.join('\n')}\n`));
  assert.equal(resTooMany.status, 413);
  assert.deepEqual(await jsonBody(resTooMany), { error: 'Too many rows' });

  resetFakes();
  const atLimit = Array.from({ length: 2000 }, (_, i) => dataRow(String(i + 1).padStart(6, '0')));
  const resAtLimit = await POST(authed(`${HEADER}\n${atLimit.join('\n')}\n`));
  assert.equal(resAtLimit.status, 202);
  assert.equal((await jsonBody(resAtLimit)).accepted, 2000);
  assert.deepEqual(
    g.__ingestInserts!.map((c) => c.length),
    [500, 500, 500, 500]
  );
});

// ---------------------------------------------------------------------------
// Runtime: DB failure → generic 500 without internals
// ---------------------------------------------------------------------------

test('INGEST: staging insert failure → 500 { error: Ingest failed }, no internals leaked', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  g.__ingestInsertError = { message: 'duplicate key value violates unique constraint "boom"' };
  try {
    const res = await POST(authed(`${HEADER}\n${dataRow('6647-04')}\n`));
    assert.equal(res.status, 500);
    const json = await jsonBody(res);
    assert.deepEqual(Object.keys(json), ['error']);
    assert.equal(json.error, 'Ingest failed');
    assert.ok(!JSON.stringify(json).includes('duplicate key'), 'DB internals must not leak');
  } finally {
    g.__ingestInsertError = null;
  }
});

test('INGEST: storage client init failure (e.g. missing env) → 500, fail-closed', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  g.__ingestClientThrow = true;
  try {
    const res = await POST(authed(`${HEADER}\n${dataRow('6647-04')}\n`));
    assert.equal(res.status, 500);
    assert.deepEqual(await jsonBody(res), { error: 'Ingest failed' });
  } finally {
    g.__ingestClientThrow = false;
  }
});

// ---------------------------------------------------------------------------
// Unit: validateIngestPayload (exported pure helper)
// ---------------------------------------------------------------------------

test('INGEST helper: ok payload carries parsed rows + exportDate ISO', async () => {
  const { validateIngestPayload } = await loadRoute();
  assert.ok(validateIngestPayload, 'validateIngestPayload must be exported for tests');
  const out = validateIngestPayload!(
    `\uFEFF${HEADER}\n6647-04;Шпалери 6647-04, 53см*10м;6647-04;шт;250,50;12\n`,
    { exportDate: TODAY }
  );
  assert.equal(out.ok, true);
  assert.ok(out.ok && out.rows.length === 1);
  const row = out.rows[0]!;
  assert.equal(row.code, '6647-04');
  assert.equal(row.article, '6647-04');
  assert.equal(row.priceRetail, 250.5);
  assert.deepEqual(row.rollSize, { widthCm: 53, lengthM: 10 });
  assert.equal(out.ok && out.exportDate, `${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}`);
});

test('INGEST helper: 400/413 branches', async () => {
  const { validateIngestPayload } = await loadRoute();
  const noDate = validateIngestPayload!(dataRow('6647-04'), {});
  assert.deepEqual(noDate, { ok: false, status: 400, error: 'Invalid X-Export-Date' });

  const badDate = validateIngestPayload!(dataRow('6647-04'), { exportDate: '2026091' });
  assert.equal(badDate.ok, false);
  assert.ok(!badDate.ok && badDate.status === 400);

  const oldDate = validateIngestPayload!(dataRow('6647-04'), { exportDate: TOO_OLD });
  assert.ok(!oldDate.ok && oldDate.status === 400 && oldDate.error === 'X-Export-Date is too old');

  const huge = validateIngestPayload!('x'.repeat(2 * 1024 * 1024 + 1), { exportDate: TODAY });
  assert.ok(!huge.ok && huge.status === 413);

  const tooManyRows = validateIngestPayload!(
    Array.from({ length: 2001 }, (_, i) => dataRow(String(i + 1))).join('\n'),
    { exportDate: TODAY }
  );
  assert.ok(!tooManyRows.ok && tooManyRows.status === 413 && tooManyRows.error === 'Too many rows');

  // Boundary: exactly 2000 data lines (no header) passes.
  const atLimit = validateIngestPayload!(
    Array.from({ length: 2000 }, (_, i) => dataRow(String(i + 1))).join('\n'),
    { exportDate: TODAY }
  );
  assert.ok(atLimit.ok && atLimit.rows.length === 2000);
});
