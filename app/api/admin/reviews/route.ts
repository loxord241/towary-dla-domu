import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';

/**
 * Admin reviews list with status filter and bounded pagination.
 * Service-role reads happen only AFTER requireAdminApi() passed.
 * Deterministic order (created_at desc + id tiebreaker) keeps windows stable
 * while moderators act mid-list.
 */

const STATUS_FILTERS = ['pending', 'published', 'rejected', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Column whitelist — user-generated content is never selected wholesale. */
const REVIEW_LIST_COLUMNS =
  'id, product_id, rating, text, display_name, status, created_at, updated_at, product:products(name, slug)';

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);

  const statusParam = searchParams.get('status') ?? 'pending';
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(
    statusParam
  )
    ? (statusParam as StatusFilter)
    : 'pending';

  const rawPage = Number(searchParams.get('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawSize = Number(searchParams.get('size'));
  const size = Math.min(
    Number.isInteger(rawSize) && rawSize > 0 ? rawSize : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );

  // COUNT runs over the FILTERED set; the window is cut afterwards — the
  // same pipeline as admin-list.ts (filter BEFORE pagination).
  let countQuery = ctx.serviceClient
    .from('product_reviews')
    .select('id', { count: 'exact', head: true });
  if (status !== 'all') {
    countQuery = countQuery.eq('status', status);
  }
  const { count, error: countError } = await countQuery;
  if (countError) {
    console.error('admin reviews count failed:', countError.message);
    return NextResponse.json({ error: 'Не вдалося завантажити відгуки' }, { status: 500 });
  }

  const total = count ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(page, maxPage);

  // Window chain built FRESH: supabase-js builders accumulate repeated
  // .order() calls, so reusing a builder corrupts ordering (catalog.ts lesson).
  let windowQuery = ctx.serviceClient.from('product_reviews').select(REVIEW_LIST_COLUMNS);
  if (status !== 'all') {
    windowQuery = windowQuery.eq('status', status);
  }
  const { data, error: pageError } = await windowQuery
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range((safePage - 1) * size, safePage * size - 1);

  if (pageError) {
    console.error('admin reviews page failed:', pageError.message);
    return NextResponse.json({ error: 'Не вдалося завантажити відгуки' }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [], total, page: safePage, size });
}
