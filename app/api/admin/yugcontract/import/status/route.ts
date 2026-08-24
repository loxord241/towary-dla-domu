import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import {
  fetchAllRows,
} from '@/app/lib/yugcontract/import-run';

/**
 * GET /api/admin/yugcontract/import/status?runId=...&all=1
 *
 * Read-only checkpoint overview. Without `all` returns only the latest
 * run; with `all=1` returns every run's batches.
 */
interface CheckpointRow {
  run_id: string;
  phase: string;
  batch_no: number;
  status: string;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  last_error: string | null;
  finished_at: string | null;
}

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const limited = enforceRateLimit(request, 'yugcontractImportStatus');
  if (limited) return limited;

  try {
    const url = new URL(request.url);
    const runId = url.searchParams.get('runId');
    const all = url.searchParams.get('all') === '1';

    let rows = await fetchAllRows<CheckpointRow>(
      ctx.serviceClient,
      'yc_import_batches',
      'run_id,phase,batch_no,status,inserted_count,updated_count,skipped_count,error_count,last_error,finished_at'
    );
    if (!all && runId) rows = rows.filter((r) => r.run_id === runId);

    const sorted = rows.sort(
      (a, b) =>
        a.run_id.localeCompare(b.run_id) ||
        a.phase.localeCompare(b.phase) ||
        a.batch_no - b.batch_no
    );

    const totals = sorted.reduce(
      (acc, r) => ({
        inserted: acc.inserted + (r.phase === 'products' ? r.inserted_count : 0),
        updated: acc.updated + (r.phase === 'products' ? r.updated_count : 0),
        categoriesInserted: acc.categoriesInserted + (r.phase === 'categories' ? r.inserted_count : 0),
        brandsCreated: acc.brandsCreated,
        errors: acc.errors + r.error_count,
      }),
      { inserted: 0, updated: 0, categoriesInserted: 0, brandsCreated: 0, errors: 0 }
    );

    return NextResponse.json({ runs: sorted, totals });
  } catch {
    console.error('yc import status failed');
    return NextResponse.json({ error: 'Не вдалося прочитати checkpoint' }, { status: 500 });
  }
}
