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

type DeliveryType =
  | 'nova_poshta_warehouse'
  | 'nova_poshta_locker'
  | 'nova_poshta_courier';

const DELIVERY_TYPES: { value: DeliveryType; label: string }[] = [
  { value: 'nova_poshta_warehouse', label: 'Нова Пошта — Відділення' },
  { value: 'nova_poshta_locker', label: 'Нова Пошта — Поштомат' },
  { value: 'nova_poshta_courier', label: 'Нова Пошта — Кур’єр' },
];

// The live /divisions divisionCategory value for parcel lockers is
// "Postomat" (live-verified 2026-08-28); branches are PostBranch /
// CargoBranch. Match case-insensitively as a safety net.
const isLockerCategory = (category: string | null): boolean =>
  typeof category === 'string' && /postomat/i.test(category);

// Module-scope loaders (project react-hooks pattern): state updates happen
// inside async callbacks, never synchronously in an effect body.
async function searchSettlementsApi(
  q: string,
  onData: (items: NpSettlement[]) => void,
  onError: () => void
) {
  try {
    const res = await fetch(
      `/api/delivery/novapost/settlements?q=${encodeURIComponent(q)}`
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
      `/api/delivery/novapost/divisions?settlementId=${settlementId}`
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
      `/api/delivery/novapost/streets?settlementId=${settlementId}&name=${encodeURIComponent(name)}`
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('streets failed');
    onData((data?.items as NpStreet[]) ?? []);
  } catch {
    onError();
  }
}

export default function CheckoutForm() {
  const router = useRouter();
  const { items, hydrated, clearCart } = useCart();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');

  // --- Nova Post delivery choice (stage 2G) ---
  const [deliveryType, setDeliveryType] = useState<DeliveryType | ''>('');
  const [settlement, setSettlement] = useState<NpSettlement | null>(null);
  const [settlementQuery, setSettlementQuery] = useState('');
  const [settlementResults, setSettlementResults] = useState<NpSettlement[]>([]);
  const [settlementOpen, setSettlementOpen] = useState(false);
  const [divisions, setDivisions] = useState<NpDivision[]>([]);
  const [division, setDivision] = useState<NpDivision | null>(null);
  const [street, setStreet] = useState<NpStreet | null>(null);
  const [streetQuery, setStreetQuery] = useState('');
  const [streetResults, setStreetResults] = useState<NpStreet[]>([]);
  const [streetOpen, setStreetOpen] = useState(false);
  const [building, setBuilding] = useState('');
  const [flat, setFlat] = useState('');
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    email?: string;
  }>({});
  const [lines, setLines] = useState<CartPreviewLine[]>([]);

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
          if (!cancelled) setLines(data);
        },
        onError: () => {},
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
  const purchasable = items
    .map((item) => ({ item, preview: lineFor(item.productId, item.variantId) }))
    .filter(({ preview }) => preview?.found && preview.unitPrice !== null);
  const subtotal = purchasable.reduce(
    (sum, { item, preview }) => sum + (preview?.unitPrice ?? 0) * item.quantity,
    0
  );
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

  /** Strict delivery object for shipping_info.delivery; null when incomplete. */
  const deliveryObject = (): Record<string, unknown> | null => {
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
    const errs: { name?: string; email?: string } = {};
    if (name.trim().length === 0) errs.name = 'Вкажіть ім’я';
    else if (name.trim().length > 120) errs.name = 'Максимум 120 символів';
    const emailTrimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailTrimmed))
      errs.email = 'Вкажіть коректний email';
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});

    const delivery = deliveryObject();
    if (!delivery) {
      setDeliveryError(
        deliveryType === 'nova_poshta_courier'
          ? 'Оберіть місто та вулицю і вкажіть будинок'
          : deliveryType
            ? 'Оберіть відділення/поштомат'
            : 'Оберіть спосіб доставки'
      );
      return;
    }
    setDeliveryError(null);

    setSubmitting(true);

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ONLY identifiers + quantities + contact/shipping strings. The
        // structured delivery object carries Nova Post ids only — money and
        // payer fields are structurally impossible in this contract.
        body: JSON.stringify({
          contact: { name, email, phone },
          shipping: {
            city: settlement?.name ?? '',
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
      setError(err instanceof Error ? err.message : 'Помилка оформлення');
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
            <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">
              1. Контактні дані
            </p>
            <label htmlFor="co-name" className="label">
              Ім’я *
            </label>
            <input
              id="co-name"
              type="text"
              required
              maxLength={120}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (fieldErrors.name)
                  setFieldErrors((prev) => ({ ...prev, name: undefined }));
              }}
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? 'err-name' : undefined}
              className={inputClass}
            />
            {fieldErrors.name && (
              <p id="err-name" className="field-error">{fieldErrors.name}</p>
            )}
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
            <input
              id="co-phone"
              type="tel"
              maxLength={40}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
            />
          </div>

          <div className="pt-2 border-t border-gray-100 mt-2">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">
              2. Доставка (Нова Пошта)
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
              {DELIVERY_TYPES.map((t) => (
                <label
                  key={t.value}
                  className={`cursor-pointer rounded-md border p-3 text-sm transition ${
                    deliveryType === t.value
                      ? 'border-blue-600 bg-blue-50 font-medium'
                      : 'border-gray-300 hover:border-gray-400'
                  }`}
                >
                  <input
                    type="radio"
                    name="deliveryType"
                    value={t.value}
                    checked={deliveryType === t.value}
                    onChange={() => {
                      setDeliveryType(t.value);
                      setDivision(null);
                      setStreet(null);
                      setStreetQuery('');
                      setStreetResults([]);
                      setBuilding('');
                      setFlat('');
                      setDivisions([]);
                      setDeliveryError(null);
                      if (settlement && t.value !== 'nova_poshta_courier') {
                        fetchDivisionsApi(
                          settlement.id,
                          (items) => setDivisions(items),
                          () => setDivisions([])
                        );
                      }
                    }}
                    className="sr-only"
                  />
                  {t.label}
                </label>
              ))}
            </div>

            {/* Settlement — NP dictionary id is the identifier; the text is display only */}
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
                  setStreet(null);
                  setStreetQuery('');
                  setStreetResults([]);
                  setSettlementOpen(true);
                  if (debounceRef.current) clearTimeout(debounceRef.current);
                  if (q.trim().length >= 2) {
                    debounceRef.current = setTimeout(() => {
                      searchSettlementsApi(
                        q.trim(),
                        (found) => {
                          setSettlementResults(found);
                          setSettlementOpen(true);
                        },
                        () => setSettlementResults([])
                      );
                    }, 300);
                  } else {
                    setSettlementResults([]);
                  }
                }}
                className={inputClass}
              />
              {settlementOpen && settlementResults.length > 0 && !settlement && (
                <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
                  {settlementResults.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm hover:bg-blue-50"
                        onClick={() => {
                          setSettlement(s);
                          setSettlementQuery(s.name);
                          setSettlementOpen(false);
                          setSettlementResults([]);
                          if (deliveryType && deliveryType !== 'nova_poshta_courier') {
                            fetchDivisionsApi(
                              s.id,
                              (items) => setDivisions(items),
                              () => setDivisions([])
                            );
                          }
                        }}
                      >
                        <span className="block">{s.name}</span>
                        {(s.regionName || s.regionParentName) && (
                          <span className="block text-xs text-gray-400">
                            {[s.regionParentName, s.regionName].filter(Boolean).join(', ')}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Branch / parcel locker */}
            {(deliveryType === 'nova_poshta_warehouse' ||
              deliveryType === 'nova_poshta_locker') && (
              <div className="mb-4">
                <label htmlFor="co-division" className="label">
                  {deliveryType === 'nova_poshta_locker' ? 'Поштомат *' : 'Відділення *'}
                </label>
                {settlement ? (
                  divisionsForType.length > 0 ? (
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
                    <p className="text-sm text-gray-400">
                      Немає доступних варіантів у цьому місті
                    </p>
                  )
                ) : (
                  <p className="text-sm text-gray-400">спочатку оберіть населений пункт</p>
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
                      if (debounceRef.current) clearTimeout(debounceRef.current);
                      if (settlement && q.trim().length >= 2) {
                        debounceRef.current = setTimeout(() => {
                          searchStreetsApi(
                            settlement.id,
                            q.trim(),
                            (found) => {
                              setStreetResults(found);
                              setStreetOpen(true);
                            },
                            () => setStreetResults([])
                          );
                        }, 300);
                      } else {
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

          <p className="text-xs text-gray-400">
            Після відправки з вами зв’яжеться менеджер для підтвердження та оплати.
          </p>

          <button
            type="submit"
            disabled={submitting || !hydrated || items.length === 0}
            className="btn btn-primary w-full py-3 text-base"
          >
            {submitting ? 'Оформлення…' : 'Підтвердити замовлення'}
          </button>
        </fieldset>
        </form>

        {/* Order summary */}
        <aside className="card w-full p-6 lg:sticky lg:top-24 lg:w-96" aria-label="Склад замовлення">
          <h2 className="mb-4 text-lg font-semibold">Ваше замовлення</h2>

          {items.length === 0 ? (
            <p className="text-sm text-gray-500">Кошик порожній</p>
          ) : (
            <>
              <ul className="mb-4 space-y-3 text-sm">
                {purchasable.map(({ item, preview }) => (
                  <li key={`${item.productId}::${item.variantId ?? ''}`} className="flex gap-3">
                    {preview?.imageUrl && (
                      <Image
                        src={preview.imageUrl}
                        alt={preview.name ?? ''}
                        width={48}
                        height={48}
                        unoptimized
                        className="h-12 w-12 rounded-lg border border-gray-100 object-cover"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{preview?.name}</span>
                      {preview?.variantName && (
                        <span className="block text-xs text-gray-500">{preview.variantName}</span>
                      )}
                      <span className="text-xs text-gray-400">{item.quantity} шт</span>
                    </span>
                    <span className="whitespace-nowrap font-medium">
                      {((preview?.unitPrice ?? 0) * item.quantity).toFixed(2)} {currency}
                    </span>
                  </li>
                ))}
              </ul>
              <dl className="space-y-1 border-t border-gray-100 pt-3 text-sm">
                <div className="flex justify-between text-gray-600">
                  <dt>Товари</dt>
                  <dd>{subtotal.toFixed(2)} {currency}</dd>
                </div>
                <div className="flex justify-between text-gray-600">
                  <dt>Доставка</dt>
                  <dd>за тарифами перевізника</dd>
                </div>
                <div className="flex justify-between pt-1 text-base font-bold text-gray-900">
                  <dt>До сплати</dt>
                  <dd>{subtotal.toFixed(2)} {currency}</dd>
                </div>
              </dl>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
