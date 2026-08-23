import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, numOrNull, isUuid, dbErrorResponse, toStoragePath } from '@/app/lib/admin-api';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PUT /api/admin/products/<id>/images/<imageId> — update alt/sort_order/is_main.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; imageId: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id, imageId } = await params;

  if (!isUuid(id) || !UUID_RE.test(imageId)) {
    return NextResponse.json({ error: 'Некоректний id зображення' }, { status: 400 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if ('alt' in body) patch.alt = strOrNull(body.alt);
    if ('sort_order' in body) {
      const sort = numOrNull(body.sort_order);
      patch.sort_order = sort === null ? 0 : Math.trunc(sort);
    }
    if ('is_main' in body) patch.is_main = Boolean(body.is_main);

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Немає полів для оновлення' }, { status: 400 });
    }

    // Update the target row FIRST, then clear the siblings' main flag:
    // clearing first would leave zero main images if the targeted update
    // fails (concurrent delete, transient error).
    const { data, error } = await ctx.serviceClient
      .from('product_images')
      .update(patch)
      .eq('id', imageId)
      .eq('product_id', id)
      .select('*')
      .maybeSingle();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося оновити зображення');
    }
    if (!data) {
      return NextResponse.json({ error: 'Зображення не знайдено' }, { status: 404 });
    }

    if (patch.is_main === true) {
      const { error: unsetError } = await ctx.serviceClient
        .from('product_images')
        .update({ is_main: false })
        .eq('product_id', id)
        .eq('is_main', true)
        .neq('id', imageId);
      if (unsetError) {
        console.error('Failed to clear previous main image flags:', unsetError.message);
      }
    }

    return NextResponse.json({ image: data });
  } catch (err) {
    console.error('Product images API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

// DELETE /api/admin/products/<id>/images/<imageId> — remove the DB row and
// the underlying storage object.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; imageId: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id, imageId } = await params;

  if (!isUuid(id) || !UUID_RE.test(imageId)) {
    return NextResponse.json({ error: 'Некоректний id зображення' }, { status: 400 });
  }

  try {
    const { data: existing } = await ctx.serviceClient
      .from('product_images')
      .select('id, image_url')
      .eq('id', imageId)
      .eq('product_id', id)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: 'Зображення не знайдено' }, { status: 404 });
    }

    const { error } = await ctx.serviceClient
      .from('product_images')
      .delete()
      .eq('id', imageId)
      .eq('product_id', id);

    if (error) {
      return dbErrorResponse(error, 'Не вдалося видалити зображення');
    }

    const storagePath = toStoragePath(existing.image_url);
    if (storagePath) {
      const { error: removeError } = await ctx.serviceClient.storage
        .from('product_images')
        .remove([storagePath]);
      if (removeError) {
        // Row is already gone; surface the storage problem but not fail hard.
        console.error('Failed to remove storage object:', removeError.message);
      }
    }

    return NextResponse.json({ id: existing.id });
  } catch (err) {
    console.error('Product images API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
