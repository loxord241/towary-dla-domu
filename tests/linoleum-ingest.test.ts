/**
 * Ingest endpoint POST /api/ingest/1c-linoleum (linoleum vertical, batch 1).
 *
 * Symmetric to POST /api/ingest/1c-wallpaper (tests/wallpaper-ingest.test.ts)
 * with its own contract:
 *   - bearer-token-only auth: `Authorization: Bearer ${LINOLEUM_INGEST_SECRET}`;
 *     missing, wrong or UNCONFIGURED secret → generic 401 with NO write
 *     executed (fail-closed); comparison is constant-time (sha256 +
 *     timingSafeEqual — the cron-route model);
 *   - body ≤ 2 MB (413), ≤ 5000 data lines (413 — linoleum assortment is
 *     smaller than wallpapers; see route comment); per-line validation
 *     (width 1.5|2|2.5|3|3.5|4 м, price 10..100000, qty 0..99999 whole meters)
 *     is delegated to parseLinoleumCsv — bad lines land in `errors`
 *     (rejected) and never fail the whole file;
 *   - `X-Export-Date: YYYYMMDD` is mandatory, a real calendar date and not
 *     older than 400 days → otherwise 400;
 *   - accepted rows are APPENDED to the `linoleum_stock` staging table
 *     (migration 052, parallel agent L1) with a service-role client
 *     (persistSession: false) in chunks of ≤ 500; response 202
 *     { accepted, rejected, exportDate, errors: first 20 };
 *   - DB/infra failure → dbErrorResponse (app/lib/admin-api): unmapped
 *     errors → generic 500 { error: 'Ingest failed' }, raw DB message never
 *     leaves the server;
 *   - POST is the only exported handler (App Router answers 405 for the
 *     rest) and maxDuration is bounded at 60.
 *
 * Route behavior is loaded from the REAL route source with only the
 * untestable edges stubbed (project pattern: next/server, @supabase-js and
 * @/ aliases are not resolvable under plain node:test — see
 * wallpaper-ingest / cron-reconciliation tests). The real parseLinoleumCsv
 * and the real constant-time auth run unstubbed; the dbErrorResponse stub
 * mirrors app/lib/admin-api.ts (its 23505→409 / 23503→400 mapping is covered
 * by the admin tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = 'app/api/ingest/1c-linoleum/route.ts';
const routeSource = readFileSync(path.join(root, ROUTE), 'utf8');

process.env.LINOLEUM_INGEST_SECRET = 'test-linoleum-ingest-secret';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const parseUrl = pathToFileURL(path.join(root, 'app/lib/linoleum/parse.ts')).href;

// ---------------------------------------------------------------------------
// Static structure invariants (raw source, comments stripped)
// ---------------------------------------------------------------------------

const routeCode = routeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('LINOLEUM INGEST route: POST-only — no GET/data-export handler exists', () => {
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(routeCode, /export\s+(?:async\s+)?function\s+(GET|PUT|PATCH|DELETE)\b/);
});

test('LINOLEUM INGEST route: constant-time bearer auth against LINOLEUM_INGEST_SECRET (cron model)', () => {
  assert.match(routeCode, /LINOLEUM_INGEST_SECRET/);
  assert.match(routeCode, /createHash\('sha256'\)/);
  assert.match(routeCode, /timingSafeEqual/);
  assert.match(routeCode, /Bearer \$\{secret\}/);
  assert.doesNotMatch(routeCode, /WALLPAPER_INGEST_SECRET/, 'must use its own secret');
  assert.doesNotMatch(routeCode, /CRON_SECRET/, 'must use its own secret, not the cron one');
});

test('LINOLEUM INGEST route: limits pinned in code (2 MB body, 5000 rows, 500-row chunks, 20 errors, 400 days)', () => {
  assert.match(routeCode, /MAX_BODY_BYTES = 2 \* 1024 \* 1024/);
  assert.match(routeCode, /MAX_ROWS = 5000/);
  assert.match(routeCode, /DB_CHUNK = 500/);
  assert.match(routeCode, /ERROR_SAMPLE_LIMIT = 20/);
  assert.match(routeCode, /EXPORT_DATE_MAX_AGE_DAYS = 400/);
  assert.match(routeCode, /maxDuration = 60/);
});

test('LINOLEUM INGEST route: service-role staging write only (RLS table, insert-only, parser reused)', () => {
  assert.match(routeCode, /from '@supabase\/supabase-js'/);
  assert.match(routeCode, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(routeCode, /persistSession: false/);
  assert.match(routeCode, /from\('linoleum_stock'\)/);
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
  assert.match(routeCode, /'@\/app\/lib\/linoleum\/parse'/, 'CSV parsing delegated to the linoleum parser');
  assert.doesNotMatch(
    routeCode, /STRICT_NUMBER_RE|LINOLEUM_PRICE_SQM_MIN|LINOLEUM_QTY_M_MAX/,
    'parser internals must not be reimplemented'
  );
  // DB failures go through the shared dbErrorResponse (AGENTS.md rule).
  assert.match(routeCode, /from '@\/app\/lib\/admin-api'/);
  assert.match(routeCode, /dbErrorResponse\(/);
  assert.match(routeCode, /'Ingest failed'/, 'DB failures answer the generic fallback');
  assert.match(routeCode, /status: 202/);
  assert.match(routeCode, /status: 401/);
  assert.match(routeCode, /status: 413/);
  assert.match(routeCode, /status: 400/);
});

test('LINOLEUM INGEST route: staging row shape matches the agreed 052 columns', () => {
  for (const column of ['code:', 'name:', 'width_m:', 'price_sqm:', 'qty_m:', 'export_date:']) {
    assert.ok(routeCode.includes(column), `staging row must map ${column}`);
  }
});

// ---------------------------------------------------------------------------
// Runtime harness: real route source, stubbed next/server + supabase client
// ---------------------------------------------------------------------------

interface IngestTestGlobal {
  /** One entry per createClient() call: [url, serviceKey, options]. */
  __ingestClientCalls?: unknown[][];
  __ingestTables?: string[];
  __ingestInserts?: unknown[][];
  __ingestInsertError?: { message: string; code?: string | null } | null;
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
  widthM: number;
  priceSqm: number;
  qtyM: number;
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
      /import\s*\{[^}]*\}\s*from\s*'@\/app\/lib\/linoleum\/parse';/,
      `const { parseLinoleumCsv } = await import('${parseUrl}');
type CsvError = { line: number; reason: string };
type LinoleumRow = { code: string; name: string; widthM: number; priceSqm: number; qtyM: number };`
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
    )
    .replace(
      /import\s*\{\s*dbErrorResponse\s*\}\s*from\s*'@\/app\/lib\/admin-api';/,
      // Faithful mirror of app/lib/admin-api.ts dbErrorResponse (the real
      // module pulls next/headers + @supabase/ssr — untestable under plain
      // node:test; the mapping itself is covered by the admin tests).
      `const dbErrorResponse = (
        error: { message?: string; code?: string | null } | null | undefined,
        fallbackMessage: string
      ) => {
        if (!error) {
          return NextResponse.json({ error: fallbackMessage }, { status: 500 });
        }
        if (error.code === '23505') {
          return NextResponse.json({ error: 'duplicate (409 branch)' }, { status: 409 });
        }
        if (error.code === '23503') {
          return NextResponse.json({ error: 'fk (400 branch)' }, { status: 400 });
        }
        return NextResponse.json({ error: fallbackMessage }, { status: 500 });
      };`
    );
  assert.ok(!rewritten.includes("'next/server'"), 'harness drift: next/server import not stubbed');
  assert.ok(!rewritten.includes("'@supabase/supabase-js'"), 'harness drift: supabase import not stubbed');
  assert.ok(!rewritten.includes("'@/app/lib/"), 'harness drift: @/ alias import not stubbed');
  const dir = mkdtempSync(path.join(tmpdir(), 'linoleum-ingest-'));
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

const HEADER = 'code;name;width_m;price_sqm;qty_m';

function dataRow(code: string, price: string | number = 250, qty: string | number = 5): string {
  return `${code};Лінолеум ${code}, 2,5м;2,5;${price};${qty}`;
}

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/ingest/1c-linoleum', {
    method: 'POST',
    headers: { 'content-type': 'text/csv', ...headers },
    body,
  });
}

const authed = (body: string, headers: Record<string, string> = {}): Request =>
  makeRequest(body, {
    authorization: 'Bearer test-linoleum-ingest-secret',
    'x-export-date': TODAY,
    ...headers,
  });

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runtime: auth (fail-closed)
// ---------------------------------------------------------------------------

test('LINOLEUM INGEST: 401 without Authorization header, nothing written', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const res = await POST(makeRequest(HEADER));
  assert.equal(res.status, 401);
  assert.deepEqual(await jsonBody(res), { error: 'Unauthorized' });
  assert.equal(g.__ingestClientCalls!.length, 0, 'no DB client must be created');
});

test('LINOLEUM INGEST: 401 with a wrong bearer, nothing written', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const res = await POST(authed(HEADER, { authorization: 'Bearer wrong-secret' }));
  assert.equal(res.status, 401);
  assert.equal(g.__ingestClientCalls!.length, 0);
});

test('LINOLEUM INGEST: 401 fail-closed when LINOLEUM_INGEST_SECRET is not configured at all', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const saved = process.env.LINOLEUM_INGEST_SECRET;
  delete process.env.LINOLEUM_INGEST_SECRET;
  try {
    const res = await POST(authed(HEADER));
    assert.equal(res.status, 401);
    assert.equal(g.__ingestClientCalls!.length, 0);
  } finally {
    process.env.LINOLEUM_INGEST_SECRET = saved;
  }
});

// ---------------------------------------------------------------------------
// Runtime: happy path
// ---------------------------------------------------------------------------

test('LINOLEUM INGEST: valid CSV (BOM + header) → 202, rows staged with export_date, service-role client', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const body = `\uFEFF${HEADER}\nL-100;Лінолеум Форум;2,5;350,50;40\nL-200;Лінолеум Тарко;3;410;0\n`;
  const res = await POST(authed(body));
  assert.equal(res.status, 202);
  const json = await jsonBody(res);
  const isoDate = `${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}`;
  assert.deepEqual(json, {
    accepted: 2,
    rejected: 0,
    exportDate: isoDate,
    errors: [],
  });
  // service-role client, no session persistence (one client per request)
  const clientCalls = g.__ingestClientCalls!;
  assert.equal(clientCalls.length, 1);
  assert.deepEqual(clientCalls[0]![2], { auth: { persistSession: false } });
  // single chunk into the staging table
  assert.deepEqual(g.__ingestTables, ['linoleum_stock']);
  const inserts = g.__ingestInserts!;
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0], [
    { code: 'L-100', name: 'Лінолеум Форум', width_m: 2.5, price_sqm: 350.5, qty_m: 40, export_date: isoDate },
    { code: 'L-200', name: 'Лінолеум Тарко', width_m: 3, price_sqm: 410, qty_m: 0, export_date: isoDate },
  ]);
});

test('LINOLEUM INGEST: staging is append-only — chunks never exceed 500 rows', async () => {
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

test('LINOLEUM INGEST: header-only file → 202 accepted 0, zero DB writes', async () => {
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

test('LINOLEUM INGEST: a line with width outside the set → rejected, the rest accepted', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const body = `${HEADER}\nL-100;Лінолеум Форум;2,5;350,50;40\nL-999;Крива ширина;1,8;250;5\n`;
  const res = await POST(authed(body));
  assert.equal(res.status, 202, 'rejected lines never fail the file');
  const json = await jsonBody(res);
  assert.equal(json.accepted, 1);
  assert.equal(json.rejected, 1);
  const errors = json.errors as CsvErrorLike[];
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 3);
  assert.match(errors[0]!.reason, /width_m/);
  assert.equal(g.__ingestInserts![0]!.length, 1, 'only valid rows reach staging');
});

test('LINOLEUM INGEST: 25 bad lines → rejected=25, only the first 20 errors returned', async () => {
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

test('LINOLEUM INGEST: missing / malformed X-Export-Date → 400', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const body = `${HEADER}\n${dataRow('L-100')}\n`;
  // Built manually: authed() would inject the default TODAY export date.
  const bearerOnly = (extra: Record<string, string> = {}): Request =>
    makeRequest(body, { authorization: 'Bearer test-linoleum-ingest-secret', ...extra });
  for (const date of [undefined, '', '2026091', '2026-09-17', '20261332', '00000000', 'abcdefghi']) {
    const res = await POST(bearerOnly(date === undefined ? {} : { 'x-export-date': date }));
    assert.equal(res.status, 400, `expected 400 for x-export-date=${String(date)}`);
    assert.deepEqual(await jsonBody(res), { error: 'Invalid X-Export-Date' });
  }
  assert.equal(g.__ingestInserts!.length, 0, 'nothing written on invalid export date');
});

test('LINOLEUM INGEST: export date older than 400 days → 400; inside the window → 202', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const body = `${HEADER}\n${dataRow('L-100')}\n`;
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

test('LINOLEUM INGEST: body > 2 MB → 413, nothing written', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const huge = `${HEADER}\n${'x'.repeat(2 * 1024 * 1024 + 1)}`;
  const res = await POST(authed(huge));
  assert.equal(res.status, 413);
  assert.deepEqual(await jsonBody(res), { error: 'Payload too large' });
  assert.equal(g.__ingestClientCalls!.length, 0, 'no DB client for oversized uploads');
});

test('LINOLEUM INGEST: 5001 data rows → 413; 5000 data rows → 202 (boundary)', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  const tooMany = Array.from({ length: 5001 }, (_, i) => dataRow(String(i + 1).padStart(6, '0')));
  const resTooMany = await POST(authed(`${HEADER}\n${tooMany.join('\n')}\n`));
  assert.equal(resTooMany.status, 413);
  assert.deepEqual(await jsonBody(resTooMany), { error: 'Too many rows' });

  resetFakes();
  const atLimit = Array.from({ length: 5000 }, (_, i) => dataRow(String(i + 1).padStart(6, '0')));
  const resAtLimit = await POST(authed(`${HEADER}\n${atLimit.join('\n')}\n`));
  assert.equal(resAtLimit.status, 202);
  assert.equal((await jsonBody(resAtLimit)).accepted, 5000);
  assert.deepEqual(
    g.__ingestInserts!.map((c) => c.length),
    [500, 500, 500, 500, 500, 500, 500, 500, 500, 500]
  );
});

// ---------------------------------------------------------------------------
// Runtime: DB failure → dbErrorResponse (generic 500 without internals)
// ---------------------------------------------------------------------------

test('LINOLEUM INGEST: staging insert failure → 500 { error: Ingest failed }, no internals leaked', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  g.__ingestInsertError = {
    message: 'duplicate key value violates unique constraint "boom"',
    code: null,
  };
  try {
    const res = await POST(authed(`${HEADER}\n${dataRow('L-100')}\n`));
    assert.equal(res.status, 500);
    const json = await jsonBody(res);
    assert.deepEqual(Object.keys(json), ['error']);
    assert.equal(json.error, 'Ingest failed');
    assert.ok(!JSON.stringify(json).includes('duplicate key'), 'DB internals must not leak');
  } finally {
    g.__ingestInsertError = null;
  }
});

test('LINOLEUM INGEST: storage client init failure (e.g. missing env) → 500, fail-closed', async () => {
  const { POST } = await loadRoute();
  resetFakes();
  g.__ingestClientThrow = true;
  try {
    const res = await POST(authed(`${HEADER}\n${dataRow('L-100')}\n`));
    assert.equal(res.status, 500);
    assert.deepEqual(await jsonBody(res), { error: 'Ingest failed' });
  } finally {
    g.__ingestClientThrow = false;
  }
});

// ---------------------------------------------------------------------------
// Unit: validateIngestPayload (exported pure helper)
// ---------------------------------------------------------------------------

test('LINOLEUM INGEST helper: ok payload carries parsed rows + exportDate ISO', async () => {
  const { validateIngestPayload } = await loadRoute();
  assert.ok(validateIngestPayload, 'validateIngestPayload must be exported for tests');
  const out = validateIngestPayload!(
    `\uFEFF${HEADER}\nL-100;Лінолеум Форум;2,5;350,50;40\n`,
    { exportDate: TODAY }
  );
  assert.equal(out.ok, true);
  assert.ok(out.ok && out.rows.length === 1);
  const row = out.rows[0]!;
  assert.equal(row.code, 'L-100');
  assert.equal(row.widthM, 2.5);
  assert.equal(row.priceSqm, 350.5);
  assert.equal(row.qtyM, 40);
  assert.equal(out.ok && out.exportDate, `${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}`);
});

test('LINOLEUM INGEST helper: 400/413 branches', async () => {
  const { validateIngestPayload } = await loadRoute();
  const noDate = validateIngestPayload!(dataRow('L-100'), {});
  assert.deepEqual(noDate, { ok: false, status: 400, error: 'Invalid X-Export-Date' });

  const badDate = validateIngestPayload!(dataRow('L-100'), { exportDate: '2026091' });
  assert.equal(badDate.ok, false);
  assert.ok(!badDate.ok && badDate.status === 400);

  const oldDate = validateIngestPayload!(dataRow('L-100'), { exportDate: TOO_OLD });
  assert.ok(!oldDate.ok && oldDate.status === 400 && oldDate.error === 'X-Export-Date is too old');

  const huge = validateIngestPayload!('x'.repeat(2 * 1024 * 1024 + 1), { exportDate: TODAY });
  assert.ok(!huge.ok && huge.status === 413);

  const tooManyRows = validateIngestPayload!(
    Array.from({ length: 5001 }, (_, i) => dataRow(String(i + 1))).join('\n'),
    { exportDate: TODAY }
  );
  assert.ok(!tooManyRows.ok && tooManyRows.status === 413 && tooManyRows.error === 'Too many rows');

  // Boundary: exactly 5000 data lines (no header) passes.
  const atLimit = validateIngestPayload!(
    Array.from({ length: 5000 }, (_, i) => dataRow(String(i + 1))).join('\n'),
    { exportDate: TODAY }
  );
  assert.ok(atLimit.ok && atLimit.rows.length === 5000);
});
