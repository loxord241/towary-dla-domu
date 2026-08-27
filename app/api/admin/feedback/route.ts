import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';

/**
 * Admin feedback API: list and delete anonymous site feedback.
 * Both handlers sit behind requireAdminApi — the service-role client is
 * used only after the caller is verified as an admin.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_LIMIT = 200;

export async function GET() {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { data, error } = await ctx.serviceClient
    .from('feedback')
    .select('id, message, created_at')
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);

  if (error) {
    console.error('admin feedback list failed:', error.message);
    return Response.json(
      { error: 'Внутрішня помилка сервера' },
      { status: 500 }
    );
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: last24h } = await ctx.serviceClient
    .from('feedback')
    .select('*', { count: 'exact', head: true })
    .gt('created_at', dayAgo);

  return Response.json({ items: data ?? [], last24h: last24h ?? 0 });
}

export async function DELETE(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { id } = (body ?? {}) as { id?: unknown };
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }

  const { error } = await ctx.serviceClient
    .from('feedback')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('admin feedback delete failed:', error.message);
    return Response.json(
      { error: 'Внутрішня помилка сервера' },
      { status: 500 }
    );
  }

  return Response.json({ ok: true });
}
