import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getLiqPayConfig } from '@/app/lib/payment/liqpay-config';
import {
  processLiqPayCallback,
  createSupabaseOrdersGateway,
} from '@/app/lib/payment/order-payment-update';

/**
 * POST /api/payment/liqpay/callback — LiqPay server-to-server callback.
 *
 * Accepts ONLY data + signature (urlencoded form, JSON fallback for local
 * mocks). Signature is verified BEFORE anything else; amounts/currency are
 * checked against the DB row; every transition is a conditional idempotent
 * UPDATE.
 *
 * HTTP contract:
 *  - 400 only for malformed requests / invalid signatures (no 5xx → no
 *    retry storm on garbage);
 *  - 200 for everything recognized, INCLUDING unknown orders, amount
 *    mismatches and idempotent replays, so LiqPay stops retrying.
 *
 * No rate limit: the caller is LiqPay's infrastructure; a limiter here
 * would only delay legitimate payment confirmations. Abuse of this route
 * costs nothing without the private key (invalid signatures are rejected
 * before any DB access).
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function parseBody(
  request: Request
): Promise<{ data?: unknown; signature?: unknown }> {
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      return (await request.json()) as Record<string, unknown>;
    }
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text));
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  let config;
  try {
    config = getLiqPayConfig();
  } catch {
    // Do not leak misconfiguration details to an unauthenticated endpoint;
    // 200 keeps LiqPay from hammering a broken integration in a loop.
    console.error('liqpay/callback: LIQPAY_* env not configured');
    return new NextResponse(null, { status: 200 });
  }

  const body = await parseBody(request);
  const res = await processLiqPayCallback(
    { gateway: createSupabaseOrdersGateway(supabase), privateKey: config.privateKey },
    body
  );

  switch (res.kind) {
    case 'invalid-request':
      return NextResponse.json({ error: 'Некоректний запит' }, { status: 400 });
    case 'bad-signature':
      console.warn(`liqpay/callback: ${res.log}`);
      return NextResponse.json({ error: 'Підпис невалідний' }, { status: 400 });
    case 'malformed-payload':
      console.warn(`liqpay/callback: ${res.log}`);
      return NextResponse.json({ error: 'Некоректні дані' }, { status: 400 });
    default:
      // updated / already-paid / kept-pending / unknown-order /
      // amount-mismatch / currency-mismatch — all "handled", all 200.
      if ('log' in res && res.log) {
        console.info(`liqpay/callback: [${res.kind}] ${res.log}`);
      }
      return new NextResponse('ok', { status: 200 });
  }
}
