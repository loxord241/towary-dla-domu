import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { ensureRun, makeRealDeps } from '@/app/lib/yugcontract/import-run';

// Tree fetch only (~400 ms) — the price feed is pulled per-batch by /run.
export const maxDuration = 60;

/**
 * POST /api/admin/yugcontract/import/start
 *
 * Creates (idempotently) the checkpoint skeleton for one import run:
 *   - 1 'categories' batch;
 *   - N 'products' batches over leaf categories (≤40 cats each).
 * Returns the run id and batch layout. NO supplier feed download and
 * NO catalog writes happen here.
 */
export async function POST(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const limited = enforceRateLimit(request, 'yugcontractImportStart');
  if (limited) return limited;

  try {
    const body = (await request.json().catch(() => ({}))) as { runId?: string };
    const runId =
      typeof body.runId === 'string' && body.runId.trim() !== ''
        ? body.runId.trim().slice(0, 100)
        : `yc-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    const deps = makeRealDeps();
    const leaves = await deps.loadLeaves();

    const batches: { phase: 'categories' | 'products'; batchNo: number; payload?: { cats?: string[] } }[] = [
      { phase: 'categories', batchNo: 0 },
    ];
    for (let i = 0; i < leaves.length; i += 40) {
      batches.push({
        phase: 'products',
        batchNo: batches.length,
        payload: { cats: leaves.slice(i, i + 40) },
      });
    }

    const rows = await ensureRun(ctx.serviceClient, runId, batches);
    return NextResponse.json({
      runId,
      batches: rows.map((b) => ({
        phase: b.phase,
        batchNo: b.batch_no,
        status: b.status,
        cats: b.payload?.cats?.length ?? 0,
      })),
    });
  } catch {
    console.error('yc import start failed');
    return NextResponse.json({ error: 'Не вдалося створити імпорт-ран' }, { status: 500 });
  }
}
