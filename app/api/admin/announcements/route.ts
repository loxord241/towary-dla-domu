import { NextResponse } from 'next/server';
import { requireAdminApi, isUuid, dbErrorResponse } from '@/app/lib/admin-api';
import {
  validateAnnouncementInput,
  type AnnouncementInput,
} from '@/app/lib/announcements';

/**
 * Admin CRUD for store announcements (migration 031).
 *
 * Every handler sits behind requireAdminApi — the service-role client is
 * used only AFTER the caller is verified against admin_users. The table has
 * no public write path (RLS exposes SELECT of active rows only), so this
 * route is the single mutation surface.
 *
 * PATCH accepts two payload shapes:
 *  - { id, is_active } — the quick ON/OFF toggle (nothing else changes);
 *  - { id, title, message, type, sortOrder } — full edit (validates like
 *    POST; sort_order = 0 when omitted).
 */

const LIST_COLUMNS =
  'id, title, message, type, is_active, sort_order, created_at, updated_at';

const LIST_LIMIT = 100;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    if (typeof body !== 'object' || body === null) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET() {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { data, error } = await ctx.serviceClient
    .from('store_announcements')
    .select(LIST_COLUMNS)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(LIST_LIMIT);

  if (error) {
    console.error('admin announcements list failed:', error.message);
    return NextResponse.json(
      { error: 'Не вдалося завантажити повідомлення' },
      { status: 500 }
    );
  }

  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const body = await readJson(request);
  if (!body) {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = validateAnnouncementInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: 'Перевірте заголовок, текст і тип повідомлення' },
      { status: 400 }
    );
  }

  const value: AnnouncementInput = parsed.value;
  const { data, error } = await ctx.serviceClient
    .from('store_announcements')
    .insert({
      title: value.title,
      message: value.message,
      type: value.type,
      sort_order: value.sortOrder,
      // New announcements always start inactive — publishing is an
      // explicit, separate toggle.
      is_active: false,
    })
    .select(LIST_COLUMNS)
    .single();

  if (error) {
    console.error('admin announcements insert failed:', error.message);
    return dbErrorResponse(error, 'Не вдалося створити повідомлення');
  }

  return NextResponse.json({ item: data }, { status: 201 });
}

export async function PATCH(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const body = await readJson(request);
  if (!body) {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // Shape 1: the safe toggle — only is_active changes.
  if (typeof body.is_active === 'boolean' &&
      body.title === undefined &&
      body.message === undefined &&
      body.type === undefined &&
      body.sortOrder === undefined) {
    const { data, error } = await ctx.serviceClient
      .from('store_announcements')
      .update({ is_active: body.is_active, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(LIST_COLUMNS)
      .single();

    if (error) {
      console.error('admin announcements toggle failed:', error.message);
      return dbErrorResponse(error, 'Не вдалося змінити статус повідомлення');
    }
    return NextResponse.json({ item: data });
  }

  // Shape 2: full edit.
  const parsed = validateAnnouncementInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: 'Перевірте заголовок, текст і тип повідомлення' },
      { status: 400 }
    );
  }

  const value = parsed.value;
  const { data, error } = await ctx.serviceClient
    .from('store_announcements')
    .update({
      title: value.title,
      message: value.message,
      type: value.type,
      sort_order: value.sortOrder,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(LIST_COLUMNS)
    .single();

  if (error) {
    console.error('admin announcements update failed:', error.message);
    return dbErrorResponse(error, 'Не вдалося зберегти повідомлення');
  }

  return NextResponse.json({ item: data });
}

export async function DELETE(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const body = await readJson(request);
  if (!body) {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const { error } = await ctx.serviceClient
    .from('store_announcements')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('admin announcements delete failed:', error.message);
    return dbErrorResponse(error, 'Не вдалося видалити повідомлення');
  }

  return NextResponse.json({ ok: true });
}
