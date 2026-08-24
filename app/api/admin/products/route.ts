import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, uuidOrNull, nonNegNumOrNull, dbErrorResponse } from '@/app/lib/admin-api';
import type {
  Product,
  Category,
  Brand,
  ProductImage,
  ProductVariant,
} from '@/app/lib/catalog';

// The admin list must satisfy the full Product contract that the UI types
// against: relations are embedded and collection fields are always arrays.
const SELECT =
  '*, category:categories(*), brand:brands(*), images:product_images(*), variants:product_variants(*)';

// PostgREST embeds many-to-one relations as an object (or null) and
// one-to-many relations as arrays — this row type mirrors the raw shape.
type ProductJoinedRow = Omit<
  Product,
  'category' | 'brand' | 'images' | 'variants'
> & {
  category: Category | null;
  brand: Brand | null;
  images: ProductImage[] | null;
  variants: ProductVariant[] | null;
};

function normalizeProduct(row: ProductJoinedRow): Product {
  return {
    ...row,
    category: row.category ?? null,
    brand: row.brand ?? null,
    images: [...(row.images ?? [])].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    ),
    variants: row.variants ?? [],
  };
}

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  try {
    switch (action) {
      case 'featured': {
        const { data, error } = await ctx.serviceClient
          .from('products')
          .select(SELECT)
          .eq('is_featured', true)
          .eq('is_active', true)
          .order('created_at', { ascending: false })
          .returns<ProductJoinedRow[]>();

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ products: (data ?? []).map(normalizeProduct) });
      }

      case 'active': {
        const { data, error } = await ctx.serviceClient
          .from('products')
          .select(SELECT)
          .eq('is_active', true)
          .order('created_at', { ascending: false })
          .returns<ProductJoinedRow[]>();

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ products: (data ?? []).map(normalizeProduct) });
      }

      case 'by-slug': {
        const slug = searchParams.get('slug');
        if (!slug) {
          return NextResponse.json({ error: 'Slug is required' }, { status: 400 });
        }

        const { data, error } = await ctx.serviceClient
          .from('products')
          .select(SELECT)
          .eq('slug', slug)
          .eq('is_active', true)
          .returns<ProductJoinedRow[]>()
          .maybeSingle();

        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json(data ? normalizeProduct(data) : null);
      }

      default: {
        // Listing is ALWAYS paginated (additive ?page=&size=, size capped
        // at 100). The old "unbounded" mode was a silent-truncation bug:
        // PostgREST capped it at 1000 rows and returned them as if complete.
        const sizeParam = Number(searchParams.get('size'));
        const pageParam = Number(searchParams.get('page'));
        // Integers only: a fractional size ("0.5") would truncate to 0 and
        // produce Infinity/NaN page math downstream.
        const size =
          Number.isInteger(sizeParam) && sizeParam > 0 ? Math.min(sizeParam, 100) : 50;
        const requestedPage =
          Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

        const countQuery = ctx.serviceClient
          .from('products')
          .select('id', { count: 'exact', head: true });
        const { count, error: countError } = await countQuery;
        if (countError) {
          return NextResponse.json({ error: countError.message }, { status: 500 });
        }
        const total = count ?? 0;
        const maxPage = Math.max(1, Math.ceil(total / size));
        const safePage = Math.min(requestedPage, maxPage);

        const { data, error } = await ctx.serviceClient
          .from('products')
          .select(SELECT)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range((safePage - 1) * size, safePage * size - 1)
          .returns<ProductJoinedRow[]>();
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({
          products: (data ?? []).map(normalizeProduct),
          total,
          page: safePage,
          size,
        });
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

    const { data, error } = await ctx.serviceClient
      .from('products')
      .insert({
        sku,
        name,
        slug,
        short_description: strOrNull(body.short_description),
        description: strOrNull(body.description),
        price,
        old_price: oldPrice,
        currency: currency === null ? 'UAH' : currency.toUpperCase(),
        stock_quantity: nonNegNumOrNull(body.stock_quantity) ?? 0,
        availability_status: availability,
        category_id: uuidOrNull(body.category_id),
        brand_id: uuidOrNull(body.brand_id),
        is_active: body.is_active === undefined ? true : Boolean(body.is_active),
        is_featured: Boolean(body.is_featured),
      })
      .select(SELECT)
      .returns<ProductJoinedRow[]>()
      .single();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося створити товар');
    }

    return NextResponse.json({ product: normalizeProduct(data) }, { status: 201 });
  } catch (err) {
    console.error('Products API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
