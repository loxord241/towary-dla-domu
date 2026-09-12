import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, uuidOrNull, numOrNull, isUuid, parseCategoryIds, dbErrorResponse, toStoragePath } from '@/app/lib/admin-api';
import { sanitizeYcDescription } from '@/app/lib/yugcontract/content-sanitize';
import {
  MAX_FEATURED_PRODUCTS,
  FEATURED_LIMIT_MESSAGE,
  countFeaturedProducts,
  decideFeaturedToggle,
} from '@/app/lib/featured-limit';

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
    const [productRes, imagesRes, variantsRes, categoryLinksRes] = await Promise.all([
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
      ctx.serviceClient
        .from('product_categories')
        .select('category_id')
        .eq('product_id', id),
    ]);

    if (productRes.error) {
      console.error('admin product fetch failed:', productRes.error.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }
    if (!productRes.data) {
      return NextResponse.json({ error: 'Товар не знайдено' }, { status: 404 });
    }
    if (imagesRes.error) {
      console.error('admin product images fetch failed:', imagesRes.error.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }
    if (variantsRes.error) {
      console.error('admin product variants fetch failed:', variantsRes.error.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }
    if (categoryLinksRes.error) {
      console.error('admin product links fetch failed:', categoryLinksRes.error.message);
      return NextResponse.json(
        { error: 'Внутрішня помилка сервера' },
        { status: 500 }
      );
    }

    // Direct assignments only; deterministic order for the form.
    const categoryIds = ((categoryLinksRes.data ?? []) as { category_id: string }[])
      .map((r) => r.category_id)
      .sort();

    return NextResponse.json({
      product: productRes.data,
      images: imagesRes.data ?? [],
      variants: variantsRes.data ?? [],
      category_ids: categoryIds,
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
    if ('description' in body) {
      const rawDescription = strOrNull(body.description);
      // The storefront renders this field as raw HTML (ProductDescription),
      // so the "always sanitized" invariant (same allowlist as the import
      // path) must hold for admin edits too.
      patch.description = rawDescription === null ? null : sanitizeYcDescription(rawDescription);
    }
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
    // Multi-category payload: strict validation BEFORE any db touch;
    // the legacy column gets the FIRST selected category (transition
    // default) or null when the set is emptied.
    let categoryIds: string[] | null = null;
    if ('category_ids' in body) {
      const parsed = parseCategoryIds(body.category_ids);
      if (parsed === null) {
        return NextResponse.json({ error: 'Некоректний id категорії' }, { status: 400 });
      }
      categoryIds = parsed;
      patch.category_id = categoryIds[0] ?? null; // overrides legacy field
    }
    if ('brand_id' in body) patch.brand_id = uuidOrNull(body.brand_id);
    if ('is_active' in body) patch.is_active = Boolean(body.is_active);
    if ('is_featured' in body) {
      const requested = Boolean(body.is_featured);
      patch.is_featured = requested;

      if (requested) {
        // Pre-check against the max-8 business rule BEFORE the update.
        // Current state matters: an already-featured product staying on is
        // a no-op, not a new slot.
        const [currentRes, featuredCountBefore] = await Promise.all([
          ctx.serviceClient
            .from('products')
            .select('id, is_featured')
            .eq('id', id)
            .maybeSingle(),
          countFeaturedProducts(ctx.serviceClient),
        ]);
        if (currentRes.error || !currentRes.data) {
          return NextResponse.json({ error: 'Товар не знайдено' }, { status: 404 });
        }
        const decision = decideFeaturedToggle({
          currentlyFeatured: Boolean(currentRes.data.is_featured),
          requestedFeatured: true,
          featuredCount: featuredCountBefore,
        });
        if (!decision.allowed) {
          return NextResponse.json({ error: FEATURED_LIMIT_MESSAGE }, { status: 409 });
        }
      }
    }

    if ('is_selected' in body) {
      // Independent «Обрані» flag (migration 028): plain boolean, no
      // shared state with the featured max-8 rule.
      patch.is_selected = Boolean(body.is_selected);
    }

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

    // Replace-all junction sync (only when the payload carries category_ids):
    // delete everything not wanted, insert what is missing. Empty array
    // clears every link (patch.category_id already null).
    if (categoryIds !== null) {
      const want = new Set(categoryIds);
      const { data: current, error: readErr } = await ctx.serviceClient
        .from('product_categories')
        .select('category_id')
        .eq('product_id', id);
      if (readErr) {
        console.error('Failed to read product category links:', readErr.message);
        return NextResponse.json({ error: 'Не вдалося зберегти категорії товару' }, { status: 500 });
      }
      const have = new Set(((current ?? []) as { category_id: string }[]).map((r) => r.category_id));
      const toInsert = [...want].filter((c) => !have.has(c)).map((c) => ({ product_id: id, category_id: c }));
      if (toInsert.length > 0) {
        const { error: insErr } = await ctx.serviceClient
          .from('product_categories')
          .insert(toInsert);
        if (insErr) {
          console.error('Failed to insert product category links:', insErr.message);
          return NextResponse.json({ error: 'Не вдалося зберегти категорії товару' }, { status: 500 });
        }
      }
      if (want.size === 0 && have.size > 0) {
        const { error: delErr } = await ctx.serviceClient
          .from('product_categories')
          .delete()
          .eq('product_id', id);
        if (delErr) {
          console.error('Failed to clear product category links:', delErr.message);
          return NextResponse.json({ error: 'Не вдалося зберегти категорії товару' }, { status: 500 });
        }
      } else if (have.size > 0) {
        const toRemove = [...have].filter((c) => !want.has(c));
        if (toRemove.length > 0) {
          const { error: delErr } = await ctx.serviceClient
            .from('product_categories')
            .delete()
            .eq('product_id', id)
            .in('category_id', toRemove);
          if (delErr) {
            console.error('Failed to remove product category links:', delErr.message);
            return NextResponse.json({ error: 'Не вдалося зберегти категорії товару' }, { status: 500 });
          }
        }
      }
    }

    // Race guard: parallel admins could both pass the pre-check. Whoever
    // pushes the count OVER the cap reverts THEIR OWN toggle — the state
    // converges back to ≤8 and nobody else's product is silently removed.
    // Honest residual: a sub-second transient window above the cap is
    // possible between UPDATE and this recount; full serialization would
    // need an RPC/advisory-lock migration (separate GO).
    if (patch.is_featured === true) {
      const featuredCountAfter = await countFeaturedProducts(ctx.serviceClient);
      if (featuredCountAfter > MAX_FEATURED_PRODUCTS) {
        await ctx.serviceClient
          .from('products')
          .update({ is_featured: false })
          .eq('id', id);
        return NextResponse.json({ error: FEATURED_LIMIT_MESSAGE }, { status: 409 });
      }
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

    // Restock requests (migration 042) reference products WITHOUT a cascade
    // until 043 is applied: hard-delete would fail with an FK violation
    // (23503 → 500). Clear this product's requests first so the delete works
    // both before and after 043; with the 043 FK cascade in place this is a
    // harmless no-op. A failed cleanup must abort the deletion — proceeding
    // would turn the request rows' FK into a hard 500 anyway.
    const { error: restockError } = await ctx.serviceClient
      .from('restock_requests')
      .delete()
      .eq('product_id', id);

    if (restockError) {
      console.error('Failed to clear restock requests before product delete:', restockError.message);
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
