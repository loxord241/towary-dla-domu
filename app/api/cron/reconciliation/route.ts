import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  runReconciliationScan,
  buildReconciliationAlertMessage,
} from '@/app/lib/payment/reconciliation-scan';
import { sendTelegramText } from '@/app/lib/notifications/telegram';

// Sequential throttled Status calls over up to SCAN_MAX_LIMIT rows (~20 s
// worst case) plus provider round-trips — a bounded but not tiny workload
// (same contract as the admin reconciliation endpoint).
export const maxDuration = 60;

/**
 * GET /api/cron/reconciliation — automated daily reconciliation scan + alert.
 *
 * Closes the "money captured on a cancelled order" detection gap: the admin
 * endpoint (app/api/admin/orders/reconciliation) only finds
 * PROVIDER_SUCCESS_DB_NOT_PAID when an admin manually runs it. This cron
 * endpoint runs the SAME classifier (via app/lib/payment/reconciliation-scan,
 * which reuses app/lib/payment/reconciliation.ts) on a schedule and alerts
 * the admin chat on the two money-integrity classes:
 *   - PROVIDER_SUCCESS_DB_NOT_PAID — LiqPay captured money, our order is not
 *     paid (lost callback / captured-after-cancel);
 *   - AMOUNT_MISMATCH — provider claims a paid transaction with different
 *     money than the order.
 *
 * Security model:
 *   - bearer-token only: `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron
 *     sends exactly this header when CRON_SECRET is configured for the
 *     project. Missing/mismatching/unconfigured secret → generic 401 with
 *     NO scan executed (fail-closed). Comparison is constant-time (sha256 +
 *     timingSafeEqual), so no timing/length oracle.
 *   - NO admin session/cookie is involved (cron has no user session) — this
 *     endpoint deliberately does NOT use requireAdminApi.
 *   - strictly read-only: SELECTs only, provider calls are action=status
 *     only, no DB writes, no LiqPay mutations. Remediation (refund) is a
 *     human step in the LiqPay dashboard — the alert says so explicitly.
 *
 * Response contract: a successful scan ALWAYS answers 200 with a JSON
 * summary (even at zero findings) so the cron execution log stays readable.
 * Only infrastructure failures (DB read, LiqPay misconfiguration) answer
 * 500 — a broken scan must never masquerade as an all-clear. Telegram
 * failures never fail the request (sendTelegramText never throws).
 */

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

  let scan;
  try {
    scan = await runReconciliationScan();
  } catch (error) {
    console.error(
      'cron reconciliation scan failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json(
      { error: 'Reconciliation failed' },
      { status: 500 }
    );
  }

  // Best-effort alerting: never throws, never blocks the summary response.
  const notifications: Array<{
    alert_class: string;
    orders_total: number;
    telegram: { sent: boolean; reason?: string; detail?: string };
  }> = [];
  for (const alert of scan.alerts) {
    let result;
    try {
      result = await sendTelegramText(buildReconciliationAlertMessage(alert));
    } catch (error) {
      // Defense in depth: sendTelegramText is never-throw by contract, but
      // an alerting bug must not degrade the cron summary either.
      result = {
        sent: false,
        reason: 'unexpected' as const,
        detail: error instanceof Error ? error.name : 'unknown',
      };
    }
    notifications.push({
      alert_class: alert.alertClass,
      orders_total: alert.orderNumbers.length,
      telegram: result,
    });
    if (!result.sent) {
      console.error(
        `cron reconciliation alert not delivered (${alert.alertClass}): ${result.reason ?? 'unknown'}${result.detail ? ` (${result.detail})` : ''}`
      );
    }
  }

  return NextResponse.json({
    generated_at: scan.generatedAt,
    window_from: scan.windowFrom,
    checked: scan.checked,
    summary: scan.summary,
    findings_count: scan.findings.length,
    alerts: scan.alerts,
    notifications,
    readonly: true,
  });
}
