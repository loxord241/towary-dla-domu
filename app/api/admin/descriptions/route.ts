import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { requireAdminApi, dbErrorResponse } from '@/app/lib/admin-api';
import {
  parseDraftAction,
  DESCRIPTION_DRAFT_PAGE_SIZE,
} from '@/app/lib/description-drafts';

/**
 * Admin description-drafts queue (migration 050, spec 2026-09-14 Phase 2).
 *
 * Every handler sits behind requireAdminApi — the service-role client is
 * used only AFTER the caller is verified against admin_users. The table
 * has RLS deny-all + revoked public grants, so this route (and the CLI)
 * are the only access paths.
 *
 * GET  ?page=N — pending drafts (≤50 per page, oldest first), joined with
 *                products for name/sku/slug (read-only embed).
 * PATCH { id, action: 'approve' | 'reject' }:
 *   - approve → THE ONLY products.description writer of this feature:
 *     the atomic RPC approve_product_description_draft() sets
 *     products.description = description_text AND status='approved',
 *     reviewed_at=now() in ONE transaction; then the storefront cache
 *     tag drops so the PDP re-reads immediately.
 *   - reject  → status='rejected', reviewed_at=now() on the draft row
 *     ONLY — products are structurally untouched (no .from('products')
 *     update exists in this route).
 */

const LIST_COLUMNS =
  'id, product_id, lead, description_text, status, source, created_at, reviewed_at, ' +
  'product:products!product_description_drafts_product_id_fkey(name, sku, slug)';

const PAGE_SIZE = DESCRIPTION_DRAFT_PAGE_SIZE; // 50

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Perf 2026-09-13: storefront reads are Data-Cache'd under the
// `catalog-public-reads` tag — every admin mutation drops it so the
// storefront sees changes immediately (TTL 900s otherwise).
function invalidatePublicReads(): void {
  // Next 16: the second arg is the cacheLife profile — 'max' expires
  // immediately, so the storefront re-reads on the next request.
  revalidateTag('catalog-public-reads', 'max');
}

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const url = new URL(request.url);
  const pageRaw = url.searchParams.get('page') ?? '1';
  const page = /^\d+$/.test(pageRaw) ? Math.max(1, Math.floor(Number(pageRaw))) : 1;
  const from = (page - 1) * PAGE_SIZE;

  const { data, count, error } = await ctx.serviceClient
    .from('product_description_drafts')
    .select(LIST_COLUMNS, { count: 'exact' })
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  if (error) {
    console.error('admin descriptions list failed:', error.message);
    return NextResponse.json(
      { error: 'Не вдалося завантажити чернетки описів' },
      { status: 500 }
    );
  }

  const total = count ?? 0;
  return NextResponse.json({
    items: data ?? [],
    total,
    page,
    pageSize: PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
}

export async function PATCH(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = parseDraftAction(await readJson(request));
  if (!parsed) {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }

  if (parsed.action === 'approve') {
    // Atomic publish: products.description = draft text + draft
    // status='approved' in one DB transaction (migration 050 RPC).
    // Writing products directly from here is FORBIDDEN by the spec —
    // only pending drafts convert, so a double-click cannot re-publish.
    const { error } = await ctx.serviceClient.rpc(
      'approve_product_description_draft',
      { p_draft_id: parsed.id }
    );

    if (error) {
      console.error('admin description approve failed:', error.message);
      // P0001 = the draft was not found or is no longer pending.
      if (error.code === 'P0001') {
        return NextResponse.json(
          { error: 'Чернетку не знайдено або її вже опрацьовано' },
          { status: 409 }
        );
      }
      return dbErrorResponse(error, 'Не вдалося затвердити чернетку');
    }

    invalidatePublicReads();

    const { data, error: readError } = await ctx.serviceClient
      .from('product_description_drafts')
      .select(LIST_COLUMNS)
      .eq('id', parsed.id)
      .maybeSingle();

    if (readError || !data) {
      // Approve itself succeeded — only the read-back failed.
      console.error('admin description readback failed:', readError?.message);
      return NextResponse.json({ ok: true, id: parsed.id });
    }
    return NextResponse.json({ item: data });
  }

  // reject: только служебная запись в таблице черновиков — карточка
  // товара (и кэш витрины) не затрагиваются.
  const { data, error } = await ctx.serviceClient
    .from('product_description_drafts')
    .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
    .eq('id', parsed.id)
    .eq('status', 'pending')
    .select(LIST_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error('admin description reject failed:', error.message);
    return dbErrorResponse(error, 'Не вдалося відхилити чернетку');
  }
  if (!data) {
    return NextResponse.json(
      { error: 'Чернетку не знайдено або її вже опрацьовано' },
      { status: 409 }
    );
  }
  return NextResponse.json({ item: data });
}
