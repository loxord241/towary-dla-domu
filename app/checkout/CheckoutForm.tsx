'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useCart } from '@/app/lib/cart-context';
import {
  fetchCartPreview,
  type CartPreviewLine,
} from '@/app/lib/cart-preview';
import { normalizeUaPhoneDigits, toE164Ua } from '@/app/lib/phone';
import { formatPrice } from '@/app/lib/format';
import { PICKUP_POINTS } from '@/app/lib/checkout-delivery';
import { ANALYTICS_EVENTS } from '@/app/lib/analytics';
import { track } from '@vercel/analytics';

interface SubmitResult {
  orderNumber: string;
  total?: number;
  currency?: string;
  accessToken: string;
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
  category: string | null;
}

interface NpStreet {
  id: number;
  name: string;
  settlementId: number;
}

// --- Ukrposhta Address Classifier shapes (/api/delivery/ukrposhta/*) ---
interface UpUaSettlement {
  id: number;
  name: string;
  shortType: string | null;
  districtName: string | null;
  regionName: string | null;
  katottg: string | null;
  koatuu: string | null;
}

interface UpUaOffice {
  id: number;
  shortName: string | null;
  longName: string | null;
  postIndex: string | null;
  address: string | null;
  phone: string | null;
  typeAcronym: string | null;
}

type DeliveryType =
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
type Carrier = 'nova_poshta' | 'ukrposhta' | 'pickup';

const CARRIERS: { value: Carrier; label: string }[] = [
  { value: 'nova_poshta', label: 'Нова Пошта' },
  { value: 'ukrposhta', label: 'Укрпошта' },
  { value: 'pickup', label: 'Самовивіз, Кривий Ріг' },
];

// The ONLY place the carrier → service_type mapping lives. Keep in sync
// with SERVICE_TYPES in app/lib/checkout-delivery.ts (Ukrposhta exposes
// office delivery only — deliberately no courier branch).
const CARRIER_SERVICE_TYPES: Record<
  Carrier,
  { value: DeliveryType; label: string }[]
> = {
  nova_poshta: [
    { value: 'nova_poshta_warehouse', label: 'Відділення' },
    { value: 'nova_poshta_locker', label: 'Поштомат' },
    { value: 'nova_poshta_courier', label: 'Кур’єр' },
  ],
  ukrposhta: [{ value: 'ukrposhta_warehouse', label: 'Відділення' }],
  pickup: [{ value: 'pickup', label: 'Заберу сам' }],
};

// Pickup payment intents (pickup only — carrier orders stay online-only
// LiqPay after checkout). Server whitelist: PICKUP_PAYMENT_INTENTS.
type PickupPaymentIntent = 'online' | 'cash_on_pickup';

// Only these two Nova Post types load NP divisions; the Ukrposhta branch
// uses its own settlement/office state against the /ukrposhta/* routes.
const isNpWarehouseType = (t: DeliveryType): boolean =>
  t === 'nova_poshta_warehouse' || t === 'nova_poshta_locker';

// The live /divisions divisionCategory value for parcel lockers is
// "Postomat" (live-verified 2026-08-28); branches are PostBranch /
// CargoBranch. Match case-insensitively as a safety net.
const isLockerCategory = (category: string | null): boolean =>
  typeof category === 'string' && /postomat/i.test(category);

// Module-scope loaders (project react-hooks pattern): state updates happen
// inside async callbacks, never synchronously in an effect body.

// Phone normalizers live in app/lib/phone.ts (shared with regression tests).
async function searchSettlementsApi(
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

async function fetchDivisionsApi(
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

async function searchStreetsApi(
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
async function searchUkrposhtaSettlementsApi(
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

async function fetchUkrposhtaOfficesApi(
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

export default function CheckoutForm() {
  const router = useRouter();
  const { items, hydrated, clearCart, removeItem } = useCart();

  // Structured ПІБ; the composed full name is also sent as `name` so the
  // request stays valid against the legacy server contract.
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [patronymic, setPatronymic] = useState('');
  const [email, setEmail] = useState('');
  // National significant digits only (9 after +380); the prefix is rendered
  // as a fixed part of the field and never typed by the user.
  const [phoneDigits, setPhoneDigits] = useState('');
  const [notes, setNotes] = useState('');

  // --- Nova Post delivery choice (stage 2G) ---
  // Step 1: the expanded carrier block ('' = none expanded). Step 2:
  // deliveryType — the final service_type sent in shipping.delivery.
  const [carrier, setCarrier] = useState<Carrier | ''>('');
  const [deliveryType, setDeliveryType] = useState<DeliveryType | ''>('');
  const [settlement, setSettlement] = useState<NpSettlement | null>(null);
  const [settlementQuery, setSettlementQuery] = useState('');
  const [settlementResults, setSettlementResults] = useState<NpSettlement[]>([]);
  const [settlementOpen, setSettlementOpen] = useState(false);
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [divisions, setDivisions] = useState<NpDivision[]>([]);
  // Distinct from "loaded and empty": the «Немає доступних варіантів» branch
  // is honest ONLY after a fetch has finished.
  const [divisionsLoading, setDivisionsLoading] = useState(false);
  const [division, setDivision] = useState<NpDivision | null>(null);
  const [street, setStreet] = useState<NpStreet | null>(null);
  const [streetQuery, setStreetQuery] = useState('');
  const [streetResults, setStreetResults] = useState<NpStreet[]>([]);
  const [streetOpen, setStreetOpen] = useState(false);
  const [building, setBuilding] = useState('');
  const [flat, setFlat] = useState('');
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  // --- Самовивіз (Кривий Ріг) — no dictionaries, just point + payment ---
  const [pickupPointId, setPickupPointId] = useState('');
  const [paymentIntent, setPaymentIntent] = useState<PickupPaymentIntent>('online');
  // Separate debouncers: a shared ref let typing in one field cancel the
  // other field's in-flight debounce timer.
  const settlementDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streetDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sequence guard: each settlement search bumps the counter; a response
  // from an OUTDATED request (slow network, out-of-order arrival) is
  // dropped instead of overwriting fresher results — otherwise the
  // dropdown can vanish or show another query's list mid-typing.
  const settlementRequestSeq = useRef(0);
  // Same guard pattern for the divisions and streets lookups: an out-of-order
  // response (slow network) must not repopulate a list for a settlement the
  // user has already changed — otherwise the order can end up with a
  // division/street from a different city.
  const divisionsRequestSeq = useRef(0);
  const streetRequestSeq = useRef(0);

  // --- Ukrposhta delivery choice — mirrors the NP state machinery ---
  // Separate state (not shared with NP): the providers have different
  // dictionary shapes and endpoints, and a switch of delivery type must
  // never let an NP settlement/division ride along in an UP order (or
  // vice versa).
  const [upSettlement, setUpSettlement] = useState<UpUaSettlement | null>(null);
  const [upSettlementQuery, setUpSettlementQuery] = useState('');
  const [upSettlementResults, setUpSettlementResults] = useState<UpUaSettlement[]>([]);
  const [upSettlementOpen, setUpSettlementOpen] = useState(false);
  const [upSettlementLoading, setUpSettlementLoading] = useState(false);
  const [upOffices, setUpOffices] = useState<UpUaOffice[]>([]);
  // "Loaded and empty" is distinct from "loading" — the honest «Немає
  // доступних варіантів» branch renders only after a finished fetch.
  const [upOfficesLoading, setUpOfficesLoading] = useState(false);
  const [upOffice, setUpOffice] = useState<UpUaOffice | null>(null);
  const upSettlementDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upSettlementRequestSeq = useRef(0);
  const upOfficesRequestSeq = useRef(0);

  // Drop pending debounce timers when the form unmounts.
  useEffect(() => {
    return () => {
      if (settlementDebounceRef.current) clearTimeout(settlementDebounceRef.current);
      if (streetDebounceRef.current) clearTimeout(streetDebounceRef.current);
      if (upSettlementDebounceRef.current) clearTimeout(upSettlementDebounceRef.current);
    };
  }, []);

  // Anonymous checkout-funnel analytics: fires once when the checkout
  // form mounts. No payload — nothing about the cart or the visitor.
  useEffect(() => {
    track(ANALYTICS_EVENTS.CHECKOUT_START);
  }, []);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // F2 idempotency: one key per checkout attempt-session. Generated on the
  // FIRST submit and reused on every retry (double-click, timeout-then-
  // resubmit), so the server deduplicates at the DB level — the same
  // logical request can never create two orders.
  const idempotencyKeyRef = useRef<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    firstName?: string;
    lastName?: string;
    patronymic?: string;
    email?: string;
    phone?: string;
  }>({});
  const [lines, setLines] = useState<CartPreviewLine[]>([]);
  // True when the cart-preview fetch failed: the summary must not present a
  // silent 0.00 as if it were the real total (the server stays the pricing
  // authority — submit is NOT blocked, the user is just warned).
  const [previewError, setPreviewError] = useState(false);

  // Домен кошика для самовивоза (власник 2026-09-12): шпалери (slug wc-*)
  // видаються на Серафимовича 83А, техніка — на Мазепи 87А; змішаний кошик
  // пропонує ОБИДВІ точки з попередженням. Поки превʼю не завантажено —
  // безпечний дефолт: обидві.
  const cartHasWallpapers = lines.some((l) => l.slug?.startsWith('wc-') === true);
  // Всё, что не шпалеры (включая позиции без slug) — техника: точка Мазепы.
  const cartHasTech = lines.some((l) => l.slug?.startsWith('wc-') !== true);
  const availablePickupPoints = PICKUP_POINTS.filter((p) =>
    lines.length === 0
      ? true
      : p.domains.includes('wallpaper')
        ? cartHasWallpapers
        : cartHasTech
  );

  // Server-side prices for the summary panel (display only — place_order
  // remains the final pricing authority). Time-bounded fetch; a stalled
  // request can never block the form — summary just stays empty.
  useEffect(() => {
    if (!hydrated || items.length === 0) return;
    let cancelled = false;
    const dispose = fetchCartPreview(
      items.map((i) => ({ productId: i.productId, variantId: i.variantId })),
      {
        onData: (data) => {
          if (cancelled) return;
          setLines(data);
          setPreviewError(false);
        },
        onError: () => {
          if (!cancelled) setPreviewError(true);
        },
        onDone: () => {},
      }
    );
    return () => {
      cancelled = true;
      dispose();
    };
  }, [hydrated, items]);

  const lineFor = (productId: string, variantId: string | null) =>
    lines.find(
      (l) => l.productId === productId && (l.variantId ?? null) === variantId
    );
  const itemRows = items.map((item) => ({
    item,
    preview: lineFor(item.productId, item.variantId),
  }));
  const purchasable = itemRows.filter(
    ({ preview }) =>
      preview?.found &&
      preview.unitPrice !== null &&
      preview.availabilityStatus !== 'out_of_stock'
  );
  // Same unavailable rule as the cart page: !found || no price || out_of_stock.
  // A MISSING preview (fetch failed / still loading) is unknown, never
  // unavailable — a failed cart-preview must not block submit (the manager
  // confirms the total). Displayed with a remove control instead of being
  // silently hidden; the server-side 422 stays as defence in depth.
  const unavailableItems = itemRows.filter(
    ({ preview }) =>
      preview !== undefined &&
      (!preview.found ||
        preview.unitPrice === null ||
        preview.availabilityStatus === 'out_of_stock')
  );
  // Subtotals are grouped per currency: summing UAH and USD into one
  // number and signing it with the first row's currency is meaningless.
  // Single-currency carts keep the exact pre-existing display shape.
  const subtotalByCurrency = new Map<string, number>();
  for (const { item, preview } of purchasable) {
    const cur = preview?.currency ?? '';
    subtotalByCurrency.set(
      cur,
      (subtotalByCurrency.get(cur) ?? 0) + (preview?.unitPrice ?? 0) * item.quantity
    );
  }
  const currency = purchasable[0]?.preview?.currency ?? '';

  if (hydrated && items.length === 0) {
    return (
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-md mx-auto bg-white rounded-lg shadow p-8 text-center">
          <h1 className="text-xl font-bold mb-2">Кошик порожній</h1>
          <p className="text-gray-500 mb-6">
            Додайте товари до кошика, щоб оформити замовлення.
          </p>
          <Link
            href="/catalog"
            className="inline-block px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition"
          >
            До каталогу
          </Link>
        </div>
      </div>
    );
  }

  const divisionsForType =
    deliveryType === 'nova_poshta_locker'
      ? divisions.filter((d) => isLockerCategory(d.category))
      : deliveryType === 'nova_poshta_warehouse'
        ? divisions.filter((d) => !isLockerCategory(d.category))
        : [];

  /** Drops every pending/selected Ukrposhta choice (stale guards bumped). */
  const resetUkrposhtaState = () => {
    setUpSettlement(null);
    setUpSettlementQuery('');
    setUpSettlementResults([]);
    setUpSettlementOpen(false);
    setUpSettlementLoading(false);
    setUpOffices([]);
    setUpOfficesLoading(false);
    setUpOffice(null);
    upSettlementRequestSeq.current += 1;
    upOfficesRequestSeq.current += 1;
    if (upSettlementDebounceRef.current) clearTimeout(upSettlementDebounceRef.current);
  };

  /** Loads Ukrposhta offices for the chosen city (stale-response guarded). */
  const loadUkrposhtaOffices = (cityId: number) => {
    upOfficesRequestSeq.current += 1;
    const seq = upOfficesRequestSeq.current;
    setUpOfficesLoading(true);
    fetchUkrposhtaOfficesApi(
      cityId,
      (items) => {
        if (seq !== upOfficesRequestSeq.current) return; // stale response
        setUpOffices(items);
        setUpOfficesLoading(false);
      },
      () => {
        if (seq !== upOfficesRequestSeq.current) return;
        setUpOffices([]);
        setUpOfficesLoading(false);
      }
    );
  };

  /**
   * Drops the service type plus every division/street/address choice of
   * BOTH carriers (dictionaries never mix). The NP settlement survives:
   * it belongs to the carrier, and switching service types inside Nova
   * Post (Відділення → Кур’єр) should keep the picked city — exactly the
   * behavior the old flat radio grid had.
   */
  const resetServiceChoice = () => {
    setDeliveryType('');
    setDivision(null);
    setStreet(null);
    setStreetQuery('');
    setStreetResults([]);
    setStreetOpen(false);
    setBuilding('');
    setFlat('');
    setDivisions([]);
    setDivisionsLoading(false);
    // Drop in-flight divisions/streets responses for the discarded type.
    divisionsRequestSeq.current += 1;
    streetRequestSeq.current += 1;
    // The carriers never share dictionary state: an NP settlement/division
    // must never ride along in an UP order (and vice versa).
    resetUkrposhtaState();
    setDeliveryError(null);
  };

  /**
   * Carrier-level reset: on top of resetServiceChoice() it also drops the
   * NP city search state, so switching (or collapsing) a carrier can never
   * leak the previous carrier's settlement/office/address into a new one.
   */
  const resetCarrierChoice = () => {
    resetServiceChoice();
    settlementRequestSeq.current += 1;
    if (settlementDebounceRef.current) clearTimeout(settlementDebounceRef.current);
    setSettlement(null);
    setSettlementQuery('');
    setSettlementResults([]);
    setSettlementOpen(false);
    setSettlementLoading(false);
  };

  /** Expands a carrier block; a second click on it collapses the row. */
  const toggleCarrier = (next: Carrier) => {
    // A carrier switch (and a collapse too) must discard the previous
    // carrier's city/office/address state — never mix NP + UP choices.
    resetCarrierChoice();
    setCarrier(carrier === next ? '' : next);
  };

  /** Picks the final service type under the expanded carrier. */
  const applyServiceType = (t: DeliveryType) => {
    resetServiceChoice();
    setDeliveryType(t);
    // Warehouse-ish NP types need the division list for the picked city
    // (the courier branch uses streets instead; UP has its own loaders).
    if (settlement && isNpWarehouseType(t)) {
      const seq = divisionsRequestSeq.current;
      setDivisionsLoading(true);
      fetchDivisionsApi(
        settlement.id,
        (items) => {
          if (seq !== divisionsRequestSeq.current) return; // stale response
          setDivisions(items);
          setDivisionsLoading(false);
        },
        () => {
          if (seq !== divisionsRequestSeq.current) return;
          setDivisions([]);
          setDivisionsLoading(false);
        }
      );
    }
  };

  /** Strict delivery object for shipping_info.delivery; null when incomplete. */
  const deliveryObject = (): Record<string, unknown> | null => {
    // Pickup branch first: no carrier fields at all (server rejects them).
    if (deliveryType === 'pickup') {
      const point = availablePickupPoints.find((p) => p.id === pickupPointId);
      if (!point) return null;
      return {
        serviceType: 'pickup',
        settlementName: point.city,
        pickupPointId: point.id,
        // Server re-derives the display address from PICKUP_POINTS —
        // the client value is informational only.
        pickupPointName: `${point.city}, ${point.address}`,
        paymentIntent,
      };
    }
    // Ukrposhta branch: the NP gate below must not consume UP types.
    if (deliveryType === 'ukrposhta_warehouse') {
      if (!upSettlement || !upOffice) return null;
      const tail = [upOffice.postIndex, upOffice.address]
        .filter(Boolean)
        .join(', ');
      return {
        serviceType: deliveryType,
        settlementId: upSettlement.id,
        settlementName: upSettlement.name,
        divisionId: upOffice.id,
        divisionName:
          [upOffice.shortName ?? upOffice.longName, tail]
            .filter(Boolean)
            .join(', ') || upOffice.shortName || upOffice.longName || '',
      };
    }
    if (!deliveryType || !settlement) return null;
    if (deliveryType === 'nova_poshta_courier') {
      if (!street || building.trim().length === 0) return null;
      return {
        serviceType: deliveryType,
        settlementId: settlement.id,
        settlementName: settlement.name,
        ...(street ? { streetId: street.id } : {}),
        streetName: street.name,
        building: building.trim(),
        ...(flat.trim() ? { flat: flat.trim() } : {}),
      };
    }
    if (!division) return null;
    return {
      serviceType: deliveryType,
      settlementId: settlement.id,
      settlementName: settlement.name,
      divisionId: division.id,
      divisionName:
        [division.name, division.address].filter(Boolean).join(', ') ||
        division.name,
    };
  };

  const displayAddress = (): string => {
    if (deliveryType === 'pickup') {
      const point = availablePickupPoints.find((p) => p.id === pickupPointId);
      return point ? `${point.city}, ${point.address}` : '';
    }
    if (deliveryType === 'ukrposhta_warehouse') {
      if (!upSettlement || !upOffice) return '';
      const tail = [upOffice.postIndex, upOffice.address].filter(Boolean).join(', ');
      return (
        [upOffice.shortName ?? upOffice.longName, tail].filter(Boolean).join(', ') ||
        upSettlement.name
      );
    }
    if (!deliveryType || !settlement) return '';
    if (deliveryType === 'nova_poshta_courier') {
      if (!street || !building.trim()) return '';
      return `${street.name}, ${building.trim()}${flat.trim() ? `, кв. ${flat.trim()}` : ''}`;
    }
    if (!division) return '';
    return [division.name, division.address].filter(Boolean).join(', ');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Client-side pass for instant feedback; the server re-validates.
    const errs: {
      firstName?: string;
      lastName?: string;
      patronymic?: string;
      email?: string;
      phone?: string;
    } = {};
    const firstTrimmed = firstName.trim();
    const lastTrimmed = lastName.trim();
    const patronymicTrimmed = patronymic.trim();
    if (firstTrimmed.length === 0) errs.firstName = 'Вкажіть ім’я';
    else if (firstTrimmed.length > 120) errs.firstName = 'Максимум 120 символів';
    if (lastTrimmed.length === 0) errs.lastName = 'Вкажіть прізвище';
    else if (lastTrimmed.length > 120) errs.lastName = 'Максимум 120 символів';
    if (patronymicTrimmed.length > 120) errs.patronymic = 'Максимум 120 символів';
    // Composed ПІБ keeps the legacy single-string `name` contract alive;
    // structured parts travel alongside for customer_info.
    const name = [lastTrimmed, firstTrimmed, patronymicTrimmed]
      .filter((part) => part !== '')
      .join(' ');
    // The server caps the COMPOSED name at 120 — per-field limits alone let
    // a valid form die on a misleading 400, so check the joined length here.
    if (name.length > 120) {
      errs.lastName = 'Прізвище, ім’я та по батькові разом — до 120 символів';
    }
    const emailTrimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailTrimmed))
      errs.email = 'Вкажіть коректний email';
    if (phoneDigits.length > 0 && phoneDigits.length < 9)
      errs.phone = 'Вкажіть повний номер після +380';
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    const phone = toE164Ua(phoneDigits);

    const delivery = deliveryObject();
    if (!delivery) {
      setDeliveryError(
        !deliveryType
          ? carrier
            ? 'Оберіть тип доставки'
            : 'Оберіть спосіб доставки'
          : deliveryType === 'pickup'
            ? 'Оберіть точку самовивоза'
            : deliveryType === 'nova_poshta_courier'
              ? 'Оберіть місто та вулицю і вкажіть будинок'
              : 'Оберіть відділення/поштомат'
      );
      return;
    }
    setDeliveryError(null);

    // F1 guard: never POST while an unavailable line is in the cart — the
    // server would 422 and the user had no way to fix it here. Removing the
    // line re-enables submit (the summary block below offers the control).
    if (unavailableItems.length > 0) {
      setError(
        'У кошику є недоступні товари. Видаліть недоступні товари, щоб оформити замовлення.'
      );
      return;
    }

    setSubmitting(true);

    try {
      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = crypto.randomUUID();
      }
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKeyRef.current,
        },
        // A hung socket would otherwise disable the form forever
        // (submitting stays true); the idempotency key makes the retry safe.
        signal: AbortSignal.timeout(20_000),
        // ONLY identifiers + quantities + contact/shipping strings. The
        // structured delivery object carries Nova Post ids only — money and
        // payer fields are structurally impossible in this contract.
        body: JSON.stringify({
          contact: {
            name,
            firstName: firstTrimmed,
            lastName: lastTrimmed,
            patronymic: patronymicTrimmed,
            // The trimmed value is what was validated — send what was checked.
            email: emailTrimmed,
            phone,
          },
          shipping: {
            // Аудит P2: у Ukrposhta-заказов NP-settlement всегда null —
            // город берём из UP-ветки, иначе шло пустое ''.
            city:
              deliveryType === 'pickup'
                ? 'Кривий Ріг'
                : deliveryType === 'ukrposhta_warehouse'
                  ? upSettlement?.name ?? ''
                  : settlement?.name ?? '',
            address: displayAddress(),
            notes,
            delivery,
          },
          items: items.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            quantity: i.quantity,
          })),
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | (SubmitResult & { error?: string })
        | null;

      if (!response.ok || !data?.orderNumber) {
        throw new Error(data?.error || 'Не вдалося оформити замовлення');
      }

      clearCart();
      router.replace(
        `/checkout/success?order=${encodeURIComponent(data.orderNumber)}&t=${data.accessToken}`
      );
    } catch (err) {
      // Browser/DOMException messages ("signal timed out", crypto failures
      // on insecure contexts) mean nothing to a shopper — map them to an
      // actionable message; the idempotency key makes a retry safe.
      if (err instanceof Error && err.name === 'TimeoutError') {
        setError('Сервер не відповів вчасно. Спробуйте ще раз.');
      } else if (err instanceof TypeError && /randomUUID|crypto/.test(err.message)) {
        setError('Помилка сесії. Оновіть сторінку та спробуйте ще раз.');
      } else {
        setError(err instanceof Error ? err.message : 'Помилка оформлення');
      }
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full border border-gray-300 rounded-md p-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent';

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold tracking-tight text-gray-900">
        Оформлення замовлення
      </h1>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <form onSubmit={submit} className="card w-full p-6 lg:max-w-xl">
        {error && (
          <div className="mb-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded" role="alert">
            {error}
          </div>
        )}

        <fieldset disabled={submitting} className="space-y-5">
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              1. Контактні дані
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="co-first-name" className="label">
                  Ім’я *
                </label>
                <input
                  id="co-first-name"
                  type="text"
                  required
                  maxLength={120}
                  autoComplete="given-name"
                  autoCorrect="off"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                    if (fieldErrors.firstName)
                      setFieldErrors((prev) => ({ ...prev, firstName: undefined }));
                  }}
                  aria-invalid={Boolean(fieldErrors.firstName)}
                  aria-describedby={fieldErrors.firstName ? 'err-first-name' : undefined}
                  className={inputClass}
                />
                {fieldErrors.firstName && (
                  <p id="err-first-name" className="field-error">{fieldErrors.firstName}</p>
                )}
              </div>

              <div>
                <label htmlFor="co-last-name" className="label">
                  Прізвище *
                </label>
                <input
                  id="co-last-name"
                  type="text"
                  required
                  maxLength={120}
                  autoComplete="family-name"
                  autoCorrect="off"
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                    if (fieldErrors.lastName)
                      setFieldErrors((prev) => ({ ...prev, lastName: undefined }));
                  }}
                  aria-invalid={Boolean(fieldErrors.lastName)}
                  aria-describedby={fieldErrors.lastName ? 'err-last-name' : undefined}
                  className={inputClass}
                />
                {fieldErrors.lastName && (
                  <p id="err-last-name" className="field-error">{fieldErrors.lastName}</p>
                )}
              </div>

              <div>
                <label htmlFor="co-patronymic" className="label">
                  По батькові
                </label>
                <input
                  id="co-patronymic"
                  type="text"
                  maxLength={120}
                  autoComplete="additional-name"
                  autoCorrect="off"
                  value={patronymic}
                  onChange={(e) => {
                    setPatronymic(e.target.value);
                    if (fieldErrors.patronymic)
                      setFieldErrors((prev) => ({ ...prev, patronymic: undefined }));
                  }}
                  aria-invalid={Boolean(fieldErrors.patronymic)}
                  aria-describedby={fieldErrors.patronymic ? 'err-patronymic' : undefined}
                  className={inputClass}
                />
                {fieldErrors.patronymic && (
                  <p id="err-patronymic" className="field-error">{fieldErrors.patronymic}</p>
                )}
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="co-email" className="label">
              Email *
            </label>
            <input
              id="co-email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              autoCorrect="off"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (fieldErrors.email)
                  setFieldErrors((prev) => ({ ...prev, email: undefined }));
              }}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'err-email' : undefined}
              className={inputClass}
            />
            {fieldErrors.email && (
              <p id="err-email" className="field-error">{fieldErrors.email}</p>
            )}
          </div>

          <div>
            <label htmlFor="co-phone" className="label">
              Телефон
            </label>
            {/* Fixed +380 prefix: the user only ever types the 9 national
                digits. Paste/autofill of "+380971234567" / "0971234567" is
                normalized by normalizeUaPhoneDigits; the submitted value is
                E.164. No maxLength: it would truncate a pasted number BEFORE
                onChange and the normalizer would strip a partial "380"
                prefix, silently losing digits (paste regression fix). */}
            <div className="flex items-stretch w-full border border-gray-300 rounded-md overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent">
              <span
                aria-hidden="true"
                className="flex items-center px-3 bg-gray-100 text-gray-500 border-r border-gray-300 select-none"
              >
                +380
              </span>
              <input
                id="co-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                aria-label="Номер телефону після +380"
                placeholder="XX XXX XX XX"
                value={phoneDigits}
                onChange={(e) => {
                  setPhoneDigits(normalizeUaPhoneDigits(e.target.value));
                  if (fieldErrors.phone)
                    setFieldErrors((prev) => ({ ...prev, phone: undefined }));
                }}
                aria-invalid={Boolean(fieldErrors.phone)}
                aria-describedby={fieldErrors.phone ? 'err-phone' : undefined}
                className="min-w-0 flex-1 p-2 outline-none border-0 focus:ring-0"
              />
            </div>
            {fieldErrors.phone && (
              <p id="err-phone" className="field-error">{fieldErrors.phone}</p>
            )}
          </div>

          <div className="pt-2 border-t border-gray-100 mt-2">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              2. Доставка
            </p>

            {/* Two carrier blocks; the chosen one reveals its service-type
                buttons directly underneath. aria-pressed marks the visible
                selection, aria-expanded the disclosure. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 items-start gap-2 mb-4">
              {CARRIERS.map((c) => {
                const selected = carrier === c.value;
                return (
                  <div
                    key={c.value}
                    className={`rounded-lg border p-3 transition-colors motion-reduce:transition-none ${
                      selected
                        ? 'border-blue-600 ring-1 ring-blue-600'
                        : 'border-gray-300'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleCarrier(c.value)}
                      aria-pressed={selected}
                      aria-expanded={selected}
                      aria-controls={
                        selected ? `carrier-services-${c.value}` : undefined
                      }
                      className={`min-h-[44px] w-full rounded-md px-1 py-2.5 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                        selected ? 'text-blue-700' : 'text-gray-700'
                      }`}
                    >
                      <span className="flex items-center justify-between">
                        {c.label}
                        <span
                          aria-hidden="true"
                          className="text-xs text-gray-500"
                        >
                          {selected ? '▴' : '▾'}
                        </span>
                      </span>
                    </button>
                    {/* Service buttons render under the expanded carrier,
                        a step below its block. The disclosure animates with
                        the CSS grid-rows trick: the wrapper is always
                        mounted and its single row interpolates 0fr <-> 1fr.
                        `visibility` is transitioned too — per CSS
                        transitions it stays visible for the whole collapse
                        (flips to hidden at the end) and is visible from the
                        start on expand — so collapsed buttons leave the tab
                        order / a11y tree without JS measurement. */}
                    <div
                      id={`carrier-services-${c.value}`}
                      className={`grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none ${
                        selected
                          ? 'grid-rows-[1fr] visible'
                          : 'grid-rows-[0fr] invisible'
                      }`}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div className="mt-2 flex flex-wrap gap-2">
                          {CARRIER_SERVICE_TYPES[c.value].map((t) => (
                            <button
                              key={t.value}
                              type="button"
                              onClick={() => applyServiceType(t.value)}
                              aria-pressed={deliveryType === t.value}
                              className={`min-h-[44px] rounded-md border px-3 py-2 text-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                                deliveryType === t.value
                                  ? 'border-blue-600 bg-blue-50 font-medium text-blue-700'
                                  : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                              }`}
                            >
                              {t.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Самовивіз: точки під обраний домен кошика + спосіб оплати.
                Без довідників — статичний список PICKUP_POINTS; адресу
                точки сервер ще раз виводить канонічно. */}
            {deliveryType === 'pickup' && (
              <div className="mt-3 space-y-3">
                {cartHasWallpapers && cartHasTech && (
                  <p
                    className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                    role="note"
                  >
                    У кошику товари обох напрямків — усе замовлення буде
                    чекати на обраній точці.
                  </p>
                )}
                <div className="space-y-2">
                  {availablePickupPoints.map((p) => {
                    const selected = pickupPointId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPickupPointId(p.id)}
                        aria-pressed={selected}
                        className={`min-h-[44px] w-full rounded-md border px-3 py-2 text-left text-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                          selected
                            ? 'border-blue-600 bg-blue-50 font-medium text-blue-700'
                            : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                        }`}
                      >
                        <span className="block">{p.address}</span>
                        <span className="block text-xs text-gray-500">
                          {p.city} · безкоштовно ·{' '}
                          {p.domains.includes('wallpaper')
                            ? 'шпалери'
                            : 'техніка'}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-gray-700">
                    Оплата
                  </legend>
                  <div className="space-y-2">
                    <label className="flex min-h-[44px] items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm">
                      <input
                        type="radio"
                        name="pickup-payment"
                        value="online"
                        checked={paymentIntent === 'online'}
                        onChange={() => setPaymentIntent('online')}
                        className="h-4 w-4 text-blue-600"
                      />
                      Карткою онлайн (LiqPay) після оформлення
                    </label>
                    <label className="flex min-h-[44px] items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm">
                      <input
                        type="radio"
                        name="pickup-payment"
                        value="cash_on_pickup"
                        checked={paymentIntent === 'cash_on_pickup'}
                        onChange={() => setPaymentIntent('cash_on_pickup')}
                        className="h-4 w-4 text-blue-600"
                      />
                      Готівкою при отриманні на точці
                    </label>
                  </div>
                </fieldset>
              </div>
            )}

            {/* Settlement — NP dictionary id is the identifier; the text is display only.
                Rendered only once a Nova Post service type is chosen; the Ukrposhta
                branch has its own city field. Pickup has no dictionaries at all. */}
            {deliveryType !== '' &&
              deliveryType !== 'ukrposhta_warehouse' &&
              deliveryType !== 'pickup' && (
            <div className="relative mb-4">
              <label htmlFor="co-settlement" className="label">
                Населений пункт *
              </label>
              <input
                id="co-settlement"
                type="text"
                autoComplete="off"
                maxLength={100}
                placeholder="Почніть вводити назву міста…"
                value={
                  settlement && settlementQuery === settlement.name
                    ? settlement.name
                    : settlementQuery
                }
                onChange={(e) => {
                  const q = e.target.value;
                   setSettlementQuery(q);
                   setSettlement(null);
                   setDivision(null);
                   setDivisions([]);
                   setDivisionsLoading(false);
                   setStreet(null);
                  setStreetQuery('');
                  setStreetResults([]);
                  setSettlementOpen(true);
                  if (settlementDebounceRef.current) clearTimeout(settlementDebounceRef.current);
                  if (q.trim().length >= 2) {
                    setSettlementLoading(true);
                    const seq = ++settlementRequestSeq.current;
                    settlementDebounceRef.current = setTimeout(() => {
                      searchSettlementsApi(
                        q.trim(),
                        (found) => {
                          if (seq !== settlementRequestSeq.current) return; // stale response
                          setSettlementResults(found);
                          setSettlementOpen(true);
                          setSettlementLoading(false);
                        },
                        () => {
                          if (seq !== settlementRequestSeq.current) return; // stale response
                          setSettlementResults([]);
                          setSettlementLoading(false);
                        }
                      );
                    }, 300);
                  } else {
                    // Query invalidated (too short): bump the sequence so any
                    // in-flight response is dropped, and reset list state.
                    settlementRequestSeq.current += 1;
                    setSettlementLoading(false);
                    setSettlementResults([]);
                  }
                }}
                className={inputClass}
              />
              {/* Autocomplete states: results, loading, empty — free text is
                  never treated as a chosen settlement (id comes only from a
                  list click, so the submit gate stays strict). */}
              {settlementOpen && !settlement && settlementQuery.trim().length >= 2 && (
                settlementLoading ? (
                  <p className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg" role="status">
                    Шукаємо…
                  </p>
                ) : settlementResults.length > 0 ? (
                  <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                    {settlementResults.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50"
                          onClick={() => {
                            // Selection is final: drop any in-flight search
                            // response so it can't re-open the dropdown.
                            settlementRequestSeq.current += 1;
                            if (settlementDebounceRef.current) clearTimeout(settlementDebounceRef.current);
                            setSettlement(s);
                            setSettlementQuery(s.name);
                            setSettlementOpen(false);
                            setSettlementResults([]);
                            setSettlementLoading(false);
                            // Division/street belong to the chosen settlement:
                            // keep a previously picked division/street from the
                            // old settlement from riding along in the order.
                            setDivision(null);
                            setStreet(null);
                            setStreetQuery('');
                            setStreetResults([]);
                            setStreetOpen(false);
                            setBuilding('');
                            setFlat('');
                            divisionsRequestSeq.current += 1;
                            streetRequestSeq.current += 1;
                             if (deliveryType && isNpWarehouseType(deliveryType)) {
                               const seq = divisionsRequestSeq.current;
                               setDivisionsLoading(true);
                               fetchDivisionsApi(
                                 s.id,
                                 (items) => {
                                   if (seq !== divisionsRequestSeq.current) return; // stale response
                                   setDivisions(items);
                                   setDivisionsLoading(false);
                                 },
                                 () => {
                                   if (seq !== divisionsRequestSeq.current) return;
                                   setDivisions([]);
                                   setDivisionsLoading(false);
                                 }
                               );
                             }
                          }}
                        >
                          <span className="block">{s.name}</span>
                          {(s.regionName || s.regionParentName) && (
                            <span className="block text-xs text-gray-500">
                              {[s.regionParentName, s.regionName].filter(Boolean).join(', ')}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg">
                    Нічого не знайдено — спробуйте іншу назву
                  </p>
                )
              )}
            </div>
            )}

            {/* Branch / parcel locker */}
            {(deliveryType === 'nova_poshta_warehouse' ||
              deliveryType === 'nova_poshta_locker') && (
              <div className="mb-4">
                <label htmlFor="co-division" className="label">
                  {deliveryType === 'nova_poshta_locker' ? 'Поштомат *' : 'Відділення *'}
                </label>
                {settlement ? (
                  divisionsLoading ? (
                    <p className="text-sm text-gray-500" role="status">
                      Завантажуємо варіанти…
                    </p>
                  ) : divisionsForType.length > 0 ? (
                    <select
                      id="co-division"
                      value={division ? String(division.id) : ''}
                      onChange={(e) => {
                        const d = divisionsForType.find(
                          (x) => String(x.id) === e.target.value
                        );
                        setDivision(d ?? null);
                        setDeliveryError(null);
                      }}
                      className={inputClass}
                    >
                      <option value="">
                        — оберіть {deliveryType === 'nova_poshta_locker' ? 'поштомат' : 'відділення'} —
                      </option>
                      {divisionsForType.map((d) => (
                        <option key={d.id} value={String(d.id)}>
                          {d.name}
                          {d.address ? ` (${d.address})` : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-sm text-gray-500">
                      Немає доступних варіантів у цьому місті
                    </p>
                  )
                ) : (
                  <p className="text-sm text-gray-500">спочатку оберіть населений пункт</p>
                )}
              </div>
            )}

            {/* Courier address */}
            {deliveryType === 'nova_poshta_courier' && (
              <div className="space-y-4">
                <div className="relative">
                  <label htmlFor="co-street" className="label">
                    Вулиця *
                  </label>
                  <input
                    id="co-street"
                    type="text"
                    autoComplete="off"
                    maxLength={100}
                    disabled={!settlement}
                    placeholder={
                      settlement ? 'Почніть вводити назву вулиці…' : 'спочатку оберіть населений пункт'
                    }
                    value={street && streetQuery === street.name ? street.name : streetQuery}
                    onChange={(e) => {
                      const q = e.target.value;
                      setStreetQuery(q);
                      setStreet(null);
                      setStreetOpen(true);
                      if (streetDebounceRef.current) clearTimeout(streetDebounceRef.current);
                      if (settlement && q.trim().length >= 2) {
                        const seq = ++streetRequestSeq.current;
                        streetDebounceRef.current = setTimeout(() => {
                          if (seq !== streetRequestSeq.current) return; // superseded while debouncing
                          searchStreetsApi(
                            settlement.id,
                            q.trim(),
                            (found) => {
                              if (seq !== streetRequestSeq.current) return; // stale response
                              setStreetResults(found);
                              setStreetOpen(true);
                            },
                            () => {
                              if (seq !== streetRequestSeq.current) return;
                              setStreetResults([]);
                            }
                          );
                        }, 300);
                      } else {
                        streetRequestSeq.current += 1;
                        setStreetResults([]);
                      }
                    }}
                    className={inputClass}
                  />
                  {streetOpen && streetResults.length > 0 && !street && (
                    <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                      {streetResults.map((st) => (
                        <li key={st.id}>
                          <button
                            type="button"
                            className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50"
                            onClick={() => {
                              setStreet(st);
                              setStreetQuery(st.name);
                              setStreetOpen(false);
                              setStreetResults([]);
                              setDeliveryError(null);
                            }}
                          >
                            {st.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="co-building" className="label">
                      Будинок *
                    </label>
                    <input
                      id="co-building"
                      type="text"
                      maxLength={100}
                      value={building}
                      onChange={(e) => setBuilding(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="co-flat" className="label">
                      Квартира
                    </label>
                    <input
                      id="co-flat"
                      type="text"
                      maxLength={10}
                      value={flat}
                      onChange={(e) => setFlat(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Ukrposhta — Відділення: city autocomplete + office select
                against the open Address Classifier proxy routes. */}
            {deliveryType === 'ukrposhta_warehouse' && (
              <>
                <div className="relative mb-4">
                  <label htmlFor="co-up-settlement" className="label">
                    Населений пункт *
                  </label>
                  <input
                    id="co-up-settlement"
                    type="text"
                    autoComplete="off"
                    maxLength={100}
                    placeholder="Почніть вводити назву міста…"
                    value={
                      upSettlement && upSettlementQuery === upSettlement.name
                        ? upSettlement.name
                        : upSettlementQuery
                    }
                    onChange={(e) => {
                      const q = e.target.value;
                      setUpSettlementQuery(q);
                      setUpSettlement(null);
                      setUpOffice(null);
                      setUpOffices([]);
                      setUpOfficesLoading(false);
                      setUpSettlementOpen(true);
                      if (upSettlementDebounceRef.current) clearTimeout(upSettlementDebounceRef.current);
                      if (q.trim().length >= 2) {
                        setUpSettlementLoading(true);
                        const seq = ++upSettlementRequestSeq.current;
                        upSettlementDebounceRef.current = setTimeout(() => {
                          searchUkrposhtaSettlementsApi(
                            q.trim(),
                            (found) => {
                              if (seq !== upSettlementRequestSeq.current) return; // stale response
                              setUpSettlementResults(found);
                              setUpSettlementOpen(true);
                              setUpSettlementLoading(false);
                            },
                            () => {
                              if (seq !== upSettlementRequestSeq.current) return; // stale response
                              setUpSettlementResults([]);
                              setUpSettlementLoading(false);
                            }
                          );
                        }, 300);
                      } else {
                        // Query invalidated (too short): bump the sequence so
                        // any in-flight response is dropped, reset the list.
                        upSettlementRequestSeq.current += 1;
                        setUpSettlementLoading(false);
                        setUpSettlementResults([]);
                      }
                    }}
                    className={inputClass}
                  />
                  {upSettlementOpen && !upSettlement && upSettlementQuery.trim().length >= 2 && (
                    upSettlementLoading ? (
                      <p className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg" role="status">
                        Шукаємо…
                      </p>
                    ) : upSettlementResults.length > 0 ? (
                      <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                        {upSettlementResults.map((s) => (
                          <li key={s.id}>
                            <button
                              type="button"
                              className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50"
                              onClick={() => {
                                // Selection is final: drop any in-flight
                                // search response so it can't re-open the
                                // dropdown, and drop any in-flight office
                                // list for the previous city.
                                upSettlementRequestSeq.current += 1;
                                if (upSettlementDebounceRef.current) clearTimeout(upSettlementDebounceRef.current);
                                setUpSettlement(s);
                                setUpSettlementQuery(s.name);
                                setUpSettlementOpen(false);
                                setUpSettlementResults([]);
                                setUpSettlementLoading(false);
                                // The office belongs to the chosen city:
                                // keep a previously picked office of the old
                                // city from riding along in the order.
                                setUpOffice(null);
                                loadUkrposhtaOffices(s.id);
                              }}
                            >
                              <span className="block">{s.name}</span>
                              {(s.regionName || s.districtName) && (
                                <span className="block text-xs text-gray-500">
                                  {[s.regionName, s.districtName].filter(Boolean).join(', ')}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 shadow-lg">
                        Нічого не знайдено — спробуйте іншу назву
                      </p>
                    )
                  )}
                </div>

                <div className="mb-4">
                  <label htmlFor="co-up-office" className="label">
                    Відділення *
                  </label>
                  {upSettlement ? (
                    upOfficesLoading ? (
                      <p className="text-sm text-gray-500" role="status">
                        Завантажуємо варіанти…
                      </p>
                    ) : upOffices.length > 0 ? (
                      <select
                        id="co-up-office"
                        value={upOffice ? String(upOffice.id) : ''}
                        onChange={(e) => {
                          const o = upOffices.find(
                            (x) => String(x.id) === e.target.value
                          );
                          setUpOffice(o ?? null);
                          setDeliveryError(null);
                        }}
                        className={inputClass}
                      >
                        <option value="">— оберіть відділення —</option>
                        {upOffices.map((o) => (
                          <option key={o.id} value={String(o.id)}>
                            {[o.shortName ?? o.longName, [o.postIndex, o.address].filter(Boolean).join(', ')]
                              .filter(Boolean)
                              .join(', ')}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm text-gray-500">
                        Немає доступних відділень у цьому місті
                      </p>
                    )
                  ) : (
                    <p className="text-sm text-gray-500">спочатку оберіть населений пункт</p>
                  )}
                </div>
              </>
            )}

            {deliveryError && <p className="field-error">{deliveryError}</p>}
          </div>

          <div>
            <label htmlFor="co-notes" className="label">
              Примітка до замовлення
            </label>
            <textarea
              id="co-notes"
              rows={3}
              maxLength={300}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={inputClass}
            />
          </div>

          {/* LiqPay-подсказка не нужна, когда оформляется самовывоз с
              оплатой наличными на точке. Условие привязано К ДОСТАВКЕ, а не
              только к radio: пользователь мог выбрать готівку, потом
              переключиться на перевозчика — stale intent не должен прятать
              подсказку (аудит P2). */}
          {!(deliveryType === 'pickup' && paymentIntent === 'cash_on_pickup') && (
            <p className="text-xs text-gray-500">
              Після оформлення замовлення ви зможете одразу сплатити його
              онлайн через LiqPay.
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !hydrated || items.length === 0}
            className="btn btn-primary w-full py-3 text-base"
          >
            {submitting ? 'Оформлення…' : 'Підтвердити замовлення'}
          </button>
        </fieldset>
        </form>

        {/* Order summary. order-first keeps it ABOVE the submit button on
            mobile (DOM order puts the aside after the whole form there);
            lg:order-none restores the natural two-column layout. */}
        <aside
          className="card order-first w-full p-6 lg:order-none lg:sticky lg:top-24 lg:w-96"
          aria-label="Склад замовлення"
        >
          <h2 className="mb-4 text-lg font-semibold">Ваше замовлення</h2>

          {items.length === 0 ? (
            <p className="text-sm text-gray-500">Кошик порожній</p>
          ) : previewError && purchasable.length === 0 ? (
            <p
              className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              role="status"
            >
              Не вдалося завантажити ціни товарів. Оформіть замовлення — точну
              суму підтвердить менеджер.
            </p>
          ) : (
            <>
              {unavailableItems.length > 0 && (
                <div
                  className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2"
                  role="status"
                >
                  <p className="text-sm font-medium text-red-800">
                    Ці товари більше недоступні:
                  </p>
                  <ul className="mt-2 space-y-2">
                    {unavailableItems.map(({ item, preview }) => (
                      <li
                        key={`${item.productId}::${item.variantId ?? ''}`}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate text-red-700">
                          {preview?.found
                            ? (preview.name ?? 'Товар')
                            : 'Товар більше не доступний у каталозі'}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            removeItem(item.productId, item.variantId)
                          }
                          className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 transition"
                        >
                          Видалити
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <ul className="mb-4 space-y-3 text-sm">
                {purchasable.map(({ item, preview }) => (
                  <li key={`${item.productId}::${item.variantId ?? ''}`} className="flex gap-3">
                    {preview?.imageUrl && (
                      <Image
                        src={preview.imageUrl}
                        alt={preview.name ?? ''}
                        width={48}
                        height={48}
                        sizes="48px"
                        className="h-12 w-12 rounded-lg border border-gray-100 object-cover"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block line-clamp-2 font-medium">{preview?.name}</span>
                      {preview?.variantName && (
                        <span className="block text-xs text-gray-500">{preview.variantName}</span>
                      )}
                      <span className="text-xs text-gray-500">{item.quantity} шт</span>
                    </span>
                     <span className="whitespace-nowrap font-medium">
                       {formatPrice(
                         (preview?.unitPrice ?? 0) * item.quantity,
                         preview?.currency ?? currency
                       )}
                     </span>
                  </li>
                ))}
              </ul>
               <dl className="space-y-1 border-t border-gray-100 pt-3 text-sm">
                 <div className="flex justify-between text-gray-600">
                   <dt>Товари</dt>
                   <dd>
                     {subtotalByCurrency.size <= 1
                       ? formatPrice(
                           [...subtotalByCurrency.values()][0] ?? 0,
                           currency
                         )
                       : [...subtotalByCurrency.entries()]
                           .map(([cur, sum]) => formatPrice(sum, cur))
                           .join(' + ')}
                   </dd>
                 </div>
                 <div className="flex justify-between text-gray-600">
                   <dt>Доставка</dt>
                   <dd>
                     {deliveryType === 'pickup'
                       ? 'Безкоштовно (самовивіз)'
                       : 'за тарифами перевізника'}
                   </dd>
                 </div>
                 <div className="flex justify-between pt-1 text-base font-bold text-gray-900">
                   <dt>До сплати</dt>
                   <dd>
                     {subtotalByCurrency.size <= 1
                       ? formatPrice(
                           [...subtotalByCurrency.values()][0] ?? 0,
                           currency
                         )
                       : [...subtotalByCurrency.entries()]
                           .map(([cur, sum]) => formatPrice(sum, cur))
                           .join(' + ')}
                   </dd>
                 </div>
               </dl>
              {previewError && (
                <p
                  className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                  role="status"
                >
                  Не вдалося завантажити частину цін — точну суму підтвердить
                  менеджер.
                </p>
              )}
              <p className="mt-3 border-t border-gray-100 pt-3 text-xs leading-relaxed text-gray-500">
                Для оформлення купівлі товару в оплату частинами від
                ПриватБанку, А-Банку та Пумб Банку звертатися за номером
                телефону{' '}
                <a
                  href="tel:+380973144221"
                  className="whitespace-nowrap font-medium text-blue-600 hover:underline"
                >
                  +380 (97) 314 42 21
                </a>
              </p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
