'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

/**
 * Stage 2D — admin shipment planner. The manager manually distributes order
 * items across shipments (parcels included: physical parameters entered at
 * packing time), picks the destination through the existing Nova Post
 * settlements/divisions proxies and saves the whole plan atomically (PUT →
 * admin_replace_shipment_plan RPC). No Nova Post calculation/TTN here
 * (stage 2E); checkout/payment flows are untouched.
 */

interface OrderInfo {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  total_amount: number;
  currency: string;
  shipping_info: Record<string, string> | null;
  prepayment_amount: number | null;
}

interface ServerItem {
  id: string;
  product_name: string;
  variant_name: string | null;
  sku: string;
  quantity: number;
  price: number;
  total: number;
  allocated: number;
}

interface ServerParcel {
  parcel_index: number;
  cargo_category: string;
  actual_weight_grams: number;
  width_mm: number;
  length_mm: number;
  height_mm: number;
  insurance_cost: number;
  description: string | null;
}

interface ServerShipment {
  id: string;
  shipment_index: number;
  service_type: string;
  city_ref: string;
  city_name: string | null;
  warehouse_ref: string | null;
  warehouse_name: string | null;
  address: string | null;
  status: string;
  cod_amount: number;
  delivery_cost_estimated: number | null;
  ttn_number: string | null;
  delivery_cost: number | null;
  order_shipment_items: { order_item_id: string; quantity: number }[];
  order_shipment_parcels: ServerParcel[];
}

interface PlanParcel {
  parcel_index: number;
  cargo_category: string;
  actual_weight_grams: string;
  width_mm: string;
  length_mm: string;
  height_mm: string;
  insurance_cost: string;
  description: string;
}

interface PlanShipment {
  id: string | null;
  delivery_cost_estimated: number | null;
  service_type: string;
  city_ref: string;
  city_name: string;
  warehouse_ref: string;
  warehouse_name: string;
  address: string;
  cod_amount: string;
  status: string;
  ttn_number: string | null;
  delivery_cost: number | null;
  items: { order_item_id: string; quantity: string }[];
  parcels: PlanParcel[];
}

interface CalcOutcome {
  result: 'calculated' | 'skipped' | 'failed';
  reason?: string;
  message?: string;
  delivery_cost_estimated?: number;
  scheduled_delivery_date?: string | null;
}

interface NpSettlement {
  id: number;
  name: string;
  regionName: string | null;
  regionParentName: string | null;
}

interface NpDivision {
  id: number;
  name: string;
  shortName: string | null;
  address: string | null;
  number: string | null;
}

const CARGO_CATEGORIES = ['parcel', 'documents', 'pallet'] as const;

function emptyShipment(): PlanShipment {
  return {
    id: null,
    delivery_cost_estimated: null,
    service_type: 'nova_poshta_warehouse',
    city_ref: '',
    city_name: '',
    warehouse_ref: '',
    warehouse_name: '',
    address: '',
    cod_amount: '0',
    status: 'planned',
    ttn_number: null,
    delivery_cost: null,
    items: [],
    parcels: [],
  };
}

function shipmentFromServer(s: ServerShipment): PlanShipment {
  return {
    id: s.id,
    delivery_cost_estimated: s.delivery_cost_estimated,
    service_type: s.service_type,
    city_ref: s.city_ref ?? '',
    city_name: s.city_name ?? '',
    warehouse_ref: s.warehouse_ref ?? '',
    warehouse_name: s.warehouse_name ?? '',
    address: s.address ?? '',
    cod_amount: String(s.cod_amount ?? '0'),
    status: s.status ?? 'planned',
    ttn_number: s.ttn_number ?? null,
    delivery_cost: s.delivery_cost ?? null,
    items: (s.order_shipment_items ?? []).map((si) => ({
      order_item_id: si.order_item_id,
      quantity: String(si.quantity),
    })),
    parcels: (s.order_shipment_parcels ?? []).map((p) => ({
      parcel_index: p.parcel_index,
      cargo_category: p.cargo_category,
      actual_weight_grams: String(p.actual_weight_grams),
      width_mm: String(p.width_mm),
      length_mm: String(p.length_mm),
      height_mm: String(p.height_mm),
      insurance_cost: String(p.insurance_cost),
      description: p.description ?? '',
    })),
  };
}

// Module-scope loaders (project react-hooks pattern): every state update
// happens inside async callbacks, never synchronously in an effect body.
async function fetchPlanApi(
  id: string,
  onData: (order: OrderInfo, items: ServerItem[], shipments: ServerShipment[], editable: boolean) => void,
  onError: (message: string) => void,
  onDone: () => void
) {
  try {
    const res = await fetch(`/api/admin/orders/${id}/shipments`);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Не вдалося завантажити план');
    onData(
      data.order as OrderInfo,
      (data.items as ServerItem[]) ?? [],
      (data.shipments as ServerShipment[]) ?? [],
      Boolean(data.editable)
    );
  } catch (err) {
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

async function searchSettlementsApi(
  q: string,
  onData: (items: NpSettlement[]) => void,
  onError: (message: string) => void,
  onDone: () => void
) {
  try {
    const res = await fetch(
      `/api/delivery/novapost/settlements?q=${encodeURIComponent(q)}`
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Не вдалося виконати пошук');
    onData((data?.items as NpSettlement[]) ?? []);
  } catch (err) {
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

async function fetchDivisionsApi(
  settlementId: string,
  onData: (items: NpDivision[]) => void,
  onError: (message: string) => void,
  onDone: () => void
) {
  try {
    const res = await fetch(
      `/api/delivery/novapost/divisions?settlementId=${encodeURIComponent(settlementId)}`
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'Не вдалося завантажити відділення');
    onData((data?.items as NpDivision[]) ?? []);
  } catch (err) {
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

function buildPlanPayload(shipments: PlanShipment[]) {
  return {
    shipments: shipments.map((s, i) => ({
      shipment_index: i + 1,
      service_type: s.service_type,
      city_ref: s.city_ref,
      city_name: s.city_name || null,
      warehouse_ref: s.warehouse_ref || null,
      warehouse_name: s.warehouse_name || null,
      address: s.address || null,
      cod_amount: Number(s.cod_amount) || 0,
      items: s.items.map((it) => ({
        order_item_id: it.order_item_id,
        quantity: Number(it.quantity),
      })),
      parcels: s.parcels.map((p, pi) => ({
        parcel_index: pi + 1,
        cargo_category: p.cargo_category,
        actual_weight_grams: Number(p.actual_weight_grams),
        width_mm: Number(p.width_mm),
        length_mm: Number(p.length_mm),
        height_mm: Number(p.height_mm),
        insurance_cost: Number(p.insurance_cost),
        description: p.description || null,
      })),
    })),
  };
}

export default function ShipmentPlannerPage() {
  const params = useParams<{ id: string }>();
  const orderId = params?.id ?? '';

  const [order, setOrder] = useState<OrderInfo | null>(null);
  const [items, setItems] = useState<ServerItem[]>([]);
  const [editable, setEditable] = useState(true);

  const [draft, setDraft] = useState<PlanShipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [calcResults, setCalcResults] = useState<Record<number, CalcOutcome>>({});
  const [ttnBusy, setTtnBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // City search + divisions state (per shipment, keyed by shipment position).
  const [cityQuery, setCityQuery] = useState('');
  const [cityResults, setCityResults] = useState<NpSettlement[]>([]);
  const [citySearchIdx, setCitySearchIdx] = useState<number | null>(null);
  const [divisions, setDivisions] = useState<NpDivision[]>([]);
  const [pickerBusy, setPickerBusy] = useState(false);

  const applyData = useCallback(
    (o: OrderInfo, serverItems: ServerItem[], shipments: ServerShipment[], canEdit: boolean) => {
      setOrder(o);
      setItems(serverItems);
      setEditable(canEdit);
      setDraft(shipments.map(shipmentFromServer));
      setError(null);
      setNotice(null);
      setCalcResults({});
    },
    []
  );

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;
    fetchPlanApi(
      orderId,
      (o, serverItems, shipments, canEdit) => {
        if (!cancelled) applyData(o, serverItems, shipments, canEdit);
      },
      (message) => {
        if (!cancelled) setError(message);
      },
      () => {
        if (!cancelled) setLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [orderId, applyData]);

  const runCitySearch = (idx: number, q: string) => {
    setCitySearchIdx(idx);
    setCityQuery(q);
    if (q.trim().length < 2) {
      setCityResults([]);
      return;
    }
    setPickerBusy(true);
    searchSettlementsApi(
      q.trim(),
      (found) => setCityResults(found),
      (message) => setError(message),
      () => setPickerBusy(false)
    );
  };

  const runDivisionsLoad = (idx: number, settlementId: string) => {
    setPickerBusy(true);
    fetchDivisionsApi(
      settlementId,
      (found) => {
        setDivisions(found);
        setCitySearchIdx(idx);
      },
      (message) => setError(message),
      () => setPickerBusy(false)
    );
  };

  const updateShipment = (idx: number, patch: Partial<PlanShipment>) => {
    setDraft((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const updateItemQty = (idx: number, itemId: string, qty: string) => {
    updateShipment(idx, {
      items: draft[idx].items.map((it) =>
        it.order_item_id === itemId ? { ...it, quantity: qty } : it
      ),
    });
  };

  const addItemToShipment = (idx: number, itemId: string) => {
    if (draft[idx].items.some((it) => it.order_item_id === itemId)) return;
    updateShipment(idx, {
      items: [...draft[idx].items, { order_item_id: itemId, quantity: '1' }],
    });
  };

  const removeItemFromShipment = (idx: number, itemId: string) => {
    updateShipment(idx, {
      items: draft[idx].items.filter((it) => it.order_item_id !== itemId),
    });
  };

  const updateParcel = (idx: number, parcelIdx: number, patch: Partial<PlanParcel>) => {
    updateShipment(idx, {
      parcels: draft[idx].parcels.map((p, i) => (i === parcelIdx ? { ...p, ...patch } : p)),
    });
  };

  const allocatedInShipment = (idx: number, itemId: string): number =>
    Number(draft[idx].items.find((it) => it.order_item_id === itemId)?.quantity ?? 0);

  const remainingFor = (item: ServerItem): number =>
    item.quantity -
    item.allocated -
    draft.reduce(
      (sum, _, idx) =>
        sum +
        (draft[idx].items.some((it) => it.order_item_id === item.id)
          ? allocatedInShipment(idx, item.id)
          : 0),
      0
    );

  const save = async () => {
    if (!orderId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/shipments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPlanPayload(draft)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Не вдалося зберегти план');
      // Reload authoritative state from the server after the atomic save.
      fetchPlanApi(orderId, applyData, setError, () => setSaving(false));
      setNotice('План відправлень збережено');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
      setSaving(false);
    }
  };

  const calculate = async () => {
    if (!orderId) return;
    setCalculating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/shipments/calculate`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Не вдалося розрахувати вартість');
      const outcomes = (data?.results ?? []) as (CalcOutcome & { shipment_index: number })[];
      setCalcResults(
        Object.fromEntries(outcomes.map((o) => [o.shipment_index, o]))
      );
      // Reload persisted delivery_cost_estimated values.
      fetchPlanApi(
        orderId,
        (o, serverItems, shipments, canEdit) => {
          applyData(o, serverItems, shipments, canEdit);
          // restore calc outcomes wiped by applyData's reload
          setCalcResults(
            Object.fromEntries(outcomes.map((o) => [o.shipment_index, o]))
          );
        },
        setError,
        () => setCalculating(false)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
      setCalculating(false);
    }
  };

  const createTtn = async (idx: number) => {
    const shipment = draft[idx];
    if (!orderId || !shipment.id) return;
    setTtnBusy(idx);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/shipments/ttn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipment_id: shipment.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Не вдалося створити ТТН');
      setNotice(
        data?.result === 'adopted'
          ? 'ТТН знайдено та прикріплено до відправлення'
          : `ТТН створено: ${data?.ttn_number ?? ''}`
      );
      // Reload authoritative state (status/ttn_number/delivery_cost).
      fetchPlanApi(orderId, applyData, setError, () => setTtnBusy(null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
      setTtnBusy(null);
    }
  };

  const rollbackTtn = async (idx: number) => {
    const shipment = draft[idx];
    if (!orderId || !shipment.id) return;
    setTtnBusy(idx);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/shipments/ttn`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipment_id: shipment.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Не вдалося скасувати ТТН');
      setNotice('ТТН скасовано, відправлення повернуто в planned');
      fetchPlanApi(orderId, applyData, setError, () => setTtnBusy(null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
      setTtnBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <p className="text-gray-500">Завантаження…</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="container mx-auto px-4 py-8">
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <Link href="/admin/orders" className="text-blue-600 hover:underline">
          ← До замовлень
        </Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight text-gray-900">
          Відправлення — <span className="font-mono">{order.order_number}</span>
        </h1>
        <div className="flex gap-3 text-sm">
          {!editable && (
            <span className="px-3 py-1.5 text-sm text-gray-500 border border-gray-200 rounded">
              Тільки перегляд — план зафіксовано
            </span>
          )}
          {editable && (
            <>
              <button
                type="button"
                onClick={calculate}
                disabled={calculating || saving || draft.length === 0}
                className="px-4 py-1.5 bg-emerald-600 text-white rounded text-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {calculating ? 'Розрахунок…' : 'Розрахувати вартість'}
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || calculating || draft.length === 0}
                className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Збереження…' : 'Зберегти план'}
              </button>
            </>
          )}
        </div>
      </div>

      <p className="text-sm text-gray-600 mb-4">
        Сума замовлення: {order.total_amount} {order.currency}
        {order.prepayment_amount !== null && ` · передоплата: ${order.prepayment_amount}`}
        {' · '}
        <Link href="/admin/orders" className="text-blue-600 hover:underline">
          ← До замовлень
        </Link>
      </p>

      {order.shipping_info && Object.keys(order.shipping_info).length > 0 && (
        <p className="text-xs text-gray-500 mb-4">
          Доставка з замовлення: {Object.entries(order.shipping_info).map(([k, v]) => `${k}: ${v}`).join(', ')}
        </p>
      )}

      {error && <div className="alert alert-error mb-4" role="alert">{error}</div>}
      {notice && <div className="alert mb-4" role="status">{notice}</div>}

      {draft.map((shipment, idx) => {
        const isWarehouse = shipment.service_type === 'nova_poshta_warehouse';
        return (
          <div key={idx} className="bg-white rounded-lg shadow p-4 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h2 className="font-semibold">
                Відправлення {idx + 1}
                {shipment.id && shipment.delivery_cost_estimated !== null && (
                  <span className="ml-3 text-sm font-normal text-emerald-700">
                    Розрахована вартість: {shipment.delivery_cost_estimated} {order.currency}
                  </span>
                )}
                {shipment.ttn_number && (
                  <span className="ml-3 text-sm font-normal text-indigo-700">
                    ТТН: <span className="font-mono">{shipment.ttn_number}</span>
                    {shipment.delivery_cost !== null &&
                      ` · вартість: ${shipment.delivery_cost} ${order.currency}`}
                    {` · статус: ${shipment.status}`}
                  </span>
                )}
              </h2>
              <div className="flex items-center gap-3">
                {shipment.id && shipment.status === 'planned' && (
                  <button
                    type="button"
                    onClick={() => createTtn(idx)}
                    disabled={ttnBusy !== null || !isWarehouse}
                    title={
                      !isWarehouse
                        ? 'ТТН для кур’єрської доставки поки недоступна'
                        : undefined
                    }
                    className="px-3 py-1 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {ttnBusy === idx ? 'Створення…' : 'Створити ТТН'}
                  </button>
                )}
                {shipment.id && shipment.ttn_number && shipment.status === 'created' && (
                  <button
                    type="button"
                    onClick={() => rollbackTtn(idx)}
                    disabled={ttnBusy !== null}
                    className="px-3 py-1 border border-gray-300 text-gray-700 rounded text-sm hover:bg-gray-50 disabled:opacity-50"
                  >
                    {ttnBusy === idx ? 'Скасування…' : 'Скасувати ТТН'}
                  </button>
                )}
                {editable && (
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-red-600 hover:text-red-800 text-sm"
                  >
                    Видалити
                  </button>
                )}
              </div>
            </div>

            {calcResults[idx] && (
              <div
                className={`text-sm mb-3 px-3 py-2 rounded ${
                  calcResults[idx].result === 'calculated'
                    ? 'bg-emerald-50 text-emerald-800'
                    : calcResults[idx].result === 'skipped'
                      ? 'bg-gray-50 text-gray-600'
                      : 'bg-red-50 text-red-700'
                }`}
              >
                {calcResults[idx].result === 'calculated' && (
                  <>
                    Вартість доставки: <b>{calcResults[idx].delivery_cost_estimated} {order.currency}</b>
                    {calcResults[idx].scheduled_delivery_date &&
                      ` · орієнтовно до ${String(calcResults[idx].scheduled_delivery_date).slice(0, 10)}`}
                    {' '}(включає збір за оголошену вартість)
                  </>
                )}
                {calcResults[idx].result === 'skipped' && (
                  calcResults[idx].reason === 'courier_not_supported'
                    ? 'Розрахунок кур’єрської доставки поки недоступний (очікує уточнення Nova Post)'
                    : calcResults[idx].reason === 'no_parcels'
                      ? 'Пропущено: немає місць (посилок)'
                      : calcResults[idx].reason === 'not_planned'
                        ? 'Пропущено: відправлення не в статусі planned'
                        : 'Пропущено'
                )}
                {calcResults[idx].result === 'failed' && (
                  <>Помилка розрахунку: {calcResults[idx].reason}
                    {calcResults[idx].message ? ` — ${calcResults[idx].message}` : ''}</>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3 text-sm">
              <label className="block">
                <span className="text-gray-500 block mb-1">Тип доставки</span>
                <select
                  value={shipment.service_type}
                  disabled={!editable}
                  onChange={(e) =>
                    updateShipment(idx, {
                      service_type: e.target.value,
                      // destination XOR: switching mode clears the other side
                      warehouse_ref: '',
                      warehouse_name: '',
                      address: '',
                    })
                  }
                  className="input"
                >
                  <option value="nova_poshta_warehouse">Nova Post — відділення</option>
                  <option value="nova_poshta_courier">Nova Post — кур&apos;єр</option>
                </select>
              </label>

              <label className="block">
                <span className="text-gray-500 block mb-1">Місто</span>
                <input
                  type="text"
                  value={citySearchIdx === idx && cityQuery ? cityQuery : shipment.city_name}
                  disabled={!editable}
                  placeholder="Пошук міста…"
                  onChange={(e) => runCitySearch(idx, e.target.value)}
                  className="input"
                />
                {shipment.city_ref && citySearchIdx !== idx && (
                  <span className="text-xs text-gray-400">ref: {shipment.city_ref}</span>
                )}
              </label>

              {isWarehouse ? (
                <label className="block">
                  <span className="text-gray-500 block mb-1">Відділення</span>
                  {shipment.city_ref ? (
                    <select
                      value={shipment.warehouse_ref}
                      disabled={!editable}
                      onChange={(e) => {
                        const d = divisions.find((x) => String(x.id) === e.target.value);
                        updateShipment(idx, {
                          warehouse_ref: e.target.value,
                          warehouse_name: d ? [d.name, d.shortName, d.address].filter(Boolean).join(', ') : '',
                        });
                      }}
                      onFocus={() => runDivisionsLoad(idx, shipment.city_ref)}
                      className="input"
                    >
                      <option value="">— оберіть відділення —</option>
                      {citySearchIdx === idx &&
                        divisions.map((d) => (
                          <option key={d.id} value={String(d.id)}>
                            {d.name}
                            {d.address ? ` (${d.address})` : ''}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <span className="text-gray-400">спочатку оберіть місто</span>
                  )}
                </label>
              ) : (
                <label className="block md:col-span-2">
                  <span className="text-gray-500 block mb-1">Адреса кур&apos;єрської доставки</span>
                  <input
                    type="text"
                    value={shipment.address}
                    disabled={!editable}
                    onChange={(e) => updateShipment(idx, { address: e.target.value })}
                    className="input"
                  />
                </label>
              )}

              <label className="block">
                <span className="text-gray-500 block mb-1">Наложений платіж</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={shipment.cod_amount}
                  disabled={!editable}
                  onChange={(e) => updateShipment(idx, { cod_amount: e.target.value })}
                  className="input"
                />
              </label>
            </div>

            {/* Item allocation */}
            <h3 className="text-sm font-semibold mb-1">Товари</h3>
            <table className="w-full text-sm mb-3">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase border-b">
                  <th className="py-1">Товар</th>
                  <th className="py-1 text-right">Замовлено</th>
                  <th className="py-1 text-right">В цьому відпр.</th>
                  <th className="py-1 text-right">Вільно</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item) => {
                  const inShipment = shipment.items.find((it) => it.order_item_id === item.id);
                  const remaining = remainingFor(item);
                  return (
                    <tr key={item.id}>
                      <td className="py-1">
                        {item.product_name}
                        {item.variant_name && <span className="text-gray-500"> · {item.variant_name}</span>}
                        <span className="block text-xs text-gray-400">SKU: {item.sku}</span>
                      </td>
                      <td className="py-1 text-right">{item.quantity}</td>
                      <td className="py-1 text-right">
                        {inShipment ? (
                          editable ? (
                            <input
                              type="number"
                              min="1"
                              value={inShipment.quantity}
                              onChange={(e) => updateItemQty(idx, item.id, e.target.value)}
                              className="input w-20 text-right"
                            />
                          ) : (
                            inShipment.quantity
                          )
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-1 text-right text-gray-500">{remaining}</td>
                      {editable && (
                        <td className="py-1 text-right">
                          {inShipment ? (
                            <button
                              type="button"
                              onClick={() => removeItemFromShipment(idx, item.id)}
                              className="text-red-600 hover:text-red-800 text-xs"
                            >
                              прибрати
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={remaining < 1}
                              onClick={() => addItemToShipment(idx, item.id)}
                              className="text-blue-600 hover:text-blue-800 text-xs disabled:opacity-40"
                            >
                              додати
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Parcels */}
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold">
                Місця (посилки, до 10)
              </h3>
              {editable && (
                <button
                  type="button"
                  disabled={!editable || shipment.parcels.length >= 10}
                  onClick={() =>
                    updateShipment(idx, {
                      parcels: [
                        ...shipment.parcels,
                        {
                          parcel_index: shipment.parcels.length + 1,
                          cargo_category: 'parcel',
                          actual_weight_grams: '',
                          width_mm: '',
                          length_mm: '',
                          height_mm: '',
                          insurance_cost: '',
                          description: '',
                        },
                      ],
                    })
                  }
                  className="text-blue-600 hover:text-blue-800 text-sm disabled:opacity-40"
                >
                  + місце
                </button>
              )}
            </div>
            {shipment.parcels.map((p, pi) => (
              <div key={pi} className="border rounded p-2 mb-2 text-sm">
                <div className="flex flex-wrap gap-2 items-end">
                  <label className="block">
                    <span className="text-gray-500 block text-xs">Категорія</span>
                    <select
                      value={p.cargo_category}
                      disabled={!editable}
                      onChange={(e) => updateParcel(idx, pi, { cargo_category: e.target.value })}
                      className="input"
                    >
                      {CARGO_CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-gray-500 block text-xs">Вага, г (кратно 10)</span>
                    <input
                      type="number"
                      min="10"
                      step="10"
                      value={p.actual_weight_grams}
                      disabled={!editable}
                      onChange={(e) => updateParcel(idx, pi, { actual_weight_grams: e.target.value })}
                      className="input w-32"
                    />
                  </label>
                  <label className="block">
                    <span className="text-gray-500 block text-xs">Ш, мм</span>
                    <input
                      type="number"
                      min="1"
                      value={p.width_mm}
                      disabled={!editable}
                      onChange={(e) => updateParcel(idx, pi, { width_mm: e.target.value })}
                      className="input w-24"
                    />
                  </label>
                  <label className="block">
                    <span className="text-gray-500 block text-xs">Д, мм</span>
                    <input
                      type="number"
                      min="1"
                      value={p.length_mm}
                      disabled={!editable}
                      onChange={(e) => updateParcel(idx, pi, { length_mm: e.target.value })}
                      className="input w-24"
                    />
                  </label>
                  <label className="block">
                    <span className="text-gray-500 block text-xs">В, мм</span>
                    <input
                      type="number"
                      min="1"
                      value={p.height_mm}
                      disabled={!editable}
                      onChange={(e) => updateParcel(idx, pi, { height_mm: e.target.value })}
                      className="input w-24"
                    />
                  </label>
                  <label className="block">
                    <span className="text-gray-500 block text-xs">Оголошена вартість, ₴</span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={p.insurance_cost}
                      disabled={!editable}
                      onChange={(e) => updateParcel(idx, pi, { insurance_cost: e.target.value })}
                      className="input w-28"
                    />
                  </label>
                  <label className="block flex-1 min-w-40">
                    <span className="text-gray-500 block text-xs">Опис</span>
                    <input
                      type="text"
                      value={p.description}
                      disabled={!editable}
                      onChange={(e) => updateParcel(idx, pi, { description: e.target.value })}
                      className="input"
                    />
                  </label>
                  {editable && (
                    <button
                      type="button"
                      onClick={() =>
                        updateShipment(idx, {
                          parcels: shipment.parcels.filter((_, i) => i !== pi),
                        })
                      }
                      className="text-red-600 hover:text-red-800 text-xs mb-1"
                    >
                      видалити
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}

      {editable && (
        <button
          type="button"
          onClick={() => setDraft((prev) => [...prev, emptyShipment()])}
          className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
        >
          + Додати відправлення
        </button>
      )}

      {draft.length === 0 && !editable && (
        <p className="text-gray-500 text-sm">Відправлень немає</p>
      )}
    </div>
  );
}
