'use client';

import { useEffect, useState } from 'react';
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

export default function CheckoutForm() {
  const router = useRouter();
  const { items, hydrated, clearCart } = useCart();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');

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

    setSubmitting(true);

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ONLY identifiers + quantities + contact/shipping strings.
        body: JSON.stringify({
          contact: { name, email, phone },
          shipping: { city, address, notes },
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
              2. Доставка
            </p>
            <label htmlFor="co-city" className="label">
              Місто
            </label>
            <input
              id="co-city"
              type="text"
              maxLength={120}
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="co-address" className="label">
              Адреса / відділення
            </label>
            <input
              id="co-address"
              type="text"
              maxLength={300}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className={inputClass}
            />
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
