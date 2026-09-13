'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCart } from '@/app/lib/cart-context';
import { fetchCartPreview, type CartPreviewLine } from '@/app/lib/cart-preview';
import { toE164Ua } from '@/app/lib/phone';
import { PICKUP_POINTS } from '@/app/lib/checkout-delivery';
import { ANALYTICS_EVENTS } from '@/app/lib/analytics';
import { track } from '@vercel/analytics';
import {
  fetchDivisionsApi, fetchUkrposhtaOfficesApi, isNpWarehouseType,
  type Carrier, type DeliveryType, type NpDivision, type NpSettlement,
  type NpStreet, type PickupPaymentIntent, type UpUaOffice, type UpUaSettlement,
} from './delivery-apis';
import { inputClass } from './parts/form-styles';
import ContactFields, { type CheckoutFieldErrors } from './parts/ContactFields';
import DeliveryCarrierPicker from './parts/DeliveryCarrierPicker';
import LiqPayHint from './parts/LiqPayHint';
import NovaPostDelivery from './parts/NovaPostDelivery';
import OrderSummary from './parts/OrderSummary';
import PickupBlock from './parts/PickupBlock';
import UkrposhtaDelivery from './parts/UkrposhtaDelivery';

interface SubmitResult {
  orderNumber: string; total?: number; currency?: string; accessToken: string;
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

  // Drop pending debounce timers when the form unmounts. The ref objects
  // are captured as-is (same objects the setters mutate — no value copy).
  useEffect(() => {
    const debounceRefs = [settlementDebounceRef, streetDebounceRef, upSettlementDebounceRef];
    return () => {
      for (const ref of debounceRefs) if (ref.current) clearTimeout(ref.current);
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
  const [fieldErrors, setFieldErrors] = useState<CheckoutFieldErrors>({});
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
    const errs: CheckoutFieldErrors = {};
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
    // line re-enables submit (the summary block offers the control).
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

            <ContactFields
              firstName={firstName} lastName={lastName} patronymic={patronymic}
              email={email} phoneDigits={phoneDigits}
              fieldErrors={fieldErrors}
              setFirstName={setFirstName} setLastName={setLastName}
              setPatronymic={setPatronymic} setEmail={setEmail}
              setPhoneDigits={setPhoneDigits} setFieldErrors={setFieldErrors}
            />
          </div>

          <div className="pt-2 border-t border-gray-100 mt-2">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              2. Доставка
            </p>

            <DeliveryCarrierPicker
              carrier={carrier} deliveryType={deliveryType}
              toggleCarrier={toggleCarrier} applyServiceType={applyServiceType}
            />

            {/* Самовивіз: точки під обраний домен кошика + спосіб оплати. */}
            {deliveryType === 'pickup' && (
              <PickupBlock
                availablePickupPoints={availablePickupPoints}
                pickupPointId={pickupPointId} paymentIntent={paymentIntent}
                setPickupPointId={setPickupPointId} setPaymentIntent={setPaymentIntent}
                cartHasWallpapers={cartHasWallpapers} cartHasTech={cartHasTech}
              />
            )}

            {/* NP dictionary fields render only once a Nova Post service
                type is chosen; UP has its own city field, pickup — none. */}
            {deliveryType !== '' &&
              deliveryType !== 'ukrposhta_warehouse' &&
              deliveryType !== 'pickup' && (
            <NovaPostDelivery
              deliveryType={deliveryType}
              settlement={settlement} settlementQuery={settlementQuery}
              settlementResults={settlementResults} settlementOpen={settlementOpen}
              settlementLoading={settlementLoading}
              divisions={divisions} divisionsLoading={divisionsLoading}
              division={division}
              street={street} streetQuery={streetQuery} streetResults={streetResults}
              streetOpen={streetOpen} building={building} flat={flat}
              setSettlement={setSettlement} setSettlementQuery={setSettlementQuery}
              setSettlementResults={setSettlementResults} setSettlementOpen={setSettlementOpen}
              setSettlementLoading={setSettlementLoading}
              setDivision={setDivision} setDivisions={setDivisions}
              setDivisionsLoading={setDivisionsLoading}
              setStreet={setStreet} setStreetQuery={setStreetQuery}
              setStreetResults={setStreetResults} setStreetOpen={setStreetOpen}
              setBuilding={setBuilding} setFlat={setFlat}
              setDeliveryError={setDeliveryError}
              settlementDebounceRef={settlementDebounceRef}
              settlementRequestSeq={settlementRequestSeq}
              divisionsRequestSeq={divisionsRequestSeq}
              streetDebounceRef={streetDebounceRef} streetRequestSeq={streetRequestSeq}
            />
              )}

            {deliveryType === 'ukrposhta_warehouse' && (
              <UkrposhtaDelivery
                upSettlement={upSettlement} upSettlementQuery={upSettlementQuery}
                upSettlementResults={upSettlementResults} upSettlementOpen={upSettlementOpen}
                upSettlementLoading={upSettlementLoading}
                upOffices={upOffices} upOfficesLoading={upOfficesLoading}
                upOffice={upOffice}
                setUpSettlement={setUpSettlement} setUpSettlementQuery={setUpSettlementQuery}
                setUpSettlementResults={setUpSettlementResults} setUpSettlementOpen={setUpSettlementOpen}
                setUpSettlementLoading={setUpSettlementLoading}
                setUpOffices={setUpOffices} setUpOfficesLoading={setUpOfficesLoading}
                setUpOffice={setUpOffice}
                setDeliveryError={setDeliveryError}
                loadUkrposhtaOffices={loadUkrposhtaOffices}
                upSettlementDebounceRef={upSettlementDebounceRef}
                upSettlementRequestSeq={upSettlementRequestSeq}
              />
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

          <LiqPayHint deliveryType={deliveryType} paymentIntent={paymentIntent} />

          <button
            type="submit"
            disabled={submitting || !hydrated || items.length === 0}
            className="btn btn-primary w-full py-3 text-base"
          >
            {submitting ? 'Оформлення…' : 'Підтвердити замовлення'}
          </button>
        </fieldset>
        </form>

        <OrderSummary
          items={items} purchasable={purchasable} unavailableItems={unavailableItems}
          previewError={previewError} subtotalByCurrency={subtotalByCurrency}
          currency={currency} deliveryType={deliveryType} removeItem={removeItem}
        />
      </div>
    </div>
  );
}
