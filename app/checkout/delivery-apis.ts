// Shared checkout delivery types + module-scope dictionary loaders.
// Mechanical split from CheckoutForm.tsx (2026-09-13) — no behavior change:
// the code below is moved verbatim so CheckoutForm stays the orchestrator.

export type DeliveryType =
  | 'nova_poshta_warehouse'
  | 'nova_poshta_locker'
  | 'nova_poshta_courier'
  | 'ukrposhta_warehouse'
  | 'pickup';

// Two-step delivery choice (2026-09 redesign of the flat 4-card grid):
// first a carrier block («Нова Пошта» / «Укрпошта»), then — revealed under
// the chosen block — a row of that carrier's service types. The final
// submitted value is still one of the DeliveryType service_types
// (sanitizeDelivery contract unchanged). «Самовивіз» is a pseudo-carrier
// with a single service type: no carrier dictionaries, just a point pick.
export type Carrier = 'nova_poshta' | 'ukrposhta' | 'pickup';

// Pickup payment intents (pickup only — carrier orders stay online-only
// LiqPay after checkout). Server whitelist: PICKUP_PAYMENT_INTENTS.
export type PickupPaymentIntent = 'online' | 'cash_on_pickup';

export interface NpSettlement {
  id: number;
  name: string;
  regionName: string | null;
  regionParentName: string | null;
}

export interface NpDivision {
  id: number;
  name: string;
  shortName: string | null;
  address: string | null;
  number: string | null;
  category: string | null;
}

export interface NpStreet {
  id: number;
  name: string;
  settlementId: number;
}

// --- Ukrposhta Address Classifier shapes (/api/delivery/ukrposhta/*) ---
export interface UpUaSettlement {
  id: number;
  name: string;
  shortType: string | null;
  districtName: string | null;
  regionName: string | null;
  katottg: string | null;
  koatuu: string | null;
}

export interface UpUaOffice {
  id: number;
  shortName: string | null;
  longName: string | null;
  postIndex: string | null;
  address: string | null;
  phone: string | null;
  typeAcronym: string | null;
}

// Only these two Nova Post types load NP divisions; the Ukrposhta branch
// uses its own settlement/office state against the /ukrposhta/* routes.
export const isNpWarehouseType = (t: DeliveryType): boolean =>
  t === 'nova_poshta_warehouse' || t === 'nova_poshta_locker';

// Module-scope loaders (project react-hooks pattern): state updates happen
// inside async callbacks, never synchronously in an effect body.

// Phone normalizers live in app/lib/phone.ts (shared with regression tests).
export async function searchSettlementsApi(
  q: string,
  onData: (items: NpSettlement[]) => void,
  onError: () => void
) {
  try {
    const res = await fetch(
      `/api/delivery/novapost/settlements?q=${encodeURIComponent(q)}`,
      // A hung dictionary fetch must not spin "Шукаємо…" forever — 12 s
      // matches the cart-preview PREVIEW_TIMEOUT_MS convention.
      { signal: AbortSignal.timeout(12_000) }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('search failed');
    onData((data?.items as NpSettlement[]) ?? []);
  } catch {
    onError();
  }
}

export async function fetchDivisionsApi(
  settlementId: number,
  onData: (items: NpDivision[]) => void,
  onError: () => void
) {
  try {
    const res = await fetch(
      `/api/delivery/novapost/divisions?settlementId=${settlementId}`,
      { signal: AbortSignal.timeout(12_000) }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('divisions failed');
    onData((data?.items as NpDivision[]) ?? []);
  } catch {
    onError();
  }
}

export async function searchStreetsApi(
  settlementId: number,
  name: string,
  onData: (items: NpStreet[]) => void,
  onError: () => void
) {
  try {
    const res = await fetch(
      `/api/delivery/novapost/streets?settlementId=${settlementId}&name=${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(12_000) }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('streets failed');
    onData((data?.items as NpStreet[]) ?? []);
  } catch {
    onError();
  }
}

// Same loader pattern for the Ukrposhta branch: server-side proxy against
// the open Address Classifier; integer CITY_ID / office ID from a list
// click are the only valid choices (free text is never a chosen value).
export async function searchUkrposhtaSettlementsApi(
  q: string,
  onData: (items: UpUaSettlement[]) => void,
  onError: () => void
) {
  try {
    const res = await fetch(
      `/api/delivery/ukrposhta/settlements?q=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(12_000) }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('search failed');
    onData((data?.items as UpUaSettlement[]) ?? []);
  } catch {
    onError();
  }
}

export async function fetchUkrposhtaOfficesApi(
  cityId: number,
  onData: (items: UpUaOffice[]) => void,
  onError: () => void
) {
  try {
    const res = await fetch(
      `/api/delivery/ukrposhta/offices?cityId=${cityId}`,
      { signal: AbortSignal.timeout(12_000) }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('offices failed');
    onData((data?.items as UpUaOffice[]) ?? []);
  } catch {
    onError();
  }
}
