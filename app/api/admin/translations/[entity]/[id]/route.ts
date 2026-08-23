import { NextResponse } from 'next/server';
import { requireAdminApi, strOrNull, dbErrorResponse } from '@/app/lib/admin-api';

const ENTITIES = {
  products: { table: 'products_translations', fk: 'product_id', hasShortDescription: true },
  categories: { table: 'categories_translations', fk: 'category_id', hasShortDescription: false },
  brands: { table: 'brands_translations', fk: 'brand_id', hasShortDescription: false },
} as const;

type EntityKey = keyof typeof ENTITIES;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveEntity(entity: string): (typeof ENTITIES)[EntityKey] | null {
  if (entity === 'products' || entity === 'categories' || entity === 'brands') {
    return ENTITIES[entity];
  }
  return null;
}

// GET /api/admin/translations/<entity>/<id> — list existing translations.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entity: string; id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { entity, id } = await params;
  const config = resolveEntity(entity);
  if (!config) {
    return NextResponse.json({ error: 'Невідома сутність' }, { status: 400 });
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Некоректний id' }, { status: 400 });
  }

  try {
    const { data, error } = await ctx.serviceClient
      .from(config.table)
      .select('*')
      .eq(config.fk, id)
      .order('language_code');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ translations: data ?? [] });
  } catch (err) {
    console.error('Translations API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

// PUT /api/admin/translations/<entity>/<id> — upsert a translation
// (defaults to the uk language). Unique constraint (fk, language_code).
const LANGUAGE_CODE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ entity: string; id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { entity, id } = await params;
  const config = resolveEntity(entity);
  if (!config) {
    return NextResponse.json({ error: 'Невідома сутність' }, { status: 400 });
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Некоректний id' }, { status: 400 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;

    const languageCode = strOrNull(body.language_code) ?? 'uk';
    // Junk codes would create rows the storefront locale lookups never read.
    if (!LANGUAGE_CODE_RE.test(languageCode)) {
      return NextResponse.json(
        { error: 'Код мови має бути у форматі uk або uk-UA' },
        { status: 400 }
      );
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json(
        { error: 'Вкажіть назву перекладу' },
        { status: 400 }
      );
    }

    const row: Record<string, unknown> = {
      [config.fk]: id,
      language_code: languageCode,
      name,
      description: strOrNull(body.description),
    };
    if (config.hasShortDescription) {
      row.short_description = strOrNull(body.short_description);
    }

    const { data, error } = await ctx.serviceClient
      .from(config.table)
      .upsert(row, { onConflict: `${config.fk},language_code` })
      .select('*')
      .single();

    if (error) {
      return dbErrorResponse(error, 'Не вдалося зберегти переклад');
    }

    return NextResponse.json({ translation: data });
  } catch (err) {
    console.error('Translations API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
