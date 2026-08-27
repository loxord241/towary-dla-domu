import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { getNovaPostClient } from '@/app/lib/delivery/novapost/client';
import { mapNovaPostFailure } from '@/app/lib/delivery/novapost/map-failure';
import {
  parseDeliveryCostBody,
  calculateDeliveryCost,
} from '@/app/lib/delivery/novapost/delivery-cost';

/**
 * POST /api/delivery/novapost/delivery-cost
 * Delivery cost calculation proxy. Cargo parameters come from the client
 * (weights/dimensions are NOT stored on products), but they are strictly
 * validated before any provider call; payerType and country codes are
 * fixed server-side and can never be overridden by the request.
 * When Nova Post gives no calculation, a controlled 502/503 is returned —
 * never a fake or estimated price.
 */

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'novaPoshtaDeliveryCost');
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

  try {
    const quote = await calculateDeliveryCost(getNovaPostClient(), parsed);
    return NextResponse.json({ quote });
  } catch (error) {
    const failure = mapNovaPostFailure(error);
    if (failure) {
      console.error(
        `nova post calculation failed: ${String((error as Error).message).slice(0, 120)}`
      );
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    console.error('nova post calculation failed with unexpected error');
    return NextResponse.json(
      { error: 'Не вдалося розрахувати вартість. Спробуйте пізніше' },
      { status: 502 }
    );
  }
}
