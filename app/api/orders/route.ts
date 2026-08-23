import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { orderAccessToken } from '@/app/lib/order-token';
import { enforceRateLimit } from '@/app/lib/rate-limit';

/**
 * POST /api/orders — guest checkout.
 *
 * Accepts ONLY contact data + item identifiers/quantities. Prices, names,
 * SKUs, currency, totals and stock are computed exclusively inside
 * place_order() (SECURITY DEFINER) from live database rows — client-sent
 * money values cannot exist in the contract.
 *
 * Error mapping:
 *   400 invalid payload            409 duplicate items
 *   422 unavailable/insufficient   500 unexpected (no internals leaked)
 */

// Server-side anonymous client: RLS + SECURITY DEFINER enforce everything.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { persistSession: false } }
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MAX_ITEMS = 20;
const MAX_QTY = 99;

interface SanitizedItem {
  productId: string;
  variantId: string | null;
  quantity: number;
}

function sanitizeShippingInfo(raw: unknown): Record<string, string> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 10) break;
    if (!/^[a-z_]{1,30}$/.test(key)) continue; // whitelist-ish key shape
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, 300);
    if (trimmed === '') continue;
    out[key] = trimmed;
    count++;
  }
  return out;
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'orders');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некоректний JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Некоректні дані запиту' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // ---- contact ----
  const contact = (b.contact ?? {}) as Record<string, unknown>;
  const name = typeof contact.name === 'string' ? contact.name.trim() : '';
  const email =
    typeof contact.email === 'string' ? contact.email.trim().toLowerCase() : '';
  const phone = typeof contact.phone === 'string' ? contact.phone.trim() : '';

  if (name.length < 1 || name.length > 120) {
    return NextResponse.json({ error: 'Вкажіть ім’я (до 120 символів)' }, { status: 400 });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: 'Вкажіть коректний email' }, { status: 400 });
  }
  if (phone.length > 40) {
    return NextResponse.json({ error: 'Телефон задовгий' }, { status: 400 });
  }

  // ---- shipping ----
  const shippingInfo = sanitizeShippingInfo(b.shipping);

  // ---- items ----
  const rawItems = b.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: 'Кошик порожній або містить забагато позицій' },
      { status: 400 }
    );
  }

  const items: SanitizedItem[] = [];
  const seen = new Set<string>();
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) {
      return NextResponse.json({ error: 'Некоректна позиція кошика' }, { status: 400 });
    }
    const rec = entry as Record<string, unknown>;
    const productId = typeof rec.productId === 'string' ? rec.productId : '';
    const variantRaw = rec.variantId;
    const variantId =
      typeof variantRaw === 'string' && variantRaw.length > 0 ? variantRaw : null;
    const quantity = rec.quantity;

    if (!UUID_RE.test(productId)) {
      return NextResponse.json({ error: 'Некоректний товар у кошику' }, { status: 400 });
    }
    if (variantId !== null && !UUID_RE.test(variantId)) {
      return NextResponse.json({ error: 'Некоректний варіант у кошику' }, { status: 400 });
    }
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QTY
    ) {
      return NextResponse.json(
        { error: `Кількість має бути цілим числом від 1 до ${MAX_QTY}` },
        { status: 400 }
      );
    }

    const key = `${productId}::${variantId ?? ''}`;
    if (seen.has(key)) {
      return NextResponse.json(
        { error: 'Дублікат позиції у кошику' },
        { status: 409 }
      );
    }
    seen.add(key);

    // Whitelist only — price/total/status-like fields are structurally impossible here.
    items.push({ productId, variantId, quantity });
  }

  // ---- place_order RPC ----
  const { data, error } = await supabase.rpc('place_order', {
    payload: {
      email,
      name,
      phone,
      shipping_info: shippingInfo ?? {},
      items: items.map((i) => ({
        product_id: i.productId,
        variant_id: i.variantId,
        quantity: i.quantity,
      })),
    },
  });

  if (error) {
    console.error('place_order failed:', error.code, error.message);
    switch (error.code) {
      case 'P0400':
        return NextResponse.json(
          { error: 'Замовлення містить некоректні дані' },
          { status: 400 }
        );
      case 'P0409':
        return NextResponse.json(
          { error: 'Конфлікт замовлення. Перевірте кошик і спробуйте ще раз' },
          { status: 409 }
        );
      case 'P0422':
        return NextResponse.json(
          {
            error:
              'Товар недоступний або його недостатньо на складі. Оновіть кошик',
          },
          { status: 422 }
        );
      default:
        return NextResponse.json(
          { error: 'Не вдалося оформити замовлення. Спробуйте пізніше' },
          { status: 500 }
        );
    }
  }

  const result = data as
    | { order_id?: string; order_number?: string; total?: number; currency?: string }
    | null;

  if (!result?.order_number) {
    console.error('place_order returned unexpected shape');
    return NextResponse.json(
      { error: 'Не вдалося оформити замовлення. Спробуйте пізніше' },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      orderNumber: result.order_number,
      total: result.total,
      currency: result.currency,
      accessToken: orderAccessToken(result.order_number),
    },
    { status: 201 }
  );
}
