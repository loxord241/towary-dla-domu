import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  orderAccessToken,
  verifyOrderAccessToken,
  verifyStoredAccessToken,
} from '@/app/lib/order-token';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import {
  getLiqPayConfig,
  buildCallbackUrl,
  buildResultUrl,
} from '@/app/lib/payment/liqpay-config';
import {
  createPaymentInit,
  createSupabaseOrdersGateway,
} from '@/app/lib/payment/order-payment-update';
import { fetchLiqPayProviderStatus } from '@/app/lib/payment/liqpay-status-api';

/**
 * POST /api/orders/[orderNumber]/payment — LiqPay init.
 *
 * Authorization: the capability token — the rotating random token whose
 * SHA-256 hash lives in orders.access_token_hash (migration 045), or the
 * legacy deterministic HMAC for rows never rotated — verified BEFORE the
 * payment orchestration. Amount/currency are read EXCLUSIVELY from the
 * orders row; the client may send nothing but its token.
 *
 * Success response: { data, signature, checkoutUrl } — everything the
 * browser needs to POST the generated form to LiqPay's checkout. The
 * private key never leaves the server.
 *
 * Repeated calls are safe: a NEW attempt id is reserved only from
 * unfinalized states (unpaid/failed → ORD-…, ORD-…:2, ORD-…:3 …). While an
 * attempt is live (pending) further inits return 409 so the single
 * liqpay_order_id always maps to the one possible provider session, and a
 * paid/expired/closed order can never be revived.
 *
 * Exception (stale-pending recovery): a pending attempt older than 60
 * minutes is re-checked against the provider (read-only action=status).
 * Provider "success" repairs the lost-callback deadlock through the same
 * B1-guarded applyPaid path callbacks use; provider "failure" releases the
 * order for a fresh attempt; any untrusted/unclear answer keeps the 409.
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const ORDER_NUMBER_RE = /^ORD-[0-9]{8}-[0-9A-F]{6}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  const limited = enforceRateLimit(request, 'paymentInit');
  if (limited) return limited;

  const { orderNumber: rawNumber } = await params;
  let orderNumber = '';
  try {
    orderNumber = decodeURIComponent(rawNumber ?? '');
  } catch {
    return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некоректний JSON' }, { status: 400 });
  }

  const token = (body as Record<string, unknown> | null)?.token;
  const incoming = typeof token === 'string' ? token : '';
  if (!ORDER_NUMBER_RE.test(orderNumber)) {
    return NextResponse.json(
      { error: 'Замовлення не знайдено' },
      { status: 404 }
    );
  }

  // Rotating tokens (migration 045): a row with a stored hash verifies ONLY
  // against that hash; NULL-hash rows keep the legacy deterministic HMAC
  // (links issued before 2026-09-12). Unknown number and bad token answer
  // the SAME generic 404, so this row read leaks nothing.
  const hashRes = await supabase
    .from('orders')
    .select('access_token_hash')
    .eq('order_number', orderNumber)
    .maybeSingle();
  const storedHash =
    (hashRes.data as { access_token_hash?: string | null } | null)
      ?.access_token_hash ?? null;
  const tokenOk = storedHash
    ? verifyStoredAccessToken(incoming, storedHash)
    : verifyOrderAccessToken(orderNumber, incoming);
  if (!tokenOk) {
    return NextResponse.json(
      { error: 'Замовлення не знайдено' },
      { status: 404 }
    );
  }

  // Misconfiguration must not crash the handler; it is a 503 for everyone.
  let config;
  try {
    config = getLiqPayConfig();
  } catch {
    return NextResponse.json(
      { error: 'Оплата тимчасово недоступна' },
      { status: 503 }
    );
  }

  const res = await createPaymentInit(
    {
      gateway: createSupabaseOrdersGateway(supabase),
      config,
      verifyToken: () => true, // verified above against the stored row hash
      // result_url carries the SAME verified token the caller already holds.
      // Regression guard: embedding the legacy HMAC here landed paid
      // customers on «Замовлення не знайдено» on rotated (hashed) rows.
      accessToken: () =>
        incoming !== '' ? incoming : orderAccessToken(orderNumber),
      resultUrl: buildResultUrl,
      callbackUrl: buildCallbackUrl,
      // Read-only provider probe (action=status) used ONLY for the
      // stale-pending recovery path; shared, production-verified client.
      providerStatus: (liqpayOrderId) =>
        fetchLiqPayProviderStatus(liqpayOrderId, config.publicKey, config.privateKey),
    },
    { orderNumber, token: typeof token === 'string' ? token : '' }
  );

  switch (res.kind) {
    case 'started':
      return NextResponse.json(
        {
          data: res.data,
          signature: res.signature,
          checkoutUrl: res.checkoutUrl,
        },
        { status: 200 }
      );
    case 'invalid-token':
    case 'not-found':
      return NextResponse.json(
        { error: 'Замовлення не знайдено' },
        { status: 404 }
      );
    case 'already-paid':
      return NextResponse.json(
        { error: 'Замовлення вже оплачено' },
        { status: 409 }
      );
    case 'expired':
      return NextResponse.json(
        { error: 'Термін оплати замовлення минув' },
        { status: 409 }
      );
    case 'closed':
    case 'conflict':
    default:
      return NextResponse.json(
        { error: 'Замовлення недоступне для оплати' },
        { status: 409 }
      );
  }
}
