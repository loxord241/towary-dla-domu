import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { getNovaPostClient } from '@/app/lib/delivery/novapost/client';
import { mapNovaPostFailure } from '@/app/lib/delivery/novapost/map-failure';
import {
  parseDivisionsQuery,
  findDivisions,
} from '@/app/lib/delivery/novapost/divisions';

/**
 * GET /api/delivery/novapost/divisions?settlementId=&limit=&page=
 * Branches / parcel lockers for a settlement. Proxy-only: the browser
 * never talks to Nova Post directly; the response contains normalized
 * public reference data only.
 */

const NOVA_POST_DIVISIONS_FAILED =
  'Не вдалося завантажити відділення. Спробуйте пізніше';

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, 'novaPoshtaDivisions');
  if (limited) return limited;

  const parsed = parseDivisionsQuery(new URL(request.url).searchParams);
  if (!parsed) {
    return NextResponse.json({ error: 'Некоректне місто' }, { status: 400 });
  }

  try {
    const items = await findDivisions(getNovaPostClient(), parsed);
    return NextResponse.json({ items });
  } catch (error) {
    const failure = mapNovaPostFailure(error);
    if (failure) {
      console.error(
        `nova post divisions failed: ${String((error as Error).message).slice(0, 120)}`
      );
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    console.error('nova post divisions failed with unexpected error');
    return NextResponse.json({ error: NOVA_POST_DIVISIONS_FAILED }, { status: 502 });
  }
}
