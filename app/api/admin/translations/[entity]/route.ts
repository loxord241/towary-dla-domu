import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';

const ENTITIES = {
  products: {
    table: 'products_translations',
    fk: 'product_id',
    base: 'products',
  },
  categories: {
    table: 'categories_translations',
    fk: 'category_id',
    base: 'categories',
  },
  brands: {
    table: 'brands_translations',
    fk: 'brand_id',
    base: 'brands',
  },
} as const;

type EntityKey = keyof typeof ENTITIES;

function resolveEntity(entity: string): (typeof ENTITIES)[EntityKey] | null {
  if (entity === 'products' || entity === 'categories' || entity === 'brands') {
    return ENTITIES[entity];
  }
  return null;
}

// GET /api/admin/translations/<entity> — all translations for the entity,
// each row enriched with its base entity (name + slug).
//
// The admin page must use this route instead of querying Supabase directly:
// a browser supabase-js client has no access to the SSR session cookies and
// would silently act as anonymous, showing only an RLS-filtered subset.
//
// Base rows are fetched separately and merged in JS on purpose: the live DB
// carries two identical FKs between each translation table and its parent
// (legacy migration duplication), which makes PostgREST relationship
// embedding ambiguous without fragile constraint-name hints.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entity: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { entity } = await params;
  const config = resolveEntity(entity);
  if (!config) {
    return NextResponse.json({ error: 'Невідома сутність' }, { status: 400 });
  }

  try {
    const [translationsRes, basesRes] = await Promise.all([
      ctx.serviceClient.from(config.table).select('*').order('language_code'),
      ctx.serviceClient.from(config.base).select('id, name, slug'),
    ]);

    if (translationsRes.error) {
      return NextResponse.json({ error: translationsRes.error.message }, { status: 500 });
    }
    if (basesRes.error) {
      return NextResponse.json({ error: basesRes.error.message }, { status: 500 });
    }

    const baseById = new Map(
      (basesRes.data ?? []).map((row) => [row.id as string, row])
    );

    const translations = (translationsRes.data ?? []).map((row) => ({
      ...row,
      base: baseById.get(row[config.fk] as string) ?? null,
    }));

    return NextResponse.json({ translations });
  } catch (err) {
    console.error('Translations API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
