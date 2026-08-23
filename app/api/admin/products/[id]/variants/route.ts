import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, numOrNull, nonNegNumOrNull, isUuid, dbErrorResponse } from '@/app/lib/admin-api';

// GET /api/admin/products/<id>/variants — list product variants.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id товару' }, { status: 400 });
  }

  try {
    const { data, error } = await ctx.serviceClient
      .from('product_variants')
      .select('*')
      .eq('product_id', id)
      .order('created_at', { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ variants: data ?? [] });
  } catch (err) {
    console.error('Product variants API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

// POST /api/admin/products/<id>/variants — create a variant.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id товару' }, { status: 400 });
  }

  try {
    // Ensure the product exists.
    const { data: product } = await ctx.serviceClient
      .from('products')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!product) {
      return NextResponse.json({ error: 'Товар не знайдено' }, { status: 404 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const price = numOrNull(body.price);

    if (!name) {
      return NextResponse.json({ error: 'Вкажіть назву варіанту' }, { status: 400 });
    }
    if (price === null || price < 0) {
      return NextResponse.json(
        { error: 'Ціна має бути невід’ємним числом' },
        { status: 400 }
      );
    }

    const stock = numOrNull(body.stock_quantity);
    if (stock !== null && stock < 0) {
      return NextResponse.json(
        { error: 'Залишок не може бути від’ємним' },
        { status: 400 }
      );
    }

    const oldPrice = nonNegNumOrNull(body.old_price);
    if (oldPrice === null && body.old_price !== null && body.old_price !== undefined && body.old_price !== '') {
      return NextResponse.json(
        { error: 'Стара ціна має бути невід’ємним числом або порожньою' },
        { status: 400 }
      );
    }

    const { data, error } = await ctx.serviceClient
      .from('product_variants')
      .insert({
        product_id: id,
        name,
        sku: strOrNull(body.sku),
        price,
        old_price: oldPrice,
        stock_quantity: stock === null ? 0 : Math.trunc(stock),
        availability_status: strOrNull(body.availability_status) ?? 'in_stock',
        is_active: body.is_active === undefined ? true : Boolean(body.is_active),
      })
      .select('*')
      .single();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося створити варіант');
    }

    return NextResponse.json({ variant: data }, { status: 201 });
  } catch (err) {
    console.error('Product variants API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
