/**
 * Bounded LiqPay ↔ DB reconciliation SCAN orchestration for the cron
 * endpoint (app/api/cron/reconciliation) — the automation layer that closes
 * the "money captured on a cancelled order" detection gap: the admin route
 * (app/api/admin/orders/reconciliation) only finds PROVIDER_SUCCESS_DB_NOT_PAID
 * when an admin manually clicks "check now"; this module lets a daily cron
 * surface the same findings proactively.
 *
 * Reuse contract: classification itself is NEVER reimplemented here — every
 * row goes through classifyReconcileRow from reconciliation.ts (the pure,
 * production-semantics classifier). This module only orchestrates:
 *   1. one bounded SELECT of recent orders with a liqpay_order_id
 *      (non-PII whitelist columns only, single query, hard limit);
 *   2. sequential throttled action=status lookups (same READ-ONLY helper the
 *      admin route and CLI use);
 *   3. classification + a flat summary + alert extraction.
 *
 * Dependency seam: fetchOrderRows/fetchProvider are injectable so tests run
 * the REAL orchestration with fakes (no Supabase, no network). Defaults are
 * created lazily (service-role client, LIQPAY keys) — misconfiguration
 * surfaces as a thrown error, which the cron route maps to a 500
 * (fail-closed), never as a silent all-clear report.
 *
 * Remediation is still out of scope by design (B1 interlock semantics):
 * PROVIDER_SUCCESS_DB_NOT_PAID / AMOUNT_MISMATCH are reported to the admin
 * (Telegram) for manual resolution via the LiqPay dashboard, never
 * auto-corrected.
 */

import { createClient } from '@supabase/supabase-js';
import {
  classifyReconcileRow,
  type ReconciliationCase,
} from './reconciliation.ts';
import { fetchLiqPayProviderStatus } from './liqpay-status-api.ts';
import { getLiqPayConfig } from './liqpay-config.ts';

// ---------------- bounds (mirrors the admin route's performance contract) ----------------

export const SCAN_DEFAULT_DAYS = 7;
export const SCAN_MAX_DAYS = 90;
export const SCAN_DEFAULT_LIMIT = 50;
export const SCAN_MAX_LIMIT = 100;
const THROTTLE_MS = 200;

/**
 * Explicit non-PII whitelist (subset of the admin route's projection — the
 * cron report needs nothing else). No contact/address column may ever be
 * added here.
 */
const ORDER_COLUMNS =
  'order_number, status, payment_status, total_amount, currency, ' +
  'liqpay_order_id, liqpay_payment_id, expires_at, created_at';

export interface ScanOrderRow {
  order_number: string;
  liqpay_order_id: string | null;
  liqpay_payment_id: number | string | null;
  payment_status: string;
  total_amount: number | string;
  currency: string;
  status: string;
  expires_at: string | null;
  created_at: string;
}

export interface ScanItem {
  order_number: string;
  created_at: string;
  status: string;
  payment_status: string;
  amount: number | string;
  currency: string;
  liqpay_order_id: string | null;
  liqpay_payment_id: number | string | null;
  provider_status: string | null;
  classification: ReconciliationCase;
}

/** The classes the cron ALERTS on — the "money hole" detector set. */
export const ALERT_CLASSES = [
  'PROVIDER_SUCCESS_DB_NOT_PAID',
  'AMOUNT_MISMATCH',
] as const;

export type AlertClass = (typeof ALERT_CLASSES)[number];

export interface ReconciliationAlert {
  alertClass: AlertClass;
  orderNumbers: string[];
}

export interface ReconciliationScanResult {
  generatedAt: string;
  windowFrom: string;
  checked: number;
  /** Every classification bucket, zero-initialized — a readable cron log. */
  summary: Record<string, number>;
  /** All rows that did not classify OK_OK. */
  findings: ScanItem[];
  /** Findings restricted to ALERT_CLASSES, grouped per class. */
  alerts: ReconciliationAlert[];
}

// ---------------- injectable seams ----------------

export interface ReconciliationScanDeps {
  fetchOrderRows: (fromIso: string, limit: number) => Promise<ScanOrderRow[]>;
  fetchProvider: (
    liqpayOrderId: string
  ) => Promise<Record<string, unknown> | null>;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Production deps: a fresh service-role client per scan (RLS bypass is
 * required — orders have no public SELECT) and the shared READ-ONLY Status
 * helper. Keys/config errors propagate as thrown errors (fail-closed 500).
 */
function createDefaultDeps(): ReconciliationScanDeps {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error('RECON_SCAN_DB_UNCONFIGURED: Supabase service client unavailable');
  }
  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  return {
    fetchOrderRows: async (fromIso, limit) => {
      // Single bounded SELECT — the cron window is small by contract
      // (limit ≤ SCAN_MAX_LIMIT), so the admin route's keyset pagination
      // loop is not needed here.
      const { data, error } = await client
        .from('orders')
        .select(ORDER_COLUMNS)
        .not('liqpay_order_id', 'is', null)
        .gte('created_at', fromIso)
        .order('created_at')
        .order('order_number')
        .limit(limit);
      if (error) {
        throw new Error(`RECON_SCAN_DB_READ_FAILED: ${error.message}`);
      }
      return (data ?? []) as unknown as ScanOrderRow[];
    },
    fetchProvider: async (liqpayOrderId) => {
      const config = getLiqPayConfig();
      return fetchLiqPayProviderStatus(
        liqpayOrderId,
        config.publicKey,
        config.privateKey
      );
    },
  };
}

// ---------------- orchestration ----------------

export async function runReconciliationScan(
  options: { days?: number; limit?: number; deps?: ReconciliationScanDeps } = {}
): Promise<ReconciliationScanResult> {
  const days = clampInt(options.days, SCAN_DEFAULT_DAYS, 1, SCAN_MAX_DAYS);
  const limit = clampInt(options.limit, SCAN_DEFAULT_LIMIT, 1, SCAN_MAX_LIMIT);
  const deps = options.deps ?? createDefaultDeps();

  const windowFrom = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = await deps.fetchOrderRows(windowFrom, limit);

  const items: ScanItem[] = [];
  let first = true;
  for (const row of rows) {
    if (!first) await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
    first = false;

    const provider = row.liqpay_order_id
      ? await deps.fetchProvider(row.liqpay_order_id)
      : null;
    items.push({
      order_number: row.order_number,
      created_at: row.created_at,
      status: row.status,
      payment_status: row.payment_status,
      amount: row.total_amount,
      currency: row.currency,
      liqpay_order_id: row.liqpay_order_id,
      liqpay_payment_id: row.liqpay_payment_id,
      provider_status:
        provider && typeof provider.status === 'string' ? provider.status : null,
      classification: classifyReconcileRow(
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
        provider
      ),
    });
  }

  const summary: Record<string, number> = {};
  for (const item of items) {
    summary[item.classification] = (summary[item.classification] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    windowFrom,
    checked: items.length,
    summary,
    findings: items.filter((item) => item.classification !== 'OK_OK'),
    alerts: collectAlerts(items),
  };
}

// ---------------- alert extraction + Telegram message builder (pure) ----------------

/**
 * Extracts ONLY the alert-worthy findings from classified items. Anything
 * else (CURRENCY_MISMATCH, MANUAL_REVIEW, STALE_ATTEMPT, ...) stays in the
 * scan summary/findings for the cron log but does not page the admin.
 */
export function collectAlerts(
  items: Array<Pick<ScanItem, 'classification' | 'order_number'>>
): ReconciliationAlert[] {
  const byClass = new Map<AlertClass, string[]>();
  for (const item of items) {
    if (!(ALERT_CLASSES as readonly string[]).includes(item.classification)) continue;
    const alertClass = item.classification as AlertClass;
    const list = byClass.get(alertClass);
    if (list) list.push(item.order_number);
    else byClass.set(alertClass, [item.order_number]);
  }
  return ALERT_CLASSES.filter((c) => byClass.has(c)).map((alertClass) => ({
    alertClass,
    orderNumbers: (byClass.get(alertClass) ?? []).sort(),
  }));
}

const ALERT_ORDER_NUMBERS_MAX = 10;
const ALERT_MESSAGE_MAX = 4000; // Telegram hard limit is 4096; keep headroom

/**
 * Plain-text alert (no parse_mode, same discipline as order notifications —
 * nothing user-controlled is ever embedded, so no escaping is needed).
 * Shows at most ALERT_ORDER_NUMBERS_MAX order numbers, with a "та ще N"
 * tail; the full list is always available in the admin reconciliation UI.
 */
export function buildReconciliationAlertMessage(alert: ReconciliationAlert): string {
  const total = alert.orderNumbers.length;
  const shown = alert.orderNumbers.slice(0, ALERT_ORDER_NUMBERS_MAX);
  const lines: string[] = [];
  lines.push(`⚠️ RECONCILIATION: ${alert.alertClass}`);
  lines.push('');
  lines.push(`Кількість: ${total}`);
  lines.push(`Закази: ${shown.join(', ')}`);
  if (total > shown.length) {
    lines.push(`…та ще ${total - shown.length}`);
  }
  lines.push('');
  lines.push('Ручне втручання: LiqPay дашборд → refund/рішення');
  lines.push('(автоматичних виправлень немає — деталі: адмінка → замовлення → reconciliation)');
  const message = lines.join('\n');
  return message.length > ALERT_MESSAGE_MAX
    ? `${message.slice(0, ALERT_MESSAGE_MAX)}…`
    : message;
}
