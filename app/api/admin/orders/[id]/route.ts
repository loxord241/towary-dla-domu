import { NextResponse } from 'next/server';
import { requireAdminApi, isUuid } from '@/app/lib/admin-api';
import {
  decideAdminCancellation,
  PAID_CANCEL_REJECTION_MESSAGE,
} from '@/app/lib/admin-order-cancel';

/**
 * GET   /api/admin/orders/[id] — full order details (order + items).
 * PATCH /api/admin/orders/[id] — body { status } only. Status transitions are
 * validated and applied atomically inside service-role RPCs:
 *   'cancelled' -> admin_cancel_order  (one-shot stock restore + history)
 *   otherwise   -> admin_set_order_status (forward-only transition map)
 * The client can never set payment_status, prices, or stock.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id замовлення' }, { status: 400 });
  }

  try {
    const [orderRes, itemsRes] = await Promise.all([
      ctx.serviceClient
        .from('orders')
        .select(
          'id, order_number, email, status, payment_status, subtotal, shipping_total, total_amount, currency, customer_info, shipping_info, created_at, updated_at'
        )
        .eq('id', id)
        .maybeSingle(),
      ctx.serviceClient
        .from('order_items')
        .select(
          'product_id, variant_id, product_name, sku, variant_name, variant_sku, quantity, price, total'
        )
        .eq('order_id', id),
    ]);

    if (orderRes.error) {
      console.error('admin order fetch failed:', orderRes.error.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }
    if (!orderRes.data) {
      return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 404 });
    }
    if (itemsRes.error) {
      console.error('admin order items fetch failed:', itemsRes.error.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      order: orderRes.data,
      items: itemsRes.data ?? [],
    });
  } catch (err) {
    console.error('Admin order detail API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id замовлення' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некоректний JSON' }, { status: 400 });
  }

  // Whitelist the single mutable field. payment_status/prices/stock are not
  // addressable through this endpoint at all.
  const status =
    typeof (body as { status?: unknown })?.status === 'string'
      ? ((body as { status: string }).status).trim()
      : '';
  if (!status || !['pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned'].includes(status)) {
    return NextResponse.json({ error: 'Невідомий статус' }, { status: 400 });
  }

  try {
    // B2 interlock (server-side, effective even before migration 018 lands):
    // a paid order must never be cancellable through the plain admin flow —
    // stock would be restored while the customer stays charged. The DB-level
    // guard in admin_cancel_order (018) remains the authoritative backstop.
    if (status === 'cancelled') {
      const { data: guardRow, error: guardError } = await ctx.serviceClient
        .from('orders')
        .select('payment_status')
        .eq('id', id)
        .maybeSingle();
      if (guardError) {
        console.error('admin cancel guard read failed:', guardError.code);
        return NextResponse.json(
          { error: 'Не вдалося змінити статус замовлення' },
          { status: 500 }
        );
      }
      const decision = decideAdminCancellation({
        payment_status: guardRow?.payment_status ?? null,
      });
      if (!decision.allowed) {
        return NextResponse.json(
          { error: PAID_CANCEL_REJECTION_MESSAGE },
          { status: 409 }
        );
      }
    }

    const rpcName = status === 'cancelled' ? 'admin_cancel_order' : 'admin_set_order_status';
    const rpcArgs =
      status === 'cancelled' ? { p_order_id: id } : { p_order_id: id, p_new_status: status };

    const { data, error } = await ctx.serviceClient.rpc(rpcName, rpcArgs);

    if (error) {
      console.error(`admin order RPC failed (${rpcName}):`, error.code, error.message);
      switch (error.code) {
        case 'P0400':
          return NextResponse.json({ error: 'Недопустимий статус' }, { status: 400 });
        case 'P0404':
          return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 404 });
        case 'P0409':
          return NextResponse.json(
            { error: 'Недопустимий перехід статусу або замовлення вже скасовано' },
            { status: 409 }
          );
        default:
          return NextResponse.json(
            { error: 'Не вдалося змінити статус замовлення' },
            { status: 500 }
          );
      }
    }

    return NextResponse.json({ result: data });
  } catch (err) {
    console.error('Admin order patch API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
