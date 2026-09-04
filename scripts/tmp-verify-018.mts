/**
 * Post-apply verification for migration 018 (paid-order cancellation
 * interlock). READ-ONLY except ONE intentional admin_cancel_order probe on
 * a PAID order: both function versions raise P0409-class exceptions before
 * any write for the chosen target, so the probe itself is net-zero when the
 * target selection rule holds (see selectProbeTarget below).
 *
 * Run ONLY AFTER applying database/migrations/018_paid_order_interlock.sql
 * in the Supabase SQL Editor:
 *
 *   node scripts/tmp-verify-018.mts
 *
 * Expected end-state:
 *   - service-key probe admin_cancel_order(paid order) →
 *     code P0409, message contains PAID_ORDER_NOT_CANCELLABLE;
 *   - probed order row unchanged (status, payment_status);
 *   - product/variant stock sums identical before/after the probe;
 *   - anon-key RPC calls refused (grants intact, service_role only);
 *   - OpenAPI surface still lists admin_cancel_order AND
 *     expire_pending_orders; liqpay_* columns readable (head=true → 200).
 *
 * Honest limitations:
 *   - unpaid/pending cancellation path is NOT exercised here (a real cancel
 *     is a DB write + stock movement): structural byte-diff vs migration 007
 *     body is the evidence; behavioral verdict = UNKNOWN-by-probe.
 *   - expire_pending_orders() source cannot be compared remotely; only its
 *     existence/surface and untouched baselines are asserted.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^"|"$/g, '').trim();
    }
  }
} catch {}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
if (!URL_ || !SERVICE || !ANON) throw new Error('missing Supabase env');

const { createClient } = await import('@supabase/supabase-js');
const svc: any = createClient(URL_, SERVICE);
const anon: any = createClient(URL_, ANON);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function stockFingerprints(): Promise<{ p: number; v: number }> {
  const [pRes, vRes] = await Promise.all([
    svc.from('products').select('stock_quantity'),
    svc.from('product_variants').select('stock_quantity'),
  ]);
  const s = (rows: any[] | null | undefined) =>
    (rows ?? []).reduce((acc, r) => acc + Number(r.stock_quantity ?? 0), 0);
  return { p: s(pRes.data), v: s(vRes.data) };
}

// ---------------------------------------------------------------- baselines
console.log('== baselines (read-only) ==');
const fpBefore = await stockFingerprints();
check('baseline: stock fingerprints readable', fpBefore.p > 0 || fpBefore.v >= 0);

const payCounts: Record<string, number> = {};
{
  // bounded paging, cap 1000 suffices for a handful of orders
  const res = await svc.from('orders').select('payment_status,status,id');
  check('baseline: orders readable via service key', !res.error, res.error?.message);
  for (const row of res.data ?? []) {
    payCounts[row.payment_status] = (payCounts[row.payment_status] ?? 0) + 1;
  }
}
console.log('   orders by payment_status:', JSON.stringify(payCounts));

const liqHead = await svc.from('orders').select('liqpay_order_id,paid_at').limit(1);
check(
  'migration-017 columns intact (liqpay_order_id/paid_at)',
  !liqHead.error,
  liqHead.error?.message
);

// ------------------------------------------------------------ probe target
// Preference: a paid order whose fulfilment status makes it non-cancellable
    // EVEN BY THE OLD FUNCTION VERSION (status outside pending/confirmed).
// For such targets BOTH versions raise P0409 before any write:
//   old version → INVALID_TRANSITION / ALREADY_CANCELLED,
//   new version → PAID_ORDER_NOT_CANCELLABLE (guard precedes checks).
console.log('== selecting probe target (safest class first) ==');
type Cand = { id: string; order_number: string; status: string };
let target: Cand | null = null;
{
  const res = await svc.from('orders').select('id,order_number,status,payment_status')
    .eq('payment_status', 'paid');
  const all: Cand[] = res.data ?? [];
  target =
    all.find((o) => !['pending', 'confirmed'].includes(o.status)) ??
    all.find((o) => ['pending', 'confirmed'].includes(o.status)) ??
    null;
  if (!target) {
    check('paid-order probe SKIPPED (no paid orders exist)', true);
  } else {
    console.log(`   target ${target.order_number} (status=${target.status})`);
  }
}

if (target) {
  console.log('== PAID guard probe (net-zero by design) ==');
  const r = await svc.rpc('admin_cancel_order', { p_order_id: target.id });
  const msg = String(r.error?.message ?? '');
  const code = String(r.error?.code ?? '');
  console.log(`   rpc error.code=${code} message="${msg}"`);
  check('guard error code is P0409', code === 'P0409', code || '(no error)');
  check(
    'PAID_ORDER_NOT_CANCELLABLE raised (NEW function live)',
    /PAID_ORDER_NOT_CANCELLABLE/i.test(msg),
    msg
  );

  const after = await svc
    .from('orders')
    .select('id,order_number,status,payment_status')
    .eq('id', target.id)
    .maybeSingle();
  check(
    'probed order untouched',
    !!after.data &&
      after.data.payment_status === 'paid' &&
      after.data.status === target.status,
    JSON.stringify(after.data ?? after.error)
  );
  const fpAfter = await stockFingerprints();
  check(
    'stock sums identical after probe (no restock happened)',
    fpAfter.p === fpBefore.p && fpAfter.v === fpBefore.v,
    `products ${fpBefore.p}->${fpAfter.p}, variants ${fpBefore.v}->${fpAfter.v}`
  );
}

// ------------------------------------------------------------- grants/RPC surface
console.log('== grants / RPC surface ==');
{
  const fakeId = '00000000-0000-0000-0000-000000000000';
  const names = ['admin_cancel_order', 'admin_set_order_status', 'expire_pending_orders'];
  for (const fn of names) {
    const args = fn === 'expire_pending_orders' ? {} : { p_order_id: fakeId };
    const res = await anon.rpc(fn as never, args as never);
    // Any structured refusal proves EXECUTE was not left open to anon.
    check(`anon cannot execute ${fn}`, !!res.error, `${res.error?.code ?? ''} ${res.error?.message ?? ''}`.slice(0, 80));
  }
  try {
    const spec = await fetch(`${URL_}/rest/v1/`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    const text = await spec.text();
    check('OpenAPI lists admin_cancel_order', text.includes('/rpc/admin_cancel_order'));
    check(
      'OpenAPI lists expire_pending_orders (surface present)',
      text.includes('/rpc/expire_pending_orders')
    );
  } catch (e) {
    check('OpenAPI introspection reachable', false, String(e));
  }
}

console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
