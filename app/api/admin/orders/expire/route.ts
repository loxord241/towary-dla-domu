import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';

/**
 * POST /api/admin/orders/expire — manual/scheduler trigger for
 * expire_pending_orders(). Automatic path is the pg_cron job from
 * migration 008; this endpoint lets an operator (or any external
 * scheduler holding the service key) run the same atomic sweep.
 *
 * Returns how many orders were expired — safe to call repeatedly:
 * the RPC re-selects only still-pending expired rows each run.
 */
export async function POST() {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  try {
    const { data, error } = await ctx.serviceClient.rpc('expire_pending_orders', {
      p_batch_limit: 200,
    });

    if (error) {
      console.error('expire_pending_orders failed:', error.message);
      return NextResponse.json({ error: 'Не вдалося виконати скасування прострочених замовлень' }, { status: 500 });
    }

    return NextResponse.json({ result: data });
  } catch (err) {
    console.error('Order expiration API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
