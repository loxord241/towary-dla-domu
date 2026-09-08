import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { getUkrposhtaClient } from '@/app/lib/delivery/ukrposhta/client';
import { mapUkrposhtaFailure } from '@/app/lib/delivery/ukrposhta/map-failure';
import {
  parseOfficesQuery,
  findOfficesByCityId,
} from '@/app/lib/delivery/ukrposhta/offices';

/**
 * GET /api/delivery/ukrposhta/offices?cityId=
 * Post offices of a settlement (keyless classifier proxy). The output is
 * normalized AND filtered: only ACTIVE records
 * (POLOCK_UA = «Активний запис») can ever leave this route — a
 * blocked/closed office is structurally impossible in the response — and
 * the list is capped (OFFICES_MAX).
 */

const UKRPOSHTA_OFFICES_FAILED =
  'Не вдалося завантажити відділення. Спробуйте пізніше';

export async function GET(request: Request) {
  const limited = enforceRateLimit(request, 'ukrposhtaOffices');
  if (limited) return limited;

  const parsed = parseOfficesQuery(new URL(request.url).searchParams);
  if (!parsed) {
    return NextResponse.json({ error: 'Некоректне місто' }, { status: 400 });
  }

  try {
    const items = await findOfficesByCityId(getUkrposhtaClient(), parsed);
    return NextResponse.json({ items });
  } catch (error) {
    const failure = mapUkrposhtaFailure(error);
    if (failure) {
      console.error(
        `ukrposhta offices failed: ${String((error as Error).message).slice(0, 120)}`
      );
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    console.error('ukrposhta offices failed with unexpected error');
    return NextResponse.json({ error: UKRPOSHTA_OFFICES_FAILED }, { status: 502 });
  }
}
