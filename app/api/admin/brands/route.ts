import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, dbErrorResponse } from '@/app/lib/admin-api';
import {
  BRAND_FIELDS_LIST,
  BRAND_SORT_KEYS,
  parseAdminListParams,
  listAdminBrands,
  fetchAllBrands,
} from '@/app/lib/admin-list';

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  try {
    if (action === 'active') {
      // Legacy full active list (existing consumers).
      const { data, error } = await ctx.serviceClient
        .from('brands')
        .select(BRAND_FIELDS_LIST)
        .eq('is_active', true)
        .order('name');
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({ brands: data ?? [] });
    }

    if (action === 'all') {
      // Bounded full-set read for form dropdowns (paged windows ≤1000).
      const brands = await fetchAllBrands(ctx.serviceClient);
      return NextResponse.json({ brands });
    }

    // Default admin listing: server-side search + sort + pagination.
    // Search runs BEFORE pagination — DB or= filter → COUNT(filtered) →
    // range window; total/page/size describe the filtered set.
    const params = parseAdminListParams(searchParams, BRAND_SORT_KEYS);
    const result = await listAdminBrands(ctx.serviceClient, params);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Brands API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';

    if (!name || !slug) {
      return NextResponse.json({ error: 'Вкажіть назву та slug' }, { status: 400 });
    }

    const { data, error } = await ctx.serviceClient
      .from('brands')
      .insert({
        name,
        slug,
        description: strOrNull(body.description),
        logo: strOrNull(body.logo),
        is_active: body.is_active === undefined ? true : Boolean(body.is_active),
      })
      .select(BRAND_FIELDS_LIST)
      .single();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося створити бренд');
    }

    return NextResponse.json({ brand: data }, { status: 201 });
  } catch (err) {
    console.error('Brands API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
