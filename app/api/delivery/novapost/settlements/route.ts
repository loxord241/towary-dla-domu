import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { getNovaPostClient } from '@/app/lib/delivery/novapost/client';
import { mapNovaPostFailure } from '@/app/lib/delivery/novapost/map-failure';
import {
  parseSettlementsQuery,
  searchSettlements,
} from '@/app/lib/delivery/novapost/settlements';

/**
 * GET /api/delivery/novapost/settlements?q=&limit=&page=
 * City autocomplete proxy. The browser never talks to Nova Post directly:
 * Browser -> this route -> server-side client -> Nova Post.
 * The response contains only normalized public reference data.
 */

export async function GET(request: Request) {
  const limited = await enforceRateLimit(request, 'novaPoshtaSettlements');
  if (limited) return limited;

  const parsed = parseSettlementsQuery(new URL(request.url).searchParams);
  if (!parsed) {
    return NextResponse.json(
      { error: NOVA_POST_LOOKUP_FAILED },
      { status: 400 }
    );
  }

  try {
    const items = await searchSettlements(getNovaPostClient(), parsed);
    return NextResponse.json({ items });
  } catch (error) {
    const failure = mapNovaPostFailure(error);
    if (failure) {
      console.error(
        `nova post settlements failed: ${String((error as Error).message).slice(0, 120)}`
      );
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    console.error('nova post settlements failed with unexpected error');
    return NextResponse.json({ error: NOVA_POST_LOOKUP_FAILED }, { status: 502 });
  }
}

const NOVA_POST_LOOKUP_FAILED = 'Не вдалося виконати пошук. Спробуйте пізніше';
