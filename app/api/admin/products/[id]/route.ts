import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, uuidOrNull, numOrNull, isUuid, dbErrorResponse, toStoragePath } from '@/app/lib/admin-api';

/** Single source of truth mirrors catalog.ts usage across the storefront. */
const ALLOWED_AVAILABILITY = ['in_stock', 'limited_availability', 'out_of_stock'];

function isValidCurrency(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim());
}

// GET /api/admin/products/<id> — full product data for the edit form:
// scalar fields + images + variants.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id товару' }, { status: 400 });
  }

  try {
    const [productRes, imagesRes, variantsRes] = await Promise.all([
      ctx.serviceClient.from('products').select('*').eq('id', id).maybeSingle(),
      ctx.serviceClient
        .from('product_images')
        .select('*')
        .eq('product_id', id)
        .order('sort_order', { ascending: true }),
      ctx.serviceClient
        .from('product_variants')
        .select('*')
        .eq('product_id', id)
        .order('created_at', { ascending: true }),
    ]);

    if (productRes.error) {
      return NextResponse.json({ error: productRes.error.message }, { status: 500 });
    }
    if (!productRes.data) {
      return NextResponse.json({ error: 'Товар не знайдено' }, { status: 404 });
    }
    if (imagesRes.error) {
      return NextResponse.json({ error: imagesRes.error.message }, { status: 500 });
    }
    if (variantsRes.error) {
      return NextResponse.json({ error: variantsRes.error.message }, { status: 500 });
    }

    return NextResponse.json({
      product: productRes.data,
      images: imagesRes.data ?? [],
      variants: variantsRes.data ?? [],
    });
  } catch (err) {
    console.error('Products API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id товару' }, { status: 400 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if ('sku' in body) {
      const sku = strOrNull(body.sku);
      if (!sku) return NextResponse.json({ error: 'SKU не може бути порожнім' }, { status: 400 });
      patch.sku = sku;
    }
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
    if ('short_description' in body) patch.short_description = strOrNull(body.short_description);
    if ('description' in body) patch.description = strOrNull(body.description);
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
      // Distinguish "explicitly cleared" (null / '') from a malformed value:
      // silently coercing "abc" to null would erase the stored old price.
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
    if ('currency' in body) {
      const currency =
        typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
      if (!isValidCurrency(currency)) {
        return NextResponse.json(
          { error: 'Валюта має бути трилітерним кодом (наприклад UAH)' },
          { status: 400 }
        );
      }
      patch.currency = currency;
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
      if (!status || !ALLOWED_AVAILABILITY.includes(status)) {
        return NextResponse.json(
          { error: 'Недопустимий статус наявності' },
          { status: 400 }
        );
      }
      patch.availability_status = status;
    }
    if ('category_id' in body) patch.category_id = uuidOrNull(body.category_id);
    if ('brand_id' in body) patch.brand_id = uuidOrNull(body.brand_id);
    if ('is_active' in body) patch.is_active = Boolean(body.is_active);
    if ('is_featured' in body) patch.is_featured = Boolean(body.is_featured);

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Немає полів для оновлення' }, { status: 400 });
    }

    const { data, error } = await ctx.serviceClient
      .from('products')
      .update(patch)
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося оновити товар');
    }
    if (!data) {
      return NextResponse.json({ error: 'Товар не знайдено' }, { status: 404 });
    }

    return NextResponse.json({ id: data.id });
  } catch (err) {
    console.error('Products API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id товару' }, { status: 400 });
  }

  try {
    // Collect image rows first: the DB rows cascade-delete with the product,
    // but storage objects must be removed explicitly or they would orphan.
    // A failed lookup must abort the deletion — proceeding blindly would
    // silently orphan every storage object of this product.
    const { data: images, error: imagesError } = await ctx.serviceClient
      .from('product_images')
      .select('image_url')
      .eq('product_id', id);

    if (imagesError) {
      console.error('Failed to list images before product delete:', imagesError.message);
      return NextResponse.json(
        { error: 'Не вдалося підготувати видалення товару. Спробуйте ще раз' },
        { status: 500 }
      );
    }

    const { data, error } = await ctx.serviceClient
      .from('products')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося видалити товар');
    }
    if (!data) {
      return NextResponse.json({ error: 'Товар не знайдено' }, { status: 404 });
    }

    // Best-effort storage cleanup after the product row is gone.
    const paths = (images ?? [])
      .map((row) => toStoragePath(row.image_url))
      .filter((path) => path.length > 0);

    if (paths.length > 0) {
      const { error: removeError } = await ctx.serviceClient.storage
        .from('product_images')
        .remove(paths);
      if (removeError) {
        console.error('Failed to remove product images from storage:', removeError.message);
      }
    }

    return NextResponse.json({ id: data.id });
  } catch (err) {
    console.error('Products API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
