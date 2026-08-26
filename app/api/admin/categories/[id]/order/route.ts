import { NextResponse } from 'next/server';
import { requireAdminApi, isUuid, dbErrorResponse } from '@/app/lib/admin-api';
import { moveInGroup } from '@/app/lib/category-tree';

interface SiblingRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
}

/**
 * POST /api/admin/categories/<id>/order  body: { direction: 'up' | 'down' }
 *
 * Moves a category one slot within ITS OWN sibling group (same parent_id,
 * roots included). The group is re-sorted with the shared commercial
 * comparator (sort_order → uk-name → id) and positions 0..n-1 are written
 * back — this normalizes duplicate/absurd sort_order values and keeps
 * every later move deterministic. Other parent groups are never touched.
 *
 * Race note: concurrent moves read fresh snapshots and rewrite the whole
 * group; last write wins and the state stays consistent (no negative or
 * overlapping orders can accumulate).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;

  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id категорію' }, { status: 400 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const direction = body.direction === 'down' ? 'down' : body.direction === 'up' ? 'up' : null;
    if (!direction) {
      return NextResponse.json({ error: 'Напрямок має бути up або down' }, { status: 400 });
    }

    const { data: category, error: catError } = await ctx.serviceClient
      .from('categories')
      .select('id,parent_id,name,sort_order')
      .eq('id', id)
      .maybeSingle();

    if (catError) {
      return dbErrorResponse(catError, 'Не вдалося прочитати категорію');
    }
    if (!category) {
      return NextResponse.json({ error: 'Категорію не знайдено' }, { status: 404 });
    }

    // Siblings = same parent scope only.
    const siblingQuery = ctx.serviceClient.from('categories').select('id,parent_id,name,sort_order');
    const siblingsRes =
      category.parent_id === null
        ? await siblingQuery.is('parent_id', null).range(0, 999)
        : await siblingQuery.eq('parent_id', category.parent_id).range(0, 999);

    if (siblingsRes.error) {
      return dbErrorResponse(siblingsRes.error, 'Не вдалося прочитати сусідні категорії');
    }
    const siblings = (siblingsRes.data ?? []) as SiblingRow[];

    const reordered = moveInGroup(siblings, id, direction);
    if (!reordered) {
      // Already at the edge of its group — nothing to change, still OK.
      return NextResponse.json({ reordered: 0 });
    }

    let moved = 0;
    for (const [index, row] of reordered.entries()) {
      if (row.sort_order === siblings[index]?.sort_order && row.id === siblings[index]?.id) {
        continue; // unchanged position — skip a needless write
      }
      const { error } = await ctx.serviceClient
        .from('categories')
        .update({ sort_order: index })
        .eq('id', row.id);
      if (error) {
        return dbErrorResponse(error, 'Не вдалося зберегти порядок категорій');
      }
      moved += 1;
    }

    return NextResponse.json({ reordered: moved });
  } catch (err) {
    console.error('Category order API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
