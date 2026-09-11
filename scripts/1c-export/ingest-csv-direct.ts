#!/usr/bin/env node
/**
 * One-off (2026-09-11): direct-DB twin of POST /api/ingest/1c-wallpaper.
 *
 * Why: Vercel answers towary-dla-domu.com with a Security Checkpoint
 * challenge (HTTP 429, `x-vercel-mitigated: challenge`) for non-browser
 * clients, so the documented curl channel cannot reach the route. This
 * script replicates the handler app/api/ingest/1c-wallpaper/route.ts
 * EXACTLY against the same staging table (`wallpaper_stock`, migration 041),
 * appends-only:
 *   - the SAME parser (app/lib/wallpapers/parse.ts, parseWallpaperCsv):
 *     per-line validation, price 0..100000, qty 0..9999, bad lines → errors
 *     (they never fail the whole file);
 *   - `--export-date YYYYMMDD` validated like the X-Export-Date header
 *     (real calendar date, ≤ 400 days old);
 *   - inserts {code, name, price_retail, qty, export_date} in chunks of 500
 *     with the service-role client (.env.local loader — same contract as
 *     scripts/wallpaper-import.ts);
 *   - prints the same 202-shaped summary: {accepted, rejected, exportDate,
 *     errors: first 20}.
 *
 * Usage:
 *   node scripts/1c-export/ingest-csv-direct.ts data/20260911-wallpapers.csv --export-date 20260911
 *
 * When the Vercel challenge is lifted, prefer the HTTP channel (curl) and
 * delete or archive this script.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { parseWallpaperCsv, type CsvError } from '../../app/lib/wallpapers/parse.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** .env.local loader (same contract as scripts/wallpaper-import.ts). */
function loadEnvLocal(): void {
  try {
    for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (
        match &&
        match[1] !== undefined &&
        match[2] !== undefined &&
        process.env[match[1]] === undefined
      ) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // env vars can come from the shell too
  }
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // route: body ≤ 2 MB
const MAX_ROWS = 2000; // route: ≤ 2000 data lines
const DB_CHUNK = 500; // route: insert chunk size
const ERROR_SAMPLE_LIMIT = 20;
const EXPORT_DATE_MAX_AGE_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYYMMDD` → `YYYY-MM-DD` (a real calendar date), otherwise null. */
function parseExportDate(raw: string): string | null {
  if (!/^\d{8}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

async function main(): Promise<void> {
  const [csvPath, dateFlag] = process.argv.slice(2);
  if (!csvPath || dateFlag !== '--export-date' || process.argv[4] === undefined) {
    console.error('usage: ingest-csv-direct.ts <file.csv> --export-date YYYYMMDD');
    process.exit(1);
  }
  const exportDate = parseExportDate(process.argv[4] ?? '');
  if (!exportDate) {
    console.error(JSON.stringify({ error: 'Invalid X-Export-Date' }));
    process.exit(1);
  }
  const ageDays = (Date.now() - new Date(`${exportDate}T00:00:00Z`).getTime()) / DAY_MS;
  if (ageDays > EXPORT_DATE_MAX_AGE_DAYS) {
    console.error(JSON.stringify({ error: 'X-Export-Date is too old' }));
    process.exit(1);
  }

  const body = readFileSync(path.resolve(csvPath), 'utf8');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    console.error(JSON.stringify({ error: 'Payload too large' }));
    process.exit(1);
  }

  const { rows, errors } = parseWallpaperCsv(body);
  if (rows.length + errors.length > MAX_ROWS) {
    console.error(JSON.stringify({ error: 'Too many rows' }));
    process.exit(1);
  }

  loadEnvLocal();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    console.error(JSON.stringify({ error: 'ingest storage is not configured' }));
    process.exit(1);
  }
  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const stagingRows = rows.map((row) => ({
    code: row.code,
    name: row.name,
    price_retail: row.priceRetail,
    qty: row.qty,
    export_date: exportDate,
  }));
  for (let i = 0; i < stagingRows.length; i += DB_CHUNK) {
    const chunk = stagingRows.slice(i, i + DB_CHUNK);
    const { error } = await client.from('wallpaper_stock').insert(chunk);
    if (error) {
      console.error(JSON.stringify({ error: `Ingest failed: ${error.message}` }));
      process.exit(1);
    }
  }

  const sample: CsvError[] = errors.slice(0, ERROR_SAMPLE_LIMIT);
  console.log(
    JSON.stringify(
      { accepted: rows.length, rejected: errors.length, exportDate, errors: sample },
      null,
      1
    )
  );
}

main().catch((error: unknown) => {
  console.error(
    'ingest-csv-direct failed:',
    error instanceof Error ? error.message : 'unknown error'
  );
  process.exit(1);
});
