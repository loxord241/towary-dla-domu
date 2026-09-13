import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { getUkrposhtaClient } from '@/app/lib/delivery/ukrposhta/client';
import { mapUkrposhtaFailure } from '@/app/lib/delivery/ukrposhta/map-failure';
import {
  parseDeliveryCostBody,
  calculateDeliveryCost,
} from '@/app/lib/delivery/ukrposhta/delivery-cost';
import { readUkrposhtaSenderPostIndex } from '@/app/lib/delivery/ukrposhta/config';

/**
 * POST /api/delivery/ukrposhta/delivery-cost
 * Ukrposhta Ecom price-calculation proxy (POST /domestic/delivery-price).
 *
 * FAIL-CLOSED: Ukrposhta issues the Ecom bearer only after a signed
 * contract. Without UKRPOSHTA_BEARER (or without the sender post index)
 * this route answers a controlled 503 BEFORE any provider call — never a
 * network throw and never a fake or estimated price. The client body
 * carries units in our DB conventions (grams + millimeters); the mm → cm
 * conversion for the provider happens in exactly one documented place
 * (delivery-cost.ts).
 */

const UKRPOSHTA_CALC_FAILED =
  'Не вдалося розрахувати вартість. Спробуйте пізніше';

export async function POST(request: Request) {
  const limited = await enforceRateLimit(request, 'ukrposhtaDeliveryCost');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некоректний JSON' }, { status: 400 });
  }

  const parsed = parseDeliveryCostBody(body);
  if (!parsed) {
    return NextResponse.json(
      { error: 'Некоректні параметри відправлення' },
      { status: 400 }
    );
  }

  const senderPostIndex = readUkrposhtaSenderPostIndex();
  if (senderPostIndex === null) {
    console.error('ukrposhta calculation failed: sender post index is not configured');
    return NextResponse.json({ error: UKRPOSHTA_CALC_FAILED }, { status: 503 });
  }

  try {
    const quote = await calculateDeliveryCost(
      getUkrposhtaClient(),
      parsed,
      senderPostIndex
    );
    return NextResponse.json({ quote });
  } catch (error) {
    const failure = mapUkrposhtaFailure(error);
    if (failure) {
      console.error(
        `ukrposhta calculation failed: ${String((error as Error).message).slice(0, 120)}`
      );
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    console.error('ukrposhta calculation failed with unexpected error');
    return NextResponse.json({ error: UKRPOSHTA_CALC_FAILED }, { status: 502 });
  }
}
