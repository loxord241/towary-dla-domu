/**
 * STRICTLY READ-ONLY LiqPay ↔ DB reconciliation CLI.
 *
 *   node scripts/reconcile-liqpay.mts [--from=ISO] [--to=ISO] [--limit=2000]
 *
 * What it does:
 *   - SELECTs orders with liqpay_order_id IS NOT NULL in the created_at
 *     window (keyset pagination on created_at — no offset instability);
 *   - queries LiqPay Status API (action=status, version=3) for each attempt;
 *   - classifies every row via app/lib/payment/reconciliation.ts;
 *   - detects duplicate liqpay_payment_id groups in memory over the fetched
 *     rows (SELECT-only; PostgREST has no GROUP BY/HAVING);
 *   - prints a human summary + JSON report to stdout.
 *
 * Hard guarantees (by construction, not by flag):
 *   - NO INSERT / UPDATE / DELETE / RPC anywhere in this file;
 *   - NO mutation flags exist (--apply/--fix/--repair are deliberately
 *     absent from the design);
 *   - LiqPay calls are action=status ONLY (a read);
 *   - keys are loaded from env and never printed, logged or returned.
 *
 * Exit codes:
 *   0 — everything checked is consistent, no duplicates, none unreachable;
 *   1 — at least one discrepancy / duplicate / unreachable found (or setup
 *       error, following the project's fail-loud script convention).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^"|"$/g, '').trim();
    }
  }
} catch {}

// ---------------------------------------------------------------------------
// Args (window/size knobs only — there is no "do something" mode switch)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name: string): string | null {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const DEFAULT_FROM = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const FROM = argValue('from') ?? DEFAULT_FROM;
const TO = argValue('to');
const LIMIT = Math.min(Math.max(Number(argValue('limit') ?? 5000), 1), 50_000);
const BATCH_SIZE = 200;
const THROTTLE_MS = 200;

if (!/^\d{4}-\d{2}-\d{2}T/.test(FROM)) {
  console.error('usage: node scripts/reconcile-liqpay.mts [--from=ISO] [--to=ISO] [--limit=N]');
  process.exit(1);
}

for (const name of [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'LIQPAY_PUBLIC_KEY',
  'LIQPAY_PRIVATE_KEY',
] as const) {
  if (!process.env[name]) {
    console.error(`missing required env: ${name}`);
    process.exit(1);
  }
}

const { createClient } = await import('@supabase/supabase-js');
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const { classifyReconcileRow, findDuplicatePaymentIdGroups } = await import(
  '../app/lib/payment/reconciliation.ts'
);
const { fetchLiqPayProviderStatus } = await import(
  '../app/lib/payment/liqpay-status-api.ts'
);

// ---------------------------------------------------------------------------
// LiqPay Status API — shared read-only client (single implementation)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Keyset pagination over created_at (deterministic order, offset-free)
// ---------------------------------------------------------------------------

interface OrderRowShim {
  order_number: string;
  liqpay_order_id: string;
  liqpay_payment_id: number | string | null;
  payment_status: string;
  total_amount: number | string;
  currency: string;
  status: string;
  expires_at: string | null;
  created_at: string;
}

async function* loadRows(): AsyncGenerator<OrderRowShim> {
  let cursor: { createdAt: string; orderNumber: string } | null = null;
  let loaded = 0;
  while (loaded < LIMIT) {
    let q = svc
      .from('orders')
      .select(
        'order_number, liqpay_order_id, liqpay_payment_id, payment_status, total_amount, currency, status, expires_at, created_at'
      )
      .not('liqpay_order_id', 'is', null)
      .gte('created_at', FROM)
      .order('created_at')
      .order('order_number')
      .limit(Math.min(BATCH_SIZE, LIMIT - loaded));
    if (TO) q = q.lte('created_at', TO);
    // Composite keyset cursor: order_number is UNIQUE (idx_orders_order_number),
    // so (created_at, order_number) is a total order. A plain gt(created_at)
    // skips the tail of any same-timestamp group straddling the page boundary.
    if (cursor) {
      q = q.or(
        `created_at.gt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",order_number.gt."${cursor.orderNumber}")`
      );
    }
    const { data, error } = await q;
    if (error) throw new Error(`DB select failed: ${error.message}`);
    const rows = (data ?? []) as OrderRowShim[];
    if (rows.length === 0) return;
    for (const r of rows) {
      yield r;
      loaded += 1;
      if (loaded >= LIMIT) return;
    }
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at, orderNumber: last.order_number };
  }
}

// ---------------------------------------------------------------------------
// Main pass
// ---------------------------------------------------------------------------

const results: Array<{
  order_number: string;
  liqpay_order_id: string | null;
  liqpay_payment_id: number | string | null;
  db_payment_status: string;
  provider_status: unknown;
  amount: number | string;
  currency: string;
  classification: string;
}> = [];

let first = true;
for await (const row of loadRows()) {
  if (!first) await sleep(THROTTLE_MS); // polite pacing; no parallelism
  first = false;

  const provider = await fetchLiqPayProviderStatus(row.liqpay_order_id);
  const cls = classifyReconcileRow(
    {
      order_number: row.order_number,
      liqpay_order_id: row.liqpay_order_id,
      liqpay_payment_id: row.liqpay_payment_id,
      payment_status: row.payment_status,
      amount: row.total_amount, // DB column → neutral interface field
      currency: row.currency,
      status: row.status,
      expires_at: row.expires_at,
      created_at: row.created_at,
    },
    provider as never,
    Date.now()
  );

  results.push({
    order_number: row.order_number,
    liqpay_order_id: row.liqpay_order_id,
    liqpay_payment_id: row.liqpay_payment_id,
    db_payment_status: row.payment_status,
    provider_status: provider && typeof provider.status === 'string' ? provider.status : null,
    amount: row.total_amount,
    currency: row.currency,
    classification: cls,
  });
}

const duplicates = findDuplicatePaymentIdGroups(
  [...results].map((r) => ({
    order_number: r.order_number,
    liqpay_order_id: r.liqpay_order_id ?? '',
    liqpay_payment_id: r.liqpay_payment_id,
    payment_status: r.db_payment_status,
    amount: r.amount,
    currency: r.currency,
    status: '',
    expires_at: null as string | null,
  }))
);

// ---------------------------------------------------------------------------
// Report — minimal fields only; no email, customer_info, shipping_info, keys.
// ---------------------------------------------------------------------------

const CLEAN = new Set(['OK_OK']);
const findings = results.filter((r) => !CLEAN.has(r.classification));

// Semantics differ even though both remain findings (exit 1):
//   UNREACHABLE        — provider status could NOT be reliably obtained;
//   PROVIDER_NOT_FOUND — provider answered: no transaction for this order_id
//                        in the current merchant/key context.
const NOT_FOUND = new Set(['PROVIDER_NOT_FOUND']);

console.log('== LiqPay ↔ DB reconciliation (READ-ONLY) ==');
console.log(`window: created_at >= ${FROM}${TO ? ` AND <= ${TO}` : ''}, limit=${LIMIT}`);
console.log(`checked: ${results.length}; consistent: ${results.length - findings.length}; findings: ${findings.length + duplicates.length}`);

const byClass = new Map<string, number>();
for (const r of findings) byClass.set(r.classification, (byClass.get(r.classification) ?? 0) + 1);
for (const [k, v] of [...byClass.entries()].sort()) console.log(`  ${k}: ${v}`);

if (findings.length > 0 || duplicates.length > 0) {
  console.log('\n-- Discrepancies (facts only; NO auto-fix will be attempted) --');
  for (const r of findings) {
    const note = NOT_FOUND.has(r.classification)
      ? ' [provider answered: transaction not found in current merchant/key context]'
      : '';
    console.log(
      `[${r.classification}]${note} ${r.order_number} ` +
        `db=${r.db_payment_status} provider=${r.provider_status ?? '(n/a)'} ` +
        `${r.amount} ${r.currency} payment_id=${r.liqpay_payment_id ?? '(null)'}`
    );
  }
  for (const d of duplicates) {
    console.log(`[DUPLICATE_PAYMENT_ID] ${d.liqpay_payment_id}: ${d.order_numbers.join(', ')}`);
  }
} else {
  console.log('\nAll checked payments are consistent.');
}

// JSON block last, delimited for downstream automation.
const report = {
  generated_at: new Date().toISOString(),
  window_from: FROM,
  window_to: TO ?? null,
  checked: results.length,
  clean: results.length - findings.length,
  findings_count: findings.length + duplicates.length,
  discrepancies: findings,
  duplicate_payment_ids: duplicates,
};
console.log('\n---JSON-BEGIN---');
console.log(JSON.stringify(report, null, 2));
console.log('---JSON-END---');

process.exit(findings.length > 0 || duplicates.length > 0 ? 1 : 0);
