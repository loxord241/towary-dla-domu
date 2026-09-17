/**
 * POST /api/ingest/1c-linoleum — daily 1C linoleum stock ingest
 * (linoleum vertical, batch 1; task L2, 2026-09-17). Structurally a mirror
 * of POST /api/ingest/1c-wallpaper with its own CSV contract and secret.
 *
 * Channel: a converter script (xls→CSV, to come later) transforms the
 * owner's 1C linoleum export and POSTs the CSV here; accepted rows are
 * APPENDED to the `linoleum_stock` staging table (migration 052 — written
 * by the parallel L1 agent; schema agreed in the task) with a service-role
 * client. Nothing else is written: a future storefront importer reads the
 * freshest row per code from staging (`DISTINCT ON (code) ... ORDER BY
 * code, export_date DESC`), same as wallpapers.
 *
 * CSV contract (`code;name;width_m;price_sqm;qty_m`, optional header,
 * BOM/CRLF tolerated): width_m ∈ {1.5, 2, 2.5, 3, 4} strictly; price
 * 10..100000 грн/м² and qty 0..99999 whole running meters are sanity
 * windows enforced PER LINE by parseLinoleumCsv — bad lines land in
 * `errors` (rejected), they never fail the whole file; duplicate codes are
 * NOT deduplicated (import-plan layer decides, like wallpapers).
 *
 * Security model (mirror of app/api/ingest/1c-wallpaper/route.ts):
 *   - bearer-token only against LINOLEUM_INGEST_SECRET; missing/mismatching/
 *     UNCONFIGURED secret → generic 401 with NO write executed
 *     (fail-closed). Comparison is constant-time (sha256 + timingSafeEqual),
 *     so there is no timing/length oracle. The secret is never echoed back.
 *   - staging is RLS-enabled with no policies + explicit REVOKE SELECT
 *     (migration 052, 041-pattern): only service role reads/writes it, and
 *     the key lives strictly server-side.
 *
 * Limits:
 *   - body ≤ 2 MB — checked via Content-Length before buffering (chunked
 *     bodies fall through to the actual UTF-8 byte-length check) → 413;
 *   - ≤ 5000 data lines (parsed rows + per-line errors; the optional header
 *     line is not counted) → 413. Wallpaper caps at 2000 (~4x its expected
 *     ~534 rows); linoleum expects a few hundred SKUs but a design can
 *     appear once per width (up to 5 lines), so 5000 keeps ~10x headroom
 *     for the first dirty exports without letting a broken export hammer
 *     the DB; the 2 MB body cap stays the binding physical limit;
 *   - `X-Export-Date: YYYYMMDD` is mandatory, must be a real calendar date
 *     and no older than 400 days → otherwise 400.
 *
 * Content-Type is deliberately NOT enforced (same reason as wallpapers:
 * a hard 415 would break the channel on its first run). Anything that is
 * not valid CSV already fails per-line in the parser (a 202 with
 * rejected > 0).
 *
 * Responses: 202 { accepted, rejected, exportDate, errors: first 20 };
 * 401/400/413 as above; DB/infra failures go through the shared
 * dbErrorResponse (app/lib/admin-api.ts): unmapped errors → generic
 * 500 { error: 'Ingest failed' } — the raw DB message is logged
 * server-side only, never returned to the client. Other HTTP methods →
 * 405: only POST is exported and the App Router answers 405 automatically
 * for unimplemented methods.
 */

import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { parseLinoleumCsv, type CsvError, type LinoleumRow } from '@/app/lib/linoleum/parse';
import { dbErrorResponse } from '@/app/lib/admin-api';

export const maxDuration = 60;

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ROWS = 5000;
const DB_CHUNK = 500;
const ERROR_SAMPLE_LIMIT = 20;
const EXPORT_DATE_MAX_AGE_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

function ingestAuthorized(request: Request): boolean {
  const secret = process.env.LINOLEUM_INGEST_SECRET?.trim();
  if (!secret) return false; // unset LINOLEUM_INGEST_SECRET → fail-closed 401
  const header = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const EXPORT_DATE_RE = /^\d{8}$/;

/** `YYYYMMDD` → `YYYY-MM-DD` (a real calendar date), otherwise null. */
function parseExportDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!EXPORT_DATE_RE.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export type IngestPayloadValidation =
  | { ok: true; exportDate: string; rows: LinoleumRow[]; errors: CsvError[] }
  | { ok: false; status: number; error: string };

/**
 * Pure request validation + CSV parse (no auth, no DB): size limits,
 * export-date freshness and the per-line CSV contract. Exported for tests;
 * the route handler composes it with auth and the staging write.
 */
export function validateIngestPayload(
  body: string,
  headers: { exportDate?: string | null }
): IngestPayloadValidation {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Payload too large' };
  }

  const exportDate = parseExportDate(headers.exportDate);
  if (!exportDate) {
    return { ok: false, status: 400, error: 'Invalid X-Export-Date' };
  }
  const ageDays =
    (Date.now() - new Date(`${exportDate}T00:00:00Z`).getTime()) / DAY_MS;
  if (ageDays > EXPORT_DATE_MAX_AGE_DAYS) {
    return { ok: false, status: 400, error: 'X-Export-Date is too old' };
  }

  const { rows, errors } = parseLinoleumCsv(body);
  if (rows.length + errors.length > MAX_ROWS) {
    return { ok: false, status: 413, error: 'Too many rows' };
  }

  return { ok: true, exportDate, rows, errors };
}

function getStagingClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('ingest storage is not configured');
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

export async function POST(request: Request): Promise<Response> {
  if (!ingestAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Reject oversized uploads before buffering the body when the client
  // declares its size (Content-Length is set by typical HTTP clients).
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const validation = validateIngestPayload(body, {
    exportDate: request.headers.get('x-export-date'),
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: validation.status });
  }

  try {
    const client = getStagingClient();
    const stagingRows = validation.rows.map((row) => ({
      code: row.code,
      name: row.name,
      width_m: row.widthM,
      price_sqm: row.priceSqm,
      qty_m: row.qtyM,
      export_date: validation.exportDate,
    }));
    for (let i = 0; i < stagingRows.length; i += DB_CHUNK) {
      const chunk = stagingRows.slice(i, i + DB_CHUNK);
      const { error } = await client.from('linoleum_stock').insert(chunk);
      if (error) return dbErrorResponse(error, 'Ingest failed');
    }
  } catch (error) {
    // Client-init/infra failure: dbErrorResponse logs it server-side and
    // answers the generic 500 — raw internals never reach the client.
    return dbErrorResponse(error instanceof Error ? error : null, 'Ingest failed');
  }

  return NextResponse.json(
    {
      accepted: validation.rows.length,
      rejected: validation.errors.length,
      exportDate: validation.exportDate,
      errors: validation.errors.slice(0, ERROR_SAMPLE_LIMIT),
    },
    { status: 202 }
  );
}
