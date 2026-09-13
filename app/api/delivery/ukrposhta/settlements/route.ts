import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { getUkrposhtaClient } from '@/app/lib/delivery/ukrposhta/client';
import { mapUkrposhtaFailure } from '@/app/lib/delivery/ukrposhta/map-failure';
import {
  parseSettlementsQuery,
  searchSettlements,
} from '@/app/lib/delivery/ukrposhta/settlements';

/**
 * GET /api/delivery/ukrposhta/settlements?q=&limit=
 * City autocomplete proxy against the OPEN Ukrposhta Address Classifier
 * (keyless server-side; the browser never talks to Ukrposhta directly).
 * The response contains only normalized public reference data — integer
 * classifier CITY_IDs issued by the pinned production host
 * www.ukrposhta.ua.
 */

const UKRPOSHTA_LOOKUP_FAILED = 'Не вдалося виконати пошук. Спробуйте пізніше';

export async function GET(request: Request) {
  const limited = await enforceRateLimit(request, 'ukrposhtaSettlements');
  if (limited) return limited;

  const parsed = parseSettlementsQuery(new URL(request.url).searchParams);
  if (!parsed) {
    return NextResponse.json({ error: UKRPOSHTA_LOOKUP_FAILED }, { status: 400 });
  }

  try {
    const items = await searchSettlements(getUkrposhtaClient(), parsed);
    return NextResponse.json({ items });
  } catch (error) {
    const failure = mapUkrposhtaFailure(error);
    if (failure) {
      console.error(
        `ukrposhta settlements failed: ${String((error as Error).message).slice(0, 120)}`
      );
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    console.error('ukrposhta settlements failed with unexpected error');
    return NextResponse.json({ error: UKRPOSHTA_LOOKUP_FAILED }, { status: 502 });
  }
}
