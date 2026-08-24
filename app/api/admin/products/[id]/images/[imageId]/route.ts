import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, numOrNull, isUuid, dbErrorResponse, toStoragePath } from '@/app/lib/admin-api';
import { planMainPromotion } from '@/app/lib/admin-image-main';

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

    // Whitelisted side-fields only. is_main is handled separately below.
    const baseFields: Record<string, unknown> = {};
    if ('alt' in body) baseFields.alt = strOrNull(body.alt);
    if ('sort_order' in body) {
      const sort = numOrNull(body.sort_order);
      baseFields.sort_order = sort === null ? 0 : Math.trunc(sort);
    }
    const wantsMain = 'is_main' in body && Boolean(body.is_main);

    if (Object.keys(baseFields).length === 0 && !('is_main' in body)) {
      return NextResponse.json({ error: 'Немає полів для оновлення' }, { status: 400 });
    }

    // Ownership + current main state in ONE product_id-guarded read.
    const { data: target, error: targetError } = await ctx.serviceClient
      .from('product_images')
      .select('id,is_main')
      .eq('id', imageId)
      .eq('product_id', id)
      .maybeSingle();

    if (targetError) {
      return dbErrorResponse(targetError, 'Не вдалося оновити зображення');
    }
    if (!target) {
      return NextResponse.json({ error: 'Зображення не знайдено' }, { status: 404 });
    }

    // ---- plain patch (alt/sort_order and/or explicit is_main=false) ----
    if (!wantsMain) {
      const fields = { ...baseFields };
      if ('is_main' in body) fields.is_main = false;
      const { data, error } = await ctx.serviceClient
        .from('product_images')
        .update(fields)
        .eq('id', imageId)
        .eq('product_id', id)
        .select('*')
        .maybeSingle();
      if (error) return dbErrorResponse(error, 'Не вдалося оновити зображення');
      if (!data) return NextResponse.json({ error: 'Зображення не знайдено' }, { status: 404 });
      return NextResponse.json({ image: data });
    }

    // ---- make-main flow (F13): demote previous main BEFORE promote ----
    // The partial UNIQUE (product_id) WHERE is_main = TRUE rejects any
    // transient two-main state, so the promote must never run first.
    const targetIsAlreadyMain = target.is_main === true;

    let otherMainId: string | null = null;
    if (!targetIsAlreadyMain) {
      const { data: otherMain } = await ctx.serviceClient
        .from('product_images')
        .select('id')
        .eq('product_id', id)
        .eq('is_main', true)
        .neq('id', imageId)
        .maybeSingle();
      otherMainId = otherMain?.id ?? null;
    }

    for (const step of planMainPromotion({ targetIsAlreadyMain, otherMainId })) {
      if (step.op === 'demote-current-main') {
        // Both guards: row belongs to THIS product, exact id.
        const { error: demoteError } = await ctx.serviceClient
          .from('product_images')
          .update({ is_main: false })
          .eq('id', step.id)
          .eq('product_id', id);
        if (demoteError) {
          return dbErrorResponse(demoteError, 'Не вдалося оновити зображення');
        }
        continue;
      }
      // patch-target: apply requested side-fields; the main flag itself is
      // written only when it actually changes (already-main → pure no-op).
      const fields: Record<string, unknown> = { ...baseFields };
      if (step.includeIsMain) fields.is_main = true;
      if (Object.keys(fields).length === 0) {
        const { data: current } = await ctx.serviceClient
          .from('product_images')
          .select('*')
          .eq('id', imageId)
          .eq('product_id', id)
          .maybeSingle();
        return NextResponse.json({ image: current });
      }
      const { data, error } = await ctx.serviceClient
        .from('product_images')
        .update(fields)
        .eq('id', imageId)
        .eq('product_id', id)
        .select('*')
        .maybeSingle();
      if (error) {
        // Theoretically reachable only via a concurrent admin PUT racing
        // between our demote and this promote (F13 keeps local correctness;
        // full serialization is out of scope).
        if (error.code === '23505') {
          return NextResponse.json(
            { error: 'У товарі вже є головне зображення. Оновіть сторінку та спробуйте ще раз' },
            { status: 409 }
          );
        }
        return dbErrorResponse(error, 'Не вдалося оновити зображення');
      }
      if (!data) {
        return NextResponse.json({ error: 'Зображення не знайдено' }, { status: 404 });
      }
      return NextResponse.json({ image: data });
    }
    // Unreachable: planMainPromotion always returns at least one step.
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
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
