import { NextResponse } from 'next/server';
import { requireAdminApi, isUuid } from '@/app/lib/admin-api';
import { buildCalculationInput, selectDeliveryService } from '@/app/lib/admin-shipments-calc';
import { calculateDeliveryCost } from '@/app/lib/delivery/novapost/delivery-cost';
import { mapNovaPostFailure } from '@/app/lib/delivery/novapost/map-failure';
import { getNovaPostClient } from '@/app/lib/delivery/novapost/client';
import { NovaPostError } from '@/app/lib/delivery/novapost/errors';
import { readNovaPostSenderDivisionId } from '@/app/lib/delivery/novapost/config';

/**
 * Stage 2E + 2G — admin delivery cost calculation.
 *
 * POST /api/admin/orders/[id]/shipments/calculate
 *   For every planned shipment with parcels: builds the request from DB
 *   data (sender division from the server-side env; warehouse recipient by
 *   divisionId from warehouse_ref; courier recipient by
 *   recipient.settlementId from city_ref + structured address parts —
 *   stage 2G, live-verified locator), calls the read-only
 *   POST /shipments/calculations proxy and persists ONLY
 *   delivery_cost_estimated (cod_amount and the COD/allocation invariants
 *   are untouched; ttn_* is never written).
 *
 * Fail-closed rules (verified live 2026-08-27/28):
 *   - courier shipments without structured street/building are skipped:
 *     NP resolves cities only by settlementId, free text is rejected;
 *   - the quote must contain exactly one valid service row.
 */

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id замовлення' }, { status: 400 });
  }

  const senderDivisionId = readNovaPostSenderDivisionId();
  if (senderDivisionId === null) {
    return NextResponse.json(
      { error: 'Розрахунок не налаштовано: відсутній NOVA_POST_SENDER_DIVISION_ID' },
      { status: 503 }
    );
  }

  try {
    const shipmentsRes = await ctx.serviceClient
      .from('order_shipments')
      .select(
        'id, shipment_index, status, service_type, city_ref, city_name, warehouse_ref, street_name, building, flat, order_shipment_parcels(parcel_index, cargo_category, actual_weight_grams, width_mm, length_mm, height_mm, insurance_cost)'
      )
      .eq('order_id', id)
      .order('shipment_index');
    if (shipmentsRes.error) {
      console.error('admin calc fetch failed:', shipmentsRes.error.message);
      return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
    }

    type Row = {
      id: string;
      shipment_index: number;
      status: string;
      service_type: string;
      city_ref: string | null;
      city_name: string | null;
      warehouse_ref: string | null;
      street_name: string | null;
      building: string | null;
      flat: string | null;
      order_shipment_parcels: {
        parcel_index: number;
        cargo_category: string;
        actual_weight_grams: number;
        width_mm: number;
        length_mm: number;
        height_mm: number;
        insurance_cost: number;
      }[];
    };
    const rows = (shipmentsRes.data ?? []) as unknown as Row[];

    const client = getNovaPostClient();
    const results: Record<string, unknown>[] = [];

    for (const row of rows) {
      const built = buildCalculationInput({
        shipment_id: row.id,
        shipment_index: row.shipment_index,
        status: row.status,
        service_type: row.service_type,
        city_ref: row.city_ref,
        city_name: row.city_name,
        warehouse_ref: row.warehouse_ref,
        street_name: row.street_name,
        building: row.building,
        flat: row.flat,
        parcels: row.order_shipment_parcels ?? [],
      });
      if (!built.ok) {
        results.push({
          shipment_id: row.id,
          shipment_index: row.shipment_index,
          result: 'skipped',
          reason: built.reason,
        });
        continue;
      }

      try {
        const quote = await calculateDeliveryCost(
          client,
          built.input,
          senderDivisionId
        );
        const selected = selectDeliveryService(quote);
        if (!selected.ok) {
          console.error(
            `admin calc ambiguous quote for shipment ${row.id}: ${selected.error}`
          );
          results.push({
            shipment_id: row.id,
            shipment_index: row.shipment_index,
            result: 'failed',
            reason: selected.error,
          });
          continue;
        }

        const upd = await ctx.serviceClient
          .from('order_shipments')
          .update({ delivery_cost_estimated: selected.cost })
          .eq('id', row.id);
        if (upd.error) {
          console.error('admin calc estimate update failed:', upd.error.message);
          results.push({
            shipment_id: row.id,
            shipment_index: row.shipment_index,
            result: 'failed',
            reason: 'estimate_update_failed',
          });
          continue;
        }

        results.push({
          shipment_id: row.id,
          shipment_index: row.shipment_index,
          result: 'calculated',
          delivery_cost_estimated: selected.cost,
          scheduled_delivery_date: selected.scheduledDeliveryDate,
        });
      } catch (err) {
        if (err instanceof NovaPostError) {
          const failure = mapNovaPostFailure(err);
          results.push({
            shipment_id: row.id,
            shipment_index: row.shipment_index,
            result: 'failed',
            reason: failure ? 'provider_error' : 'unexpected_error',
            message: failure ? failure.message : 'Помилка провайдера',
          });
          continue;
        }
        throw err;
      }
    }

    return NextResponse.json({ results });
  } catch (err) {
    console.error('Admin shipment calc API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
