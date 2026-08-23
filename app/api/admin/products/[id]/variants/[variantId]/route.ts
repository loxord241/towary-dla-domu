import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, numOrNull, isUuid, dbErrorResponse } from '@/app/lib/admin-api';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PUT /api/admin/products/<id>/variants/<variantId> — update a variant.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; variantId: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id, variantId } = await params;

  if (!isUuid(id) || !UUID_RE.test(variantId)) {
    return NextResponse.json({ error: 'Некоректний id варіанту' }, { status: 400 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if ('name' in body) {
      const name = strOrNull(body.name);
      if (!name) return NextResponse.json({ error: 'Назва не може бути порожньою' }, { status: 400 });
      patch.name = name;
    }
    if ('sku' in body) patch.sku = strOrNull(body.sku);
    if ('price' in body) {
      const price = numOrNull(body.price);
      if (price === null || price < 0) {
        return NextResponse.json(
          { error: 'Ціна має бути невід’ємним числом' },
          { status: 400 }
        );
      }
      patch.price = price;
    }
    if ('old_price' in body) {
      // "abc" must not silently clear the stored value (see products PUT).
      if (body.old_price === null || body.old_price === '') {
        patch.old_price = null;
      } else {
        const oldPrice = numOrNull(body.old_price);
        if (oldPrice === null || oldPrice < 0) {
          return NextResponse.json(
            { error: 'Стара ціна має бути невід’ємним числом або порожньою' },
            { status: 400 }
          );
        }
        patch.old_price = oldPrice;
      }
    }
    if ('stock_quantity' in body) {
      const stock = numOrNull(body.stock_quantity);
      if (stock === null || stock < 0) {
        return NextResponse.json(
          { error: 'Залишок має бути невід’ємним цілим числом' },
          { status: 400 }
        );
      }
      patch.stock_quantity = Math.trunc(stock);
    }
    if ('availability_status' in body) {
      const status = strOrNull(body.availability_status);
      if (!status || !['in_stock', 'limited_availability', 'out_of_stock'].includes(status)) {
        return NextResponse.json(
          { error: 'Недопустимий статус наявності' },
          { status: 400 }
        );
      }
      patch.availability_status = status;
    }
    if ('is_active' in body) patch.is_active = Boolean(body.is_active);

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Немає полів для оновлення' }, { status: 400 });
    }

    const { data, error } = await ctx.serviceClient
      .from('product_variants')
      .update(patch)
      .eq('id', variantId)
      .eq('product_id', id)
      .select('*')
      .maybeSingle();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося оновити варіант');
    }
    if (!data) {
      return NextResponse.json({ error: 'Варіант не знайдено' }, { status: 404 });
    }

    return NextResponse.json({ variant: data });
  } catch (err) {
    console.error('Product variants API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

// DELETE /api/admin/products/<id>/variants/<variantId> — delete a variant.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; variantId: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id, variantId } = await params;

  if (!isUuid(id) || !UUID_RE.test(variantId)) {
    return NextResponse.json({ error: 'Некоректний id варіанту' }, { status: 400 });
  }

  try {
    const { data, error } = await ctx.serviceClient
      .from('product_variants')
      .delete()
      .eq('id', variantId)
      .eq('product_id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося видалити варіант');
    }
    if (!data) {
      return NextResponse.json({ error: 'Варіант не знайдено' }, { status: 404 });
    }

    return NextResponse.json({ id: data.id });
  } catch (err) {
    console.error('Product variants API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
