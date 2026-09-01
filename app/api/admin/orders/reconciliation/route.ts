import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';
import {
  classifyReconcileRow,
  findDuplicatePaymentIdGroups,
} from '@/app/lib/payment/reconciliation';
import { fetchLiqPayProviderStatus } from '@/app/lib/payment/liqpay-status-api';

/**
 * GET /api/admin/orders/reconciliation — READ-ONLY LiqPay ↔ DB audit report.
 *
 * Security model:
 *   - the ONLY verb; POST/PATCH/PUT/DELETE handlers do not exist here;
 *   - requireAdminApi() gates every execution path (401 without a valid
 *     user session, 403 without an admin_users row) BEFORE any DB access;
 *   - strictly read-only: SELECTs only; no .insert/.update/.upsert/.delete/
 *     .rpc anywhere in this file; provider calls are action=status only;
 *   - keys are read inside the shared helper for signing and are never
 *     returned or logged.
 *
 * Data minimization:
 *   - orders are projected onto a non-PII whitelist of bookkeeping columns
 *     (no contact/columns beyond them are ever selected, so they cannot
 *     leak into responses);
 *   - the response contains derived facts only (classifications + minimal
 *     order fields), never the raw provider payload.
 *
 * Performance contract (NOT real-time monitoring):
 *   - this endpoint exists for an admin clicking "check now"; there is NO
 *     cron/background automation behind it;
 *   - work is bounded: keyset pagination on created_at (no offset), a small
 *     window (DEFAULT_DAYS, cap 90) and row cap MAX_LIMIT;
 *   - Status API calls run sequentially with THROTTLE_MS pacing between
 *     them — worst case is roughly (limit x throttle) ≈ (100 x 200ms)=20s,
 *     so keep windows/limits small in practice.
 */

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const THROTTLE_MS = 200;

/**
 * Explicit non-PII whitelist. Classifier needs the reconciliation subset;
 * paid_at/payment_method enrich the admin report. Adding any contact or
 * address column here is FORBIDDEN by the data-minimization invariant tests.
 */
const ORDER_COLUMNS =
  'order_number, status, payment_status, total_amount, currency, ' +
  'liqpay_order_id, liqpay_payment_id, paid_at, payment_method, ' +
  'expires_at, created_at';

interface ReconciliationOrderRow {
  order_number: string;
  liqpay_order_id: string | null;
  liqpay_payment_id: number | string | null;
  payment_status: string;
  total_amount: number | string;
  currency: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  paid_at: string | null;
  payment_method: string | null;
}

function clampInt(raw: string | null, fallback: number, max: number, min: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** ISO timestamp or null; used only as a filter value, never interpolated. */
function parseIso(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);

  const toParam = parseIso(searchParams.get('to'));
  let from = parseIso(searchParams.get('from'));
  if (!toParam && !from) {
    const days = clampInt(searchParams.get('days'), DEFAULT_DAYS, MAX_DAYS, 1);
    from = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  }
  // Explicit pairs must make sense (both set); otherwise fall back to days.
  if (toParam && !from) {
    const days = clampInt(searchParams.get('days'), DEFAULT_DAYS, MAX_DAYS, 1);
    from = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  }
  const limit = clampInt(searchParams.get('limit'), DEFAULT_LIMIT, MAX_LIMIT, 1);

  try {
    // Bounded keyset scan over created_at — deterministic order, no offsets.
    const rows: ReconciliationOrderRow[] = [];
    let cursor: { createdAt: string; orderNumber: string } | null = null;
    while (rows.length < limit) {
      let q = ctx.serviceClient
        .from('orders')
        .select(ORDER_COLUMNS)
        .not('liqpay_order_id', 'is', null)
        .gte('created_at', from!)
        .order('created_at')
        .order('order_number');
      if (toParam) q = q.lte('created_at', toParam);
      // Composite keyset cursor: order_number is UNIQUE (idx_orders_order_number),
      // so (created_at, order_number) is a total order. A plain gt(created_at)
      // skips the tail of any same-timestamp group straddling the page boundary.
      if (cursor) {
        q = q.or(
          `created_at.gt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",order_number.gt."${cursor.orderNumber}")`
        );
      }
      const batch = Math.min(50, limit - rows.length);
      const { data, error } = await q.limit(batch);
      if (error) {
        // Response construction only — reconciliation logic is untouched.
        console.error('admin reconciliation rows failed:', error.message);
        return NextResponse.json(
          { error: 'Внутрішня помилка сервера' },
          { status: 500 }
        );
      }
      const chunk = (data ?? []) as unknown as ReconciliationOrderRow[];
      if (chunk.length === 0) break;
      rows.push(...chunk);
      const last = chunk[chunk.length - 1];
      cursor = { createdAt: last.created_at, orderNumber: last.order_number };
    }

    // Sequential, throttled Status lookups; per-order failures degrade to
    // UNREACHABLE (classifier sees null), never abort the whole report.
    type ClassifiedItem = Record<string, unknown> & { classification: string };
    const items: ClassifiedItem[] = [];
    let first = true;
    for (const row of rows) {
      if (!first) await new Promise((r) => setTimeout(r, THROTTLE_MS));
      first = false;

      const provider = row.liqpay_order_id
        ? await fetchLiqPayProviderStatus(row.liqpay_order_id)
        : null;
      const classification = classifyReconcileRow(
        {
          order_number: row.order_number,
          liqpay_order_id: row.liqpay_order_id,
          liqpay_payment_id: row.liqpay_payment_id,
          payment_status: row.payment_status,
          amount: row.total_amount,
          currency: row.currency,
          status: row.status,
          expires_at: row.expires_at,
          created_at: row.created_at,
        },
        provider ?? null
      );

      items.push({
        order_number: row.order_number,
        created_at: row.created_at,
        status: row.status,
        payment_status: row.payment_status,
        amount: row.total_amount,
        currency: row.currency,
        liqpay_order_id: row.liqpay_order_id,
        liqpay_payment_id: row.liqpay_payment_id,
        paid_at: row.paid_at,
        payment_method: row.payment_method,
        provider_status:
          provider && typeof provider.status === 'string' ? provider.status : null,
        classification,
      });
    }

    const duplicates = findDuplicatePaymentIdGroups(rows.map((r) => ({
      order_number: r.order_number,
      liqpay_order_id: r.liqpay_order_id ?? '',
      liqpay_payment_id: r.liqpay_payment_id,
      payment_status: r.payment_status,
      amount: r.total_amount,
      currency: r.currency,
      status: r.status,
      expires_at: r.expires_at,
      created_at: r.created_at,
    })));

    const ALL_CLASSES = [
      'OK_OK',
      'PROVIDER_SUCCESS_DB_NOT_PAID',
      'DB_PAID_PROVIDER_NOT_SUCCESS',
      'AMOUNT_MISMATCH',
      'CURRENCY_MISMATCH',
      'PAID_MISSING_PAYMENT_ID',
      'STALE_ATTEMPT',
      'PROVIDER_NOT_FOUND',
      'UNREACHABLE',
    ] as const;
    const summary: Record<string, number> = {};
    for (const c of ALL_CLASSES) summary[c] = 0;
    for (const item of items) {
      summary[item.classification] = (summary[item.classification] ?? 0) + 1;
    }

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      window_from: from,
      window_to: toParam,
      checked: items.length,
      summary,
      findings: items.filter((i) => i.classification !== 'OK_OK'),
      duplicate_payment_ids: duplicates,
      readonly: true,
    });
  } catch {
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 500 });
  }
}
