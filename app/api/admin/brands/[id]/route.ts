import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, isUuid, dbErrorResponse } from '@/app/lib/admin-api';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id бренду' }, { status: 400 });
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
    if ('logo' in body) patch.logo = strOrNull(body.logo);
    if ('is_active' in body) patch.is_active = Boolean(body.is_active);

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Немає полів для оновлення' }, { status: 400 });
    }

    const { data, error } = await ctx.serviceClient
      .from('brands')
      .update(patch)
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося оновити бренд');
    }
    if (!data) {
      return NextResponse.json({ error: 'Бренд не знайдено' }, { status: 404 });
    }

    return NextResponse.json({ id: data.id });
  } catch (err) {
    console.error('Brands API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id бренду' }, { status: 400 });
  }

  try {
    const { data, error } = await ctx.serviceClient
      .from('brands')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('admin brand update failed:', error.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Бренд не знайдено' }, { status: 404 });
    }

    return NextResponse.json({ id: data.id });
  } catch (err) {
    console.error('Brands API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
