import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { orderAccessToken } from '@/app/lib/order-token';
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
      return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 404 });
    }

    return NextResponse.json({
      orderNumber: data.order_number,
      accessToken: orderAccessToken(data.order_number),
    });
  } catch (err) {
    console.error('orders lookup error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
