import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { getNovaPostClient } from '@/app/lib/delivery/novapost/client';
import { mapNovaPostFailure } from '@/app/lib/delivery/novapost/map-failure';
import {
  parseStreetsQuery,
  searchStreets,
} from '@/app/lib/delivery/novapost/streets';

/**
 * GET /api/delivery/novapost/streets?settlementId=&name=&limit=&page=
 * Street autocomplete for the courier checkout branch (stage 2G).
 * Live-verified provider contract: the filter parameter is `name` (NOT
 * `textSearch`) and settlementId is an integer from GET /settlements.
 * Proxy-only: the browser never talks to Nova Post directly; the response
 * contains normalized public reference data only.
 */

const NOVA_POST_STREETS_FAILED =
  'Не вдалося завантажити вулиці. Спробуйте пізніше';

export async function GET(request: Request) {
  const limited = await enforceRateLimit(request, 'novaPoshtaStreets');
  if (limited) return limited;

  const parsed = parseStreetsQuery(new URL(request.url).searchParams);
  if (!parsed) {
    return NextResponse.json(
      { error: 'Некоректний запит: оберіть місто і введіть назву вулиці' },
      { status: 400 }
    );
  }

  try {
    const items = await searchStreets(getNovaPostClient(), parsed);
    return NextResponse.json({ items });
  } catch (error) {
    const failure = mapNovaPostFailure(error);
    if (failure) {
      console.error(
        `nova post streets failed: ${String((error as Error).message).slice(0, 120)}`
      );
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    console.error('nova post streets failed with unexpected error');
    return NextResponse.json({ error: NOVA_POST_STREETS_FAILED }, { status: 502 });
  }
}
