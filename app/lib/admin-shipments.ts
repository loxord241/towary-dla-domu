/**
 * Admin shipment planning (stage 2D) — payload validation.
 *
 * Mirrors the DB constraints of migrations 019/020 so the manager gets
 * readable errors before the atomic RPC runs:
 *   - destination XOR (warehouse ref vs courier address) — chk_order_shipments_destination;
 *   - weight multiple of 10 g, dims in mm — order_shipment_parcels checks;
 *   - allocation limits are enforced by the DB triggers, not here (they need
 *     the ordered quantities).
 *
 * Pure functions, no HTTP/DB. The plan is replace-all: the RPC recreates the
 * order's planned shipments from this payload in one transaction.
 */

export const MAX_SHIPMENTS = 20;
export const MAX_PARCELS_PER_SHIPMENT = 10;

export const SERVICE_TYPES = ['nova_poshta_warehouse', 'nova_poshta_courier'] as const;
export const CARGO_CATEGORIES = ['parcel', 'documents', 'pallet'] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number];
export type CargoCategory = (typeof CARGO_CATEGORIES)[number];

export interface ShipmentPlanItemInput {
  order_item_id: string;
  quantity: number;
}

export interface ShipmentPlanParcelInput {
  parcel_index: number;
  cargo_category: CargoCategory;
  actual_weight_grams: number;
  width_mm: number;
  length_mm: number;
  height_mm: number;
  insurance_cost: number;
  description: string | null;
}

export interface ShipmentPlanInput {
  shipment_index: number;
  service_type: ServiceType;
  city_ref: string;
  city_name: string | null;
  warehouse_ref: string | null;
  warehouse_name: string | null;
  address: string | null;
  cod_amount: number;
  items: ShipmentPlanItemInput[];
  parcels: ShipmentPlanParcelInput[];
}

export interface ShipmentPlanPayload {
  shipments: ShipmentPlanInput[];
}

export type ParseResult =
  | { ok: true; plan: ShipmentPlanPayload }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finite integer or a numeric string representing one; null otherwise. */
function toInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isInteger(n) ? n : null;
}

function toFinite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function strOrNull(value: unknown, maxLength: number): string | null | undefined {
  // undefined = field absent (caller decides whether that is an error)
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > maxLength ? undefined : trimmed.slice(0, maxLength);
}

export function parseShipmentPlanPayload(body: unknown): ParseResult {
  if (!isRecord(body) || !Array.isArray(body.shipments)) {
    return { ok: false, error: 'Некоректний план відправлень' };
  }
  if (body.shipments.length > MAX_SHIPMENTS) {
    return { ok: false, error: `Забагато відправлень (максимум ${MAX_SHIPMENTS})` };
  }

  const shipments: ShipmentPlanInput[] = [];
  for (let s = 0; s < body.shipments.length; s++) {
    const parsed = parseShipment(body.shipments[s], s);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    shipments.push(parsed);
  }

  // shipment_index must be 1..n without gaps or duplicates.
  const indexes = shipments.map((sh) => sh.shipment_index);
  for (let i = 0; i < indexes.length; i++) {
    if (indexes[i] !== i + 1) {
      return {
        ok: false,
        error: 'Номери відправлень мають бути послідовними: 1, 2, 3…',
      };
    }
  }

  return { ok: true, plan: { shipments } };
}

function parseShipment(raw: unknown, position: number): ShipmentPlanInput | string {
  const label = `Відправлення ${position + 1}`;
  if (!isRecord(raw)) return `${label}: некоректна структура`;

  const shipmentIndex = toInt(raw.shipment_index);
  if (shipmentIndex === null || shipmentIndex < 1) {
    return `${label}: некоректний номер відправлення`;
  }

  if (typeof raw.service_type !== 'string' || !SERVICE_TYPES.includes(raw.service_type as ServiceType)) {
    return `${label}: невідомий тип доставки`;
  }
  const serviceType = raw.service_type as ServiceType;

  const cityRef = strOrNull(raw.city_ref, 64);
  if (!cityRef) return `${label}: оберіть місто доставки`;

  const cityName = strOrNull(raw.city_name, 200) ?? null;
  const warehouseRef = strOrNull(raw.warehouse_ref, 64) ?? null;
  const warehouseName = strOrNull(raw.warehouse_name, 200) ?? null;
  const address = strOrNull(raw.address, 300) ?? null;

  // Destination XOR (mirrors chk_order_shipments_destination).
  if (serviceType === 'nova_poshta_warehouse') {
    if (!warehouseRef) return `${label}: оберіть відділення`;
    if (address) return `${label}: відділення не може мати адресу кур'єрської доставки`;
  } else {
    if (!address) return `${label}: вкажіть адресу доставки кур'єром`;
    if (warehouseRef) return `${label}: кур'єрська доставка не може мати відділення`;
  }

  const codAmount = toFinite(raw.cod_amount);
  if (codAmount === null || codAmount < 0) {
    return `${label}: некоректна сума наложеного платежу`;
  }

  if (!Array.isArray(raw.items)) return `${label}: некоректний список товарів`;
  if (raw.items.length === 0) return `${label}: додайте хоча б один товар`;
  if (raw.items.length > 500) return `${label}: забагато товарів у відправленні`;

  const items: ShipmentPlanItemInput[] = [];
  const seenItems = new Set<string>();
  for (const rawItem of raw.items) {
    if (!isRecord(rawItem)) return `${label}: некоректний товар`;
    const itemId = typeof rawItem.order_item_id === 'string' ? rawItem.order_item_id.trim() : '';
    if (!UUID_RE.test(itemId)) return `${label}: некоректний ідентифікатор товару`;
    if (seenItems.has(itemId)) return `${label}: товар зустрічається двічі`;
    seenItems.add(itemId);
    const quantity = toInt(rawItem.quantity);
    if (quantity === null || quantity < 1) return `${label}: некоректна кількість товару`;
    items.push({ order_item_id: itemId, quantity });
  }

  if (!Array.isArray(raw.parcels)) return `${label}: некоректний список місць`;
  if (raw.parcels.length > MAX_PARCELS_PER_SHIPMENT) {
    return `${label}: забагато місць (максимум ${MAX_PARCELS_PER_SHIPMENT})`;
  }

  const parcels: ShipmentPlanParcelInput[] = [];
  for (let p = 0; p < raw.parcels.length; p++) {
    const parsed = parseParcel(raw.parcels[p], `${label}, місце ${p + 1}`);
    if (typeof parsed === 'string') return parsed;
    parcels.push(parsed);
  }
  for (let p = 0; p < parcels.length; p++) {
    if (parcels[p].parcel_index !== p + 1) {
      return `${label}: номери місць мають бути послідовними: 1, 2, 3…`;
    }
  }

  return {
    shipment_index: shipmentIndex,
    service_type: serviceType,
    city_ref: cityRef,
    city_name: cityName,
    warehouse_ref: warehouseRef,
    warehouse_name: warehouseName,
    address,
    cod_amount: codAmount,
    items,
    parcels,
  };
}

function parseParcel(raw: unknown, label: string): ShipmentPlanParcelInput | string {
  if (!isRecord(raw)) return `${label}: некоректна структура місця`;

  const parcelIndex = toInt(raw.parcel_index);
  if (parcelIndex === null || parcelIndex < 1) return `${label}: некоректний номер місця`;

  if (
    typeof raw.cargo_category !== 'string' ||
    !CARGO_CATEGORIES.includes(raw.cargo_category as CargoCategory)
  ) {
    return `${label}: невідома категорія вантажу`;
  }

  // Live API rule: actualWeight in grams, rounded to the nearest 10 g.
  const weight = toInt(raw.actual_weight_grams);
  if (weight === null || weight <= 0 || weight % 10 !== 0) {
    return `${label}: вага має бути додатною та кратною 10 г`;
  }

  const dims: [string, unknown][] = [
    ['ширина', raw.width_mm],
    ['довжина', raw.length_mm],
    ['висота', raw.height_mm],
  ];
  for (const [name, value] of dims) {
    const dim = toInt(value);
    if (dim === null || dim <= 0) return `${label}: некоректна ${name} (мм)`;
  }

  const insurance = toFinite(raw.insurance_cost);
  if (insurance === null || insurance <= 0) {
    return `${label}: страхова сума має бути більша за 0`;
  }

  // description is optional: absent/null → NULL, non-string → invalid.
  let description: string | null = null;
  if (raw.description !== undefined && raw.description !== null) {
    const d = strOrNull(raw.description, 500);
    if (d === undefined) return `${label}: некоректний опис місця`;
    description = d;
  }

  return {
    parcel_index: parcelIndex,
    cargo_category: raw.cargo_category as CargoCategory,
    actual_weight_grams: weight,
    width_mm: toInt(raw.width_mm) as number,
    length_mm: toInt(raw.length_mm) as number,
    height_mm: toInt(raw.height_mm) as number,
    insurance_cost: insurance,
    description,
  };
}
