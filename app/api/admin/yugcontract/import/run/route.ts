import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import {
  claimNextBatch,
  executeBatch,
  makeRealDeps,
} from '@/app/lib/yugcontract/import-run';

// One batch per invocation: measured worst batch ≈ 10 s + ~0.6 MB feed.
export const maxDuration = 60;

/**
 * POST /api/admin/yugcontract/import/run   body: { runId }
 *
 * Executes EXACTLY ONE checkpointed batch (categories first, then the
 * next pending/failed/stale products batch) and returns its outcome.
 * Repeat calls until `{ nextBatch: null }`. Every call is safe to repeat:
 * finished batches are skipped, failed ones retry idempotently.
 */
export async function POST(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const limited = enforceRateLimit(request, 'yugcontractImportRun');
  if (limited) return limited;

  try {
    const body = (await request.json().catch(() => ({}))) as { runId?: string };
    if (typeof body.runId !== 'string' || body.runId.trim() === '') {
      return NextResponse.json({ error: 'Потрібен runId' }, { status: 400 });
    }

    const runId = body.runId.trim().slice(0, 100);
    const batch = await claimNextBatch(ctx.serviceClient, runId);
    if (batch === null) {
      return NextResponse.json({ runId, nextBatch: null });
    }

    const outcome = await executeBatch(ctx.serviceClient, batch, makeRealDeps());
    return NextResponse.json({
      runId,
      nextBatch: outcome.status === 'done' ? 'continue' : 'retry-or-inspect',
      outcome,
    });
  } catch {
    console.error('yc import run failed');
    return NextResponse.json(
      { error: 'Помилка виконання батча імпорту' },
      { status: 500 }
    );
  }
}
