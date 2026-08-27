import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';

/**
 * GET /api/admin/orders — paginated order list for the admin panel.
 * Filters: ?status=<status>&q=<order_number|email substring>&page=&size=
 * All data is read via the requireAdminApi service client; the publishable
 * surface has no read access to orders (RLS default-deny).
 */

const STATUSES = [
  'pending',
  'confirmed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
] as const;

/** PostgREST or/ ilike expressions break on reserved characters — strip them. */
function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%,()"*]/g, ' ').trim();
}

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);

  const statusParam = searchParams.get('status');
  const status =
    statusParam && (STATUSES as readonly string[]).includes(statusParam)
      ? statusParam
      : null;

  const qRaw = sanitizeSearchTerm(searchParams.get('q') ?? '');
  const q = qRaw.length > 0 && qRaw.length <= 100 ? qRaw : null;

  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const size = Math.min(100, Math.max(1, Number(searchParams.get('size')) || 50));

  // PostgREST returns PGRST103 ("range not satisfiable") when the offset is
  // beyond the row count, so resolve the true total first and clamp the page
  // instead of letting an out-of-range request fail.
  const escapedQ = q ? q.replace(/[%_]/g, '') : null;
  const orFilter =
    escapedQ !== null
      ? `order_number.ilike.%${escapedQ}%,email.ilike.%${escapedQ}%`
      : null;

  try {
    let countQuery = ctx.serviceClient
      .from('orders')
      .select('id', { count: 'exact', head: true });
    if (status) countQuery = countQuery.eq('status', status);
    if (orFilter) countQuery = countQuery.or(orFilter);

    const { count, error: countError } = await countQuery;
    if (countError) {
      console.error('admin orders count failed:', countError.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }

    const safeTotal = count ?? 0;
    const maxPage = Math.max(1, Math.ceil(safeTotal / size));
    const safePage = Math.min(Math.max(1, page), maxPage);

    let dataQuery = ctx.serviceClient
      .from('orders')
      .select(
        'id, order_number, email, status, payment_status, total_amount, currency, customer_info, created_at'
      )
      .order('created_at', { ascending: false })
      // Stable offset pagination: created_at ties (bulk imports) must not
      // shuffle rows across pages.
      .order('id', { ascending: false })
      .range((safePage - 1) * size, safePage * size - 1);
    if (status) dataQuery = dataQuery.eq('status', status);
    if (orFilter) dataQuery = dataQuery.or(orFilter);

    const { data, error } = await dataQuery;
    if (error) {
      console.error('admin orders list failed:', error.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      orders: data ?? [],
      total: safeTotal,
      page: safePage,
      size,
    });
  } catch (err) {
    console.error('Admin orders API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
