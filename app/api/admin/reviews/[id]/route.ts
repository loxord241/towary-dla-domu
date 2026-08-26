import { NextResponse } from 'next/server';
import { requireAdminApi, isUuid } from '@/app/lib/admin-api';

/**
 * Single-review moderation actions. Every transition stamps updated_at so
 * the moderation queue re-sorts sensibly. Deletion is a plain row delete —
 * nothing else references product_reviews (the FK is child-side only).
 */

const ACTION_TO_STATUS: Record<string, string> = {
  publish: 'published',
  reject: 'rejected',
  pending: 'pending',
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id відгуку' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некоректний JSON' }, { status: 400 });
  }

  const action = (body as { action?: unknown })?.action;
  const status = typeof action === 'string' ? ACTION_TO_STATUS[action] : undefined;
  if (!status) {
    return NextResponse.json(
      { error: 'Недопустима дія (publish | reject | pending)' },
      { status: 400 }
    );
  }

  const { data, error } = await ctx.serviceClient
    .from('product_reviews')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, status')
    .maybeSingle();

  if (error) {
    console.error('review status update failed:', error.message);
    return NextResponse.json({ error: 'Не вдалося оновити відгук' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Відгук не знайдено' }, { status: 404 });
  }

  return NextResponse.json(data);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id відгуку' }, { status: 400 });
  }

  const { data, error } = await ctx.serviceClient
    .from('product_reviews')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('review delete failed:', error.message);
    return NextResponse.json({ error: 'Не вдалося видалити відгук' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Відгук не знайдено' }, { status: 404 });
  }

  return NextResponse.json({ id: data.id });
}
