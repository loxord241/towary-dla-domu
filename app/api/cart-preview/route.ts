import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getPublicImageUrl } from '@/app/lib/supabase-storage';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { assertSameOrigin } from '@/app/lib/request-origin';
import type { CartPreviewLine, PreviewRequestItem } from '@/app/lib/cart-preview';

/**
 * POST /api/cart-preview — read-only batch lookup for cart lines.
 *
 * Accepts ONLY identifiers: [{ productId, variantId? }] and returns current
 * PUBLIC catalog data for them (name, price, stock, availability, image).
 * Runs with the publishable key as the anonymous role, so RLS hides
 * inactive products automatically — the UI then shows "unavailable".
 * No service-role data is ever exposed here.
 */

// Same pattern as app/lib/catalog.ts: server-side, anonymous, no session.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { persistSession: false } }
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'cartPreview');
  if (limited) return limited;

  // Same-origin gate (audit P1): a cross-site browser POST always carries
  // an Origin that cannot match the deployment host — reject before any
  // parse/DB work (see app/lib/request-origin.ts).
  if (!assertSameOrigin(request)) {
    return Response.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некоректний JSON' }, { status: 400 });
  }

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 30) {
    return NextResponse.json({ error: 'Некоректні позиції' }, { status: 400 });
  }

  // Whitelist + validate identifiers; unknown fields are ignored by design.
  const requested: PreviewRequestItem[] = [];
  const productIds = new Set<string>();
  const variantIds = new Set<string>();

  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const productId = typeof rec.productId === 'string' ? rec.productId : '';
    const variantId =
      typeof rec.variantId === 'string' && rec.variantId.length > 0
        ? rec.variantId
        : null;
    if (!UUID_RE.test(productId)) continue;
    if (variantId !== null && !UUID_RE.test(variantId)) continue;
    requested.push({ productId, variantId });
    productIds.add(productId);
    if (variantId) variantIds.add(variantId);
  }

  if (requested.length === 0) {
    return NextResponse.json({ error: 'Немає коректних позицій' }, { status: 400 });
  }

  const [productsRes, variantsRes] = await Promise.all([
    supabase
      .from('products')
      .select(
        'id, name, slug, price, currency, stock_quantity, availability_status, is_active, images:product_images(image_url, is_main, sort_order)'
      )
      .in('id', [...productIds]),
    variantIds.size > 0
      ? supabase
          .from('product_variants')
          .select(
            'id, product_id, name, price, stock_quantity, availability_status, is_active'
          )
          .in('id', [...variantIds])
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);

  if (productsRes.error || variantsRes.error) {
    console.error(
      'cart-preview query failed:',
      productsRes.error?.message ?? variantsRes.error?.message
    );
    return NextResponse.json({ error: 'Помилка пошуку' }, { status: 500 });
  }

  type ProductRow = {
    id: string;
    name: string;
    slug: string;
    price: number;
    currency: string;
    stock_quantity: number;
    availability_status: string;
    images: { image_url: string; is_main: boolean | null; sort_order: number | null }[] | null;
  };
  type VariantRow = {
    id: string;
    product_id: string;
    name: string;
    price: number;
    stock_quantity: number;
    availability_status: string;
    is_active: boolean;
  };

  const productsById = new Map(
    ((productsRes.data ?? []) as ProductRow[]).map((p) => [p.id, p])
  );
  const variantsById = new Map(
    ((variantsRes.data ?? []) as VariantRow[]).map((v) => [v.id, v])
  );

  const lines: CartPreviewLine[] = requested.map((req) => {
    const productId: string = req.productId;
    const variantId: string | null = req.variantId ?? null;
    const product = productsById.get(productId);
    if (!product) {
      // Not returned by RLS -> inactive or nonexistent: unavailable.
      return {
        productId,
        variantId,
        found: false,
        name: null,
        slug: null,
        variantName: null,
        unitPrice: null,
        currency: null,
        stock: null,
        availabilityStatus: null,
        imageUrl: null,
      };
    }

    const images = [...(product.images ?? [])].sort(
      (a, b) =>
        Number(b.is_main ?? false) - Number(a.is_main ?? false) ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0)
    );
    const imageUrl = getPublicImageUrl(images[0]?.image_url ?? '');

    if (!variantId) {
      return {
        productId,
        variantId: null,
        found: true,
        name: product.name,
        slug: product.slug,
        variantName: null,
        unitPrice: product.price,
        currency: product.currency,
        stock: product.stock_quantity,
        availabilityStatus: product.availability_status,
        imageUrl,
      };
    }

    const variant = variantsById.get(variantId);
    if (!variant || variant.product_id !== productId) {
      return {
        productId,
        variantId,
        found: false,
        name: null,
        slug: null,
        variantName: null,
        unitPrice: null,
        currency: null,
        stock: null,
        availabilityStatus: null,
        imageUrl,
      };
    }

    return {
      productId,
      variantId,
      found: true,
      name: product.name,
      slug: product.slug,
      variantName: variant.name,
      unitPrice: variant.price,
      currency: product.currency,
      stock: variant.stock_quantity,
      availabilityStatus: variant.availability_status,
      imageUrl,
    };
  });

  return NextResponse.json({ items: lines });
}
