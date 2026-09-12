import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  generateOrderAccessToken,
  hashOrderAccessToken,
  orderAccessToken,
} from '@/app/lib/order-token';
import { enforceRateLimit } from '@/app/lib/rate-limit';

/**
 * POST /api/orders/lookup — guest order lookup.
 *
 * The capability pair is (order_number, email). A wrong number and a wrong
 * email produce the SAME generic 404 so the endpoint cannot be used to
 * enumerate orders or confirm which emails exist. On success it returns an
 * HMAC access token that authorizes viewing /orders/<number>?t=<token>.
 *
 * Orders are RLS-protected (anon has no SELECT), so the lookup itself must
 * read via the service key server-side. Input shape is validated strictly;
 * no SQL or PostgREST details are ever returned to the client.
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const ORDER_NUMBER_RE = /^ORD-[0-9]{8}-[0-9A-F]{6}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Shared hourly ceiling on FAILED lookups (whole site, DB-backed — the
// in-memory per-IP limiter is per-instance on serverless). A flood ceiling,
// not an exact quota: check-then-increment races may overshoot slightly.
const LOOKUP_FAIL_CAP = 100;
const FAIL_WINDOW_MS = 60 * 60 * 1000;

async function failedLookupCount(): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from('failed_lookup_counters')
      .select('count, window_started_at')
      .eq('name', 'orders_lookup')
      .maybeSingle();
    if (error) throw error;
    if (!data) return 0;
    const fresh =
      Date.parse(data.window_started_at) > Date.now() - FAIL_WINDOW_MS;
    return fresh ? (data.count ?? 0) : 0;
  } catch (err) {
    // Counter unavailable (migration not applied yet / transient): fail
    // OPEN — the per-IP limiter still applies, and brute force still
    // requires guessing both number and email.
    console.error('failed-lookup counter read failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'lookup');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некоректний JSON' }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const orderNumber =
    typeof b.orderNumber === 'string' ? b.orderNumber.trim().toUpperCase() : '';
  const email =
    typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';

  if (!ORDER_NUMBER_RE.test(orderNumber) || !EMAIL_RE.test(email) || email.length > 254) {
    // Same generic answer for malformed input — no oracle about formats.
    return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 404 });
  }

  const failCount = await failedLookupCount();
  if (failCount !== null && failCount >= LOOKUP_FAIL_CAP) {
    return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 429 });
  }

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('order_number')
      .eq('order_number', orderNumber)
      .eq('email', email)
      .maybeSingle();

    if (error) {
      console.error('orders lookup failed:', error.message);
      return NextResponse.json(
        { error: 'Не вдалося виконати пошук. Спробуйте пізніше' },
        { status: 500 }
      );
    }
    if (!data) {
      // Record the miss for the shared brute-force ceiling; a counter
      // failure must not change the answer (best effort).
      const { error: counterError } = await supabase.rpc('record_failed_lookup');
      if (counterError) {
        console.error('failed-lookup counter write failed:', counterError.message);
      }
      return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 404 });
    }

    // Email + order number proved identity → ROTATE the capability token
    // (audit P1: the deterministic HMAC was eternal; a leaked URL now dies
    // on the first successful lookup). The fresh link is shown on screen
    // immediately. If the rotation write fails, fall back to the legacy
    // HMAC (valid for NULL-hash rows) — lookup must not break over a token.
    let accessToken: string;
    try {
      accessToken = generateOrderAccessToken();
      const { error: tokenError } = await supabase
        .from('orders')
        .update({ access_token_hash: hashOrderAccessToken(accessToken) })
        .eq('order_number', data.order_number);
      if (tokenError) throw new Error(tokenError.message);
    } catch (err) {
      console.error(
        'lookup token rotation failed:',
        err instanceof Error ? err.name : 'error'
      );
      accessToken = orderAccessToken(data.order_number);
    }

    return NextResponse.json({
      orderNumber: data.order_number,
      accessToken,
    });
  } catch (err) {
    console.error('orders lookup error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
