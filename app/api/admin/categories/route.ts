import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, uuidOrNull, numOrNull, dbErrorResponse } from '@/app/lib/admin-api';
import {
  CATEGORY_FIELDS_LIST,
  CATEGORY_SORT_KEYS,
  parseAdminListParams,
  listAdminCategories,
  fetchAllCategories,
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
        .from('categories')
        .select(CATEGORY_FIELDS_LIST)
        .eq('is_active', true)
        .order('sort_order')
        .order('id');
      if (error) {
        console.error('admin categories tree failed:', error.message);
        return NextResponse.json(
          { error: 'Внутрішня помилка сервера' },
          { status: 500 }
        );
      }
      return NextResponse.json({ categories: data ?? [] });
    }

    if (action === 'all') {
      // Bounded full-set read for form dropdowns — the product form's
      // category/brand pickers and the category parent picker need every
      // row, not just the current page of the listing.
      const categories = await fetchAllCategories(ctx.serviceClient);
      return NextResponse.json({ categories });
    }

    // Default admin listing: server-side search + sort + pagination.
    // Search runs BEFORE pagination — DB or= filter → COUNT(filtered) →
    // range window; total/page/size describe the filtered set. Categories
    // are the largest admin table after products (205 rows today), so the
    // unbounded SELECT this branch used before is also gone.
    const params = parseAdminListParams(searchParams, CATEGORY_SORT_KEYS);
    const result = await listAdminCategories(ctx.serviceClient, params);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Categories API error:', err);
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

    const sortOrder = numOrNull(body.sort_order);

    const { data, error } = await ctx.serviceClient
      .from('categories')
      .insert({
        name,
        slug,
        description: strOrNull(body.description),
        parent_id: uuidOrNull(body.parent_id),
        image: strOrNull(body.image),
        sort_order: sortOrder === null ? 0 : Math.trunc(sortOrder),
        is_active: body.is_active === undefined ? true : Boolean(body.is_active),
      })
      .select(CATEGORY_FIELDS_LIST)
      .single();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося створити категорію');
    }

    return NextResponse.json({ category: data }, { status: 201 });
  } catch (err) {
    console.error('Categories API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
