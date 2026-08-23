import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, dbErrorResponse } from '@/app/lib/admin-api';

const FIELDS = ['id', 'name', 'slug', 'description', 'logo', 'is_active', 'created_at', 'updated_at'] as const;

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  try {
    let query = ctx.serviceClient.from('brands').select(FIELDS.join(', '));

    if (action === 'active') {
      query = query.eq('is_active', true).order('name');
    } else {
      // Full admin listing (default when no action is provided).
      query = query.order('created_at', { ascending: false });
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ brands: data ?? [] });
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
      .select(FIELDS.join(', '))
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

