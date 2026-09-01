import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdminApi, strOrNull, uuidOrNull, nonNegNumOrNull, parseCategoryIds, dbErrorResponse } from '@/app/lib/admin-api';
import {
  MAX_FEATURED_PRODUCTS,
  FEATURED_LIMIT_MESSAGE,
  countFeaturedProducts,
  decideFeaturedToggle,
} from '@/app/lib/featured-limit';
import {
  PRODUCT_SELECT,
  PRODUCT_SORT_KEYS,
  parseAdminListParams,
  listAdminProducts,
  normalizeProduct,
  type ProductJoinedRow,
} from '@/app/lib/admin-list';
import { sanitizeYcDescription } from '@/app/lib/yugcontract/content-sanitize';

/**
 * Full filtered read via paged windows. These branches promise the whole
 * matching set in `{ products }`; an unbounded select silently truncated
 * it at the PostgREST max_rows cap (live: action=active returned 1000 of
 * 4323). `id desc` is the deterministic tiebreaker for bulk-imported rows
 * sharing created_at.
 */
async function fetchAllJoined(
  serviceClient: SupabaseClient,
  filters: { featuredOnly?: boolean }
): Promise<ProductJoinedRow[]> {
  const out: ProductJoinedRow[] = [];
  let from = 0;
  for (;;) {
    const PAGE = 1000; // PostgREST max_rows cap per response
    // The chain is rebuilt INSIDE the loop: supabase-js builders
    // accumulate repeated .order() calls, so a shared builder corrupts
    // ordering and window state on page 2+.
    let query = serviceClient.from('products').select(PRODUCT_SELECT).eq('is_active', true);
    if (filters.featuredOnly) query = query.eq('is_featured', true);
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1)
      .returns<ProductJoinedRow[]>();
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
    from += PAGE;
  }
}

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  try {
    switch (action) {
      case 'featured-count': {
        // Cheap indexed head-count powering the «Обрано: X / 8» admin UI.
        const count = await countFeaturedProducts(ctx.serviceClient);
        return NextResponse.json({ count });
      }

      case 'featured': {
        const products = await fetchAllJoined(ctx.serviceClient, { featuredOnly: true });
        return NextResponse.json({ products });
      }

      case 'active': {
        const products = await fetchAllJoined(ctx.serviceClient, {});
        return NextResponse.json({ products });
      }

      case 'by-slug': {
        const slug = searchParams.get('slug');
        if (!slug) {
          return NextResponse.json({ error: 'Slug is required' }, { status: 400 });
        }

        const { data, error } = await ctx.serviceClient
          .from('products')
          .select(PRODUCT_SELECT)
          .eq('slug', slug)
          .eq('is_active', true)
          .returns<ProductJoinedRow[]>()
          .maybeSingle();

        if (error) {
          console.error('admin product lookup by slug failed:', error.message);
          return NextResponse.json(
            { error: 'Внутрішня помилка сервера' },
            { status: 500 }
          );
        }

        return NextResponse.json(data ? normalizeProduct(data) : null);
      }

      default: {
        // Listing is ALWAYS paginated (additive ?page=&size=, size capped
        // at 100) and ALWAYS filtered server-side (?search=&sort=): search
        // runs BEFORE pagination — DB or= filter → COUNT(filtered) → range
        // window. total/page/size in the response describe the FILTERED set.
        // ?categoryId= adds a junction-driven subtree filter.
        const params = parseAdminListParams(searchParams, PRODUCT_SORT_KEYS);
        const categoryId = searchParams.get('categoryId') ?? undefined;
        const result = await listAdminProducts(ctx.serviceClient, {
          ...params,
          ...(categoryId ? { categoryId } : {}),
        });
        return NextResponse.json(result);
      }
    }
  } catch (err) {
    console.error('Products API error:', err);
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
    const sku = typeof body.sku === 'string' ? body.sku.trim() : '';
    const price = nonNegNumOrNull(body.price);

    if (!name || !slug || !sku || price === null) {
      return NextResponse.json(
        { error: 'Вкажіть SKU, назву та slug; ціна має бути невід’ємним числом' },
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

    const currency = strOrNull(body.currency);
    if (currency !== null && !/^[A-Za-z]{3}$/.test(currency)) {
      return NextResponse.json(
        { error: 'Валюта має бути трилітерним кодом (наприклад UAH)' },
        { status: 400 }
      );
    }
    const availability = strOrNull(body.availability_status) ?? 'in_stock';
    if (!['in_stock', 'limited_availability', 'out_of_stock'].includes(availability)) {
      return NextResponse.json(
        { error: 'Недопустимий статус наявності' },
        { status: 400 }
      );
    }

    // Max-8 business rule BEFORE the insert (a new product is never
    // currently featured, so currentlyFeatured is false by definition).
    const wantsFeatured = Boolean(body.is_featured);
    if (wantsFeatured) {
      const featuredCountBefore = await countFeaturedProducts(ctx.serviceClient);
      const decision = decideFeaturedToggle({
        currentlyFeatured: false,
        requestedFeatured: true,
        featuredCount: featuredCountBefore,
      });
      if (!decision.allowed) {
        return NextResponse.json({ error: FEATURED_LIMIT_MESSAGE }, { status: 409 });
      }
    }

    // Multi-category (2026-08-26): category_ids wins over legacy
    // category_id when present; the legacy column keeps the FIRST selected
    // category as the transition default.
    let categoryIds: string[] | null = null;
    if ('category_ids' in body) {
      const parsed = parseCategoryIds(body.category_ids);
      if (parsed === null) {
        return NextResponse.json({ error: 'Некоректний id категорії' }, { status: 400 });
      }
      categoryIds = parsed;
    }

    const rawDescription = strOrNull(body.description);
    // The storefront renders this field as raw HTML (ProductDescription),
    // so the "always sanitized" invariant (same allowlist as the import
    // path) must hold for admin-created products too.

    const { data, error } = await ctx.serviceClient
      .from('products')
      .insert({
        sku,
        name,
        slug,
        short_description: strOrNull(body.short_description),
        description: rawDescription === null ? null : sanitizeYcDescription(rawDescription),
        price,
        old_price: oldPrice,
        currency: currency === null ? 'UAH' : currency.toUpperCase(),
        stock_quantity: nonNegNumOrNull(body.stock_quantity) ?? 0,
        availability_status: availability,
        category_id:
          categoryIds !== null
            ? (categoryIds[0] ?? null)
            : uuidOrNull(body.category_id),
        brand_id: uuidOrNull(body.brand_id),
        is_active: body.is_active === undefined ? true : Boolean(body.is_active),
        is_featured: wantsFeatured,
        // Independent «Обрані» flag (migration 028) — no shared state with
        // the featured max-8 rule.
        is_selected: Boolean(body.is_selected),
      })
      .select(PRODUCT_SELECT)
      .returns<ProductJoinedRow[]>()
      .single();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося створити товар');
    }

    if (categoryIds && categoryIds.length > 0) {
      const links = categoryIds.map((c) => ({ product_id: data.id, category_id: c }));
      const { error: linkError } = await ctx.serviceClient
        .from('product_categories')
        .insert(links);
      if (linkError) {
        console.error('Failed to save product categories:', linkError.message);
        return NextResponse.json(
          { error: 'Не вдалося зберегти категорії товару' },
          { status: 500 }
        );
      }
    }

    // Race guard: a parallel enable could have consumed the last slot
    // between the pre-check and this insert. The loser keeps its NEW product
    // but drops the featured flag — no silent removal of anyone else's pick.
    if (wantsFeatured) {
      const featuredCountAfter = await countFeaturedProducts(ctx.serviceClient);
      if (featuredCountAfter > MAX_FEATURED_PRODUCTS) {
        await ctx.serviceClient
          .from('products')
          .update({ is_featured: false })
          .eq('id', data.id);
        return NextResponse.json(
          {
            product: { ...normalizeProduct(data), is_featured: false },
            warning: FEATURED_LIMIT_MESSAGE,
          },
          { status: 201 }
        );
      }
    }

    return NextResponse.json({ product: normalizeProduct(data) }, { status: 201 });
  } catch (err) {
    console.error('Products API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
