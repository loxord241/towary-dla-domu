/**
 * GET /api/cron/linoleum-freshness — daily freshness check of the 1С
 * linoleum stock channel (linoleum import, staging migration 052).
 *
 * The owner's PC exports the 1С stock file DAILY into the `linoleum_stock`
 * staging table (via /api/ingest/1c-linoleum). This cron closes the
 * "channel silently died" gap: it reads max(export_date) from staging and
 * alerts the owner's Telegram channel when
 *   - staging has 0 rows (no file has EVER arrived), or
 *   - the freshest export_date is older than 26 h (a missed daily export).
 *
 * Security model (app/api/cron/wallpaper-freshness/route.ts):
 *   - bearer-token only: `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron
 *     sends exactly this header when CRON_SECRET is configured for the
 *     project. Missing/mismatching/unconfigured secret → generic 401 with
 *     NO read executed (fail-closed). Comparison is constant-time (sha256 +
 *     timingSafeEqual), so no timing/length oracle.
 *   - strictly read-only: one SELECT on the service-role client; nothing is
 *     written — the freshness check never touches products or any other
 *     table.
 *
 * Response contract: ANY successfully read state answers 200 with a JSON
 * summary { ok: true, lastExportDate, stale, notified } — stale:true with
 * notified:false (Telegram down/disabled) is still a successful check, only
 * the alert delivery failed. Only infrastructure failures (missing service
 * env, DB read error) answer 500 { error: 'Freshness check failed' } with no
 * internals. sendTelegramText is never-throw by contract; the call is still
 * wrapped as defense in depth so an alerting bug cannot degrade the summary.
 */

import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { sendTelegramText } from '@/app/lib/notifications/telegram';

// One paged staging read + a best-effort Telegram fan-out (≤4 s per
// recipient) — a small, strictly bounded workload.
export const maxDuration = 30;

/** A daily channel; >26 h without a file means it is down. */
const STALE_AFTER_HOURS = 26;
const HOUR_MS = 60 * 60 * 1000;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false; // unset CRON_SECRET → fail-closed 401
  const header = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let lastExportDate: string | null;
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      throw new Error('service client unavailable');
    }
    const client = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });
    // max(export_date) — the freshest daily export ever ingested (staging is
    // append-only, migration 052; RLS on, service role only).
    const { data, error } = await client
      .from('linoleum_stock')
      .select('export_date')
      .order('export_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    lastExportDate =
      typeof data?.export_date === 'string' && data.export_date.trim() !== ''
        ? data.export_date.trim()
        : null;
  } catch (error) {
    console.error(
      'cron linoleum freshness failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json({ error: 'Freshness check failed' }, { status: 500 });
  }

  // export_date is a calendar DATE — age is measured from its UTC midnight;
  // an empty staging (null) is stale by definition.
  const lastMs =
    lastExportDate === null ? Number.NaN : Date.parse(`${lastExportDate}T00:00:00Z`);
  const ageHours = Number.isFinite(lastMs)
    ? (Date.now() - lastMs) / HOUR_MS
    : Number.POSITIVE_INFINITY;
  const stale = !(ageHours <= STALE_AFTER_HOURS);

  let notified = false;
  if (stale) {
    const text = `Linoleum sync: файл из 1С не поступал более 26 ч (последний: ${lastExportDate ?? '—'})`;
    try {
      const result = await sendTelegramText(text);
      notified = result.sent;
    } catch (error) {
      console.error(
        'cron linoleum freshness telegram failed:',
        error instanceof Error ? error.name : 'unknown'
      );
      notified = false;
    }
  }

  return NextResponse.json({ ok: true, lastExportDate, stale, notified });
}
