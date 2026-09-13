import { NextResponse } from 'next/server';
import { requireAdminApi, isUuid } from '@/app/lib/admin-api';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /api/admin/orders/[id]/mark-paid — manual payment confirmation for
 * cash-at-pickup orders (owner 2026-09-13: «не через liq нельзя подтвердить
 * что он оплатил»).
 *
 * Contract:
 *  - admin-guarded; service-role writes;
 *  - conditional update: an already-paid order is NEVER overwritten (the
 *    same invariant as the LiqPay callback path);
 *  - payment_method is stamped «готівка на точці» unless already set;
 *  - a still-pending order is advanced to `confirmed` via the SAME
 *    admin_set_order_status RPC the PATCH route uses (отметил оплату =
 *    заказ подтверждён) — a forward-only transition, so no forbidden state;
 *  - a failed status advance does NOT roll back the paid flag (money is
 *    fact); the response reports both outcomes.
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

export async function POST(
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
    const { data: order } = await supabase
      .from('orders')
      .select('id, status, payment_status')
      .eq('id', id)
      .maybeSingle();
    const row = order as
      | { id: string; status: string; payment_status: string }
      | null;
    if (!row) {
      return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 404 });
    }

    let payment: 'ok' | 'already-paid' = 'ok';
    if (row.payment_status !== 'paid') {
      const { data: updated, error } = await supabase
        .from('orders')
        .update({ payment_status: 'paid', payment_method: 'готівка на точці' })
        .eq('id', id)
        .neq('payment_status', 'paid')
        .select('id');
      if (error) {
        console.error('mark-paid: payment update failed:', error.code);
        return NextResponse.json(
          { error: 'Не вдалося позначити оплату. Спробуйте ще раз' },
          { status: 500 }
        );
      }
      payment = (updated ?? []).length > 0 ? 'ok' : 'already-paid';
    }

    let status: 'ok' | 'skipped' = 'skipped';
    if (row.status === 'pending') {
      const { error } = await supabase.rpc('admin_set_order_status', {
        p_order_id: id,
        p_new_status: 'confirmed',
      });
      if (!error || error.code === 'P0409') status = 'ok';
    } else {
      status = 'ok';
    }

    return NextResponse.json({
      ok: true,
      payment,
      status,
    });
  } catch {
    return NextResponse.json(
      { error: 'Внутрішня помилка сервера' },
      { status: 500 }
    );
  }
}
