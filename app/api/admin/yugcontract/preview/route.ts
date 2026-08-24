import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdminApi } from '@/app/lib/admin-api';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import {
  getPriceCatalog,
  YugcontractError,
} from '@/app/lib/yugcontract/client';
import {
  buildCrossAnalysis,
  buildFieldTypeHistogram,
  buildPreviewStats,
  extractRawProducts,
  normalizeYcProduct,
} from '@/app/lib/yugcontract/normalize';

// The full provider feed is ~200k rows; give the function room on Vercel.
export const maxDuration = 60;

/**
 * READ-ONLY Yugcontract catalog preview (admin only).
 *
 * Downloads the supplier feed, computes statistics and compares it with
 * the existing catalog. Performs ZERO writes: no products/categories/
 * brands/orders/stock rows are created, updated or deleted. The only DB
 * operations here are SELECTs through the admin service client.
 */

const PAGE_SIZE = 5000;

/** Fetch every row of a small admin table, page by page (read-only). */
async function fetchAllRows<T>(
  client: SupabaseClient,
  table: string,
  select: string
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(select)
      .range(from, from + PAGE_SIZE - 1)
      .returns<T[]>();
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
    from += PAGE_SIZE;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof YugcontractError) {
    // Messages are credential-free by construction; log kind/status only.
    console.error(
      `Yugcontract preview failed [${err.kind}${err.httpStatus ? `:${err.httpStatus}` : ''}]`
    );
    const status =
      err.kind === 'config'
        ? 503
        : err.kind === 'rate_limited'
          ? 429
          : 502;
    return NextResponse.json({ error: err.message }, { status });
  }
  if (err instanceof TypeError) {
    console.error('Yugcontract preview malformed feed:', err.message);
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
  console.error('Yugcontract preview unexpected error');
  return NextResponse.json(
    { error: 'Внутрішня помилка сервера' },
    { status: 500 }
  );
}

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const limited = enforceRateLimit(request, 'yugcontractPreview');
  if (limited) return limited;

  try {
    const startedAt = Date.now();

    // ---- supplier feed (external API, read-only) ----
    const parsed = await getPriceCatalog();
    const rawProducts = extractRawProducts(parsed);
    const fieldTypes = buildFieldTypeHistogram(rawProducts);
    const ycProducts = rawProducts.map(normalizeYcProduct);
    const stats = buildPreviewStats(ycProducts);

    // ---- our catalog (DB, SELECT-only via admin service client) ----
    const [ourProducts, ourBrands, ourCategories] = await Promise.all([
      fetchAllRows<{ sku: string; name: string }>(
        ctx.serviceClient,
        'products',
        'sku,name'
      ),
      fetchAllRows<{ name: string }>(ctx.serviceClient, 'brands', 'name'),
      fetchAllRows<{ name: string }>(ctx.serviceClient, 'categories', 'name'),
    ]);

    const cross = buildCrossAnalysis(
      ycProducts,
      ourProducts,
      ourBrands,
      ourCategories
    );

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      source: {
        endpoint: 'get-price',
        type: 'regular',
        cats: [],
      },
      fieldTypes,
      stats,
      cross,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
