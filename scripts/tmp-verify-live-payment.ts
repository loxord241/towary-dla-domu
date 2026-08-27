/**
 * READ-ONLY end-to-end verification of ONE live control payment.
 * No writes, no payments, no refunds. Run AFTER the operator has completed
 * the manual control purchase:
 *
 *   node scripts/tmp-verify-live-payment.ts ORD-YYYYMMDD-XXXXXX [--liqpay]
 *
 * Sections:
 *   A. Order row + money match      (service-key SELECT)
 *   B. Payment bookkeeping columns  (paid_at/method/liqpay ids)
 *   C. LiqPay Status API            (read-only POST action=status;
 *                                    explicitly opt-in via --liqpay)
 *   D. Stock movement exactly once  (product_stock_history around created_at)
 *   E. Success page rendering       (SSR curl with computed capability pair)
 *
 * Honesty model: every assertion is labelled CONFIRMED / UNCONFIRMED /
 * UNKNOWN; nothing here mutates DB or provider state.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^"|"$/g, '').trim();
    }
  }
} catch {}

const ORDER_NUMBER = process.argv[2];
const DO_LIQPAY = process.argv.includes('--liqpay');
if (!ORDER_NUMBER || !/^ORD-\d{8}-[A-Z0-9]{4,10}$/i.test(ORDER_NUMBER)) {
  console.error('usage: node scripts/tmp-verify-live-payment.ts ORD-YYYYMMDD-XXXXXX [--liqpay]');
  process.exit(2);
}

const { createClient } = await import('@supabase/supabase-js');
const svc: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

let confirmed = 0;
let unconfirmed = 0;
function verdict(level: 'CONFIRMED' | 'UNCONFIRMED' | 'UNKNOWN', name: string, detail?: string) {
  if (level === 'CONFIRMED') confirmed += 1;
  else unconfirmed += 1;
  console.log(`${level.padEnd(11)} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------ A. order
console.log(`== A. order row (${ORDER_NUMBER}) ==`);
const oRes = await svc.from('orders').select('*').eq('order_number', ORDER_NUMBER).maybeSingle();
if (!oRes.data) {
  verdict('UNCONFIRMED', 'order exists in DB', oRes.error?.message ?? 'no row');
  console.log('\nRESULT:', `confirmed=${confirmed}`, `unconfirmed=${unconfirmed}`);
  process.exit(1);
}
const order = oRes.data;
console.log(
  `   order_number=${order.order_number} amount=${order.total_amount} ${order.currency} ` +
    `status=${order.status} payment_status=${order.payment_status}`
);
verdict('CONFIRMED', 'order exists');
console.log(
   `   --> OPERATOR CHECK: оплаченная сумма должна быть ${order.total_amount} ${order.currency}`
);

// ------------------------------------------------ B. payment bookkeeping
console.log('== B. payment bookkeeping ==');
verdict(order.payment_status === 'paid' ? 'CONFIRMED' : 'UNCONFIRMED',
  'payment_status = paid', String(order.payment_status));
verdict(!!order.paid_at ? 'CONFIRMED' : 'UNCONFIRMED',
  'paid_at filled', order.paid_at ?? '(null)');
verdict(!!order.payment_method ? 'CONFIRMED' : 'UNCONFIRMED',
  'payment_method filled', order.payment_method ?? '(null)');
verdict(order.liqpay_payment_id != null ? 'CONFIRMED' : 'UNCONFIRMED',
  'liqpay_payment_id filled', String(order.liqpay_payment_id ?? '(null)'));
verdict(!!order.liqpay_order_id ? 'CONFIRMED' : 'UNCONFIRMED',
  'liqpay_order_id (callback key) present', order.liqpay_order_id ?? '(null)');
verdict(!order.payment_error ? 'CONFIRMED' : 'UNKNOWN',
  'payment_error empty', order.payment_error ?? '(empty)');

// -------------------------------------------- C. LiqPay Status API (opt-in)
if (DO_LIQPAY && order.liqpay_order_id) {
  console.log('== C. LiqPay Status API (read-only action=status) ==');
  try {
    const pub = process.env.LIQPAY_PUBLIC_KEY!;
    const priv = process.env.LIQPAY_PRIVATE_KEY!;
    const json = JSON.stringify({
      action: 'status',
      version: 3,
      public_key: pub,
      order_id: order.liqpay_order_id,
    });
    const data = Buffer.from(json, 'utf8').toString('base64');
    const signature = crypto.createHash('sha1').update(priv + data + priv, 'utf8').digest('base64');
    const res = await fetch('https://www.liqpay.ua/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data, signature }),
    });
    const body: any = await res.json();
    // Print minimal, non-secret provider facts only.
    console.log(
      `   provider: status=${body.status} amount=${body.amount} currency=${body.currency} ` +
        `transaction_id=${body.transaction_id ?? '(n/a)'}`
    );
    verdict(body.status === 'success' || body.status === 'sandbox'
      ? 'CONFIRMED' : 'UNCONFIRMED',
      'provider reports successful charge', body.status);
    verdict(String(body.amount) === String(order.total_amount)
      ? 'CONFIRMED' : 'UNCONFIRMED',
      'provider amount matches DB total_amount');
  } catch (e) {
    verdict('UNKNOWN', 'Status API reachable', String(e));
  }
} else {
  console.log('== C. LiqPay Status API: SKIPPED (add --liqpay to enable) ==');
}

// ------------------------------------------- D. stock moved exactly once
console.log('== D. stock movement for this order ==');
const iRes = await svc.from('order_items').select('product_id,variant_id,quantity')
  .eq('order_id', order.id);
const items = iRes.data ?? [];
for (const it of items) {
  let q = svc.from('product_stock_history').select('old_quantity,new_quantity,reason,source,created_at')
    .eq('product_id', it.product_id)
    .gte('created_at', new Date(new Date(order.created_at).getTime() - 60_000).toISOString())
    .lte('created_at', new Date(new Date(order.created_at).getTime() + 3_600_000_000).toISOString())
    .order('created_at', { ascending: true });
  if (it.variant_id) q = q.eq('variant_id', it.variant_id);
  const hRes = await q;
  const dec = (hRes.data ?? []).filter((r: any) => r.new_quantity < r.old_quantity);
  const inc = (hRes.data ?? []).filter((r: any) => r.new_quantity > r.old_quantity);
  console.log(
    `   product=${it.product_id} qty=${it.quantity}: decrements=${dec.length}, increments=${inc.length}` +
      (dec.length ? ` [${dec.map((d: any) => `${d.reason}/${d.source}`).join(', ')}]` : '')
  );
  verdict(dec.length === 1 ? 'CONFIRMED' : dec.length === 0 ? 'UNKNOWN' : 'UNCONFIRMED',
    'stock decremented exactly once',
    dec.length === 0 ? 'no decrement row found — RLS/history scope may hide it' : undefined);
  verdict(inc.length === 0 ? 'CONFIRMED' : 'UNCONFIRMED',
    'no double-restock signs near checkout window');
}

// ------------------------------------------------------ E. success page SSR
console.log('== E. success page rendering ==');
try {
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');
  const { orderAccessToken } = await import('../app/lib/order-token.ts');
  const token = orderAccessToken(ORDER_NUMBER);
  const html = await (
    await fetch(`${site}/checkout/success?order=${encodeURIComponent(ORDER_NUMBER)}&t=${encodeURIComponent(token)}`)
  ).text();
  const marker = /Оплату\s+отримано/i.test(html);
  verdict(marker ? 'CONFIRMED' : 'UNCONFIRMED',
    'success page shows «Оплату отримано»', marker ? '' : `HTTP page ${html.length} bytes without marker`);
} catch (e) {
  verdict('UNKNOWN', 'success page fetch', String(e));
}

console.log(`\nRESULT: CONFIRMED=${confirmed} NOT-CONFIRMED-or-UNKNOWN=${unconfirmed}`);
process.exit(unconfirmed > 0 ? 1 : 0);
