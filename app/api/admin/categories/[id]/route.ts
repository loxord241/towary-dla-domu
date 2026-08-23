import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, uuidOrNull, numOrNull, isUuid, dbErrorResponse } from '@/app/lib/admin-api';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id категорію' }, { status: 400 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if ('name' in body) {
      const name = strOrNull(body.name);
      if (!name) return NextResponse.json({ error: 'Назва не може бути порожньою' }, { status: 400 });
      patch.name = name;
    }
    if ('slug' in body) {
      const slug = strOrNull(body.slug);
      if (!slug) return NextResponse.json({ error: 'Slug не може бути порожнім' }, { status: 400 });
      patch.slug = slug;
    }
    if ('description' in body) patch.description = strOrNull(body.description);
    if ('parent_id' in body) patch.parent_id = uuidOrNull(body.parent_id);
    if ('image' in body) patch.image = strOrNull(body.image);
    if ('sort_order' in body) {
      const sort = numOrNull(body.sort_order);
      patch.sort_order = sort === null ? 0 : Math.trunc(sort);
    }
    if ('is_active' in body) patch.is_active = Boolean(body.is_active);

    // Guard against self-parenting.
    if (patch.parent_id === id) {
      return NextResponse.json({ error: 'Категорія не може бути власним батьком' }, { status: 400 });
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Немає полів для оновлення' }, { status: 400 });
    }

    const { data, error } = await ctx.serviceClient
      .from('categories')
      .update(patch)
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося оновити категорію');
    }
    if (!data) {
      return NextResponse.json({ error: 'Категорію не знайдено' }, { status: 404 });
    }

    return NextResponse.json({ id: data.id });
  } catch (err) {
    console.error('Categories API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id категорію' }, { status: 400 });
  }

  try {
    const { data, error } = await ctx.serviceClient
      .from('categories')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: 'Категорію не знайдено' }, { status: 404 });
    }

    return NextResponse.json({ id: data.id });
  } catch (err) {
    console.error('Categories API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
