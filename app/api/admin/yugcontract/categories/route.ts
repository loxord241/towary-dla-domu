import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import {
  getCategoriesCatalog,
  YugcontractError,
} from '@/app/lib/yugcontract/client';
import {
  buildCategoryTree,
  detectCategoryFields,
  extractCategoryRows,
  normalizeCategoryNode,
} from '@/app/lib/yugcontract/normalize';

/**
 * READ-ONLY Yugcontract get-categories preview (admin only).
 *
 * Downloads the supplier category tree and returns it as diagnostics JSON.
 * Performs ZERO writes: no products/categories/brands/orders/stock rows
 * are created, updated or deleted in our database.
 *
 * Because the exact provider response schema is not documented, the
 * extractor auto-detects the array location and id/name/parent keys and
 * reports them (`detected.arrayPath`/`detected.fields`), plus a raw sample
 * of the first rows — so the first real run documents the actual shape.
 */

export const maxDuration = 60;

const RAW_SAMPLE_SIZE = 8;

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const limited = await enforceRateLimit(request, 'yugcontractCategories');
  if (limited) return limited;

  try {
    const startedAt = Date.now();

    // ---- supplier categories (external API, read-only) ----
    const parsed = await getCategoriesCatalog();
    const { rows, arrayPath } = extractCategoryRows(parsed);
    const detectedFields = detectCategoryFields(rows);
    const nodes = rows.map((row) => normalizeCategoryNode(row, detectedFields));
    const { roots, stats } = buildCategoryTree(nodes);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      source: {
        endpoint: 'get-categories',
        type: 'regular',
      },
      detected: {
        arrayPath,
        fields: detectedFields,
        rawSample: rows.slice(0, RAW_SAMPLE_SIZE),
      },
      stats,
      tree: roots,
    });
  } catch (err) {
    if (err instanceof YugcontractError) {
      console.error(
        `Yugcontract categories failed [${err.kind}${err.httpStatus ? `:${err.httpStatus}` : ''}]`
      );
      const status =
        err.kind === 'config' ? 503 : err.kind === 'rate_limited' ? 429 : 502;
      // YUGCONTRACT-CURATED-MESSAGE: YugcontractError messages are fixed,
      // credential-free strings built in app/lib/yugcontract/client.ts.
      return NextResponse.json({ error: err.message }, { status });
    }
    if (err instanceof TypeError) {
      console.error('Yugcontract categories malformed feed:', err.message);
      return NextResponse.json(
        { error: 'Не вдалося обробити відповідь Yugcontract' },
        { status: 502 }
      );
    }
    console.error('Yugcontract categories unexpected error');
    return NextResponse.json(
      { error: 'Внутрішня помилка сервера' },
      { status: 500 }
    );
  }
}
