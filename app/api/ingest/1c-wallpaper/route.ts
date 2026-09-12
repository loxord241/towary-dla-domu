/**
 * POST /api/ingest/1c-wallpaper — daily 1C 7.7 wallpaper stock ingest
 * (wallpapers import, Task 5; spec §3/§6:
 * docs/superpowers/specs/2026-09-10-wallpapers-import-design.md).
 *
 * Channel (2026-09-11): the ORCHESTRATOR converts the owner's manual 1C 7.7
 * Excel export (scripts/1c-export/xls-report-to-ingest-csv.py — owner decided
 * on 2026-09-10 to export Excel by hand instead of VBS automation) and POSTs
 * the CSV here; see «Синк шпалер 1С» in AGENTS.md. The retired VBS channel
 * (scripts/1c-export/slav-oboi-export.vbs) used the same contract: text/csv
 * (`code;name;article;unit;price_retail;qty`, optional header line, BOM and
 * CRLF tolerated) with `Authorization: Bearer ${WALLPAPER_INGEST_SECRET}` and
 * `X-Export-Date: YYYYMMDD`. The endpoint validates the payload and APPENDS
 * the rows to the `wallpaper_stock` staging table (migration 041) with a
 * service-role client. Nothing else is written: the storefront importer
 * (Task 6/7) reads the freshest row per code from staging
 * (`DISTINCT ON (code) ... ORDER BY code, export_date DESC`).
 *
 * Security model (cron-route pattern, app/api/cron/reconciliation/route.ts):
 *   - bearer-token only; missing/mismatching/UNCONFIGURED secret → generic
 *     401 with NO write executed (fail-closed). Comparison is constant-time
 *     (sha256 + timingSafeEqual), so there is no timing/length oracle. The
 *     secret is never echoed back anywhere.
 *   - staging is RLS-enabled with no policies + explicit REVOKE SELECT
 *     (migration 041): only service role reads/writes it, and the key lives
 *     strictly server-side.
 *
 * Limits (spec §6 sanity: expected volume ~534±50 rows):
 *   - body ≤ 2 MB — checked via Content-Length before buffering (chunked
 *     bodies fall through to the actual UTF-8 byte-length check) → 413;
 *   - ≤ 2000 data lines (parsed rows + per-line errors; the optional header
 *     line is not counted) → 413;
 *   - price 50..5000 and qty 0..999 (spec sanity windows) are enforced PER LINE by
 *     parseWallpaperCsv — bad lines land in `errors` (rejected), they never
 *     fail the whole file;
 *   - `X-Export-Date: YYYYMMDD` is mandatory, must be a real calendar date
 *     and no older than 400 days → otherwise 400.
 *
 * Content-Type is deliberately NOT enforced: MSXML2.ServerXMLHTTP sends a
 * string body without a Content-Type header unless the VBS sets one
 * explicitly, and a hard 415 would break the channel on its first run.
 * Anything that is not valid CSV already fails per-line in the parser (a 202
 * with rejected > 0), which the freshness cron (Task 9) surfaces.
 *
 * Responses: 202 { accepted, rejected, exportDate, errors: first 20 };
 * 401/400/413 as above; any DB/infra failure → 500 { error: 'Ingest failed' }
 * with no internals. Other HTTP methods → 405: only POST is exported and the
 * App Router answers 405 automatically for unimplemented methods.
 */

import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { parseWallpaperCsv, type CsvError, type WallpaperRow } from '@/app/lib/wallpapers/parse';

export const maxDuration = 60;

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ROWS = 2000;
const DB_CHUNK = 500;
const ERROR_SAMPLE_LIMIT = 20;
const EXPORT_DATE_MAX_AGE_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

function ingestAuthorized(request: Request): boolean {
  const secret = process.env.WALLPAPER_INGEST_SECRET?.trim();
  if (!secret) return false; // unset WALLPAPER_INGEST_SECRET → fail-closed 401
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
  | { ok: true; exportDate: string; rows: WallpaperRow[]; errors: CsvError[] }
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

  const { rows, errors } = parseWallpaperCsv(body);
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
  // declares its size (Content-Length is set for the VBS string body).
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
      price_retail: row.priceRetail,
      qty: row.qty,
      export_date: validation.exportDate,
    }));
    for (let i = 0; i < stagingRows.length; i += DB_CHUNK) {
      const chunk = stagingRows.slice(i, i + DB_CHUNK);
      const { error } = await client.from('wallpaper_stock').insert(chunk);
      if (error) throw new Error(`staging insert failed: ${error.message}`);
    }
  } catch (error) {
    console.error(
      'wallpaper ingest failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json({ error: 'Ingest failed' }, { status: 500 });
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
