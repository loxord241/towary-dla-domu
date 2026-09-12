'use client';

import { useState, type FormEvent } from 'react';

/**
 * «Передзвоніть мені» — callback request form on the PDP (v1: the OWNER
 * gets a Telegram message with the name + phone and calls the customer
 * back; nothing is persisted — v1 has no table, so the success state is
 * shown ONLY for a confirmed Telegram send).
 *
 * Mounting contract: the PDP renders this for EVERY product (server side,
 * app/product/[slug]/page.tsx) — unlike RestockNotify there is no
 * availability gate: a callback is a consultation/lead channel, useful in
 * stock and out of stock alike.
 *
 * Network contract (same never-stuck invariant as RestockNotify): every
 * submit settles within CALLBACK_TIMEOUT_MS — the fetch is bounded by an
 * AbortController timeout and every path (ok / 400 / 429 / 5xx / abort /
 * network error) ends in either the success state or an inline error,
 * so the button can never stay busy forever.
 *
 * Mobile contract: inputs are text-base (16px — no iOS zoom) and every
 * tappable control is min-h-[44px].
 */

const ENDPOINT = '/api/products/callback-request';
/** Hard upper bound for request + response (same budget as restock). */
export const CALLBACK_TIMEOUT_MS = 12_000;

const GENERIC_ERROR = 'Не вдалося надіслати запит. Спробуйте пізніше.';
const NETWORK_ERROR =
  'Немає з’єднання з сервером. Перевірте інтернет і спробуйте ще раз.';
const RATE_LIMIT_ERROR = 'Забагато спроб. Спробуйте пізніше.';

type Status = 'closed' | 'idle' | 'submitting' | 'success';

export default function CallbackRequest({ productId }: { productId: string }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<Status>('closed');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'submitting') return;
    setError(null);
    setStatus('submitting');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, name, phone, website }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (res.ok && data?.ok === true) {
        setStatus('success');
        return;
      }
      if (res.status === 400 && typeof data?.error === 'string') {
        setError(data.error);
      } else if (res.status === 429) {
        setError(RATE_LIMIT_ERROR);
      } else {
        setError(GENERIC_ERROR);
      }
      setStatus('idle');
    } catch {
      setError(controller.signal.aborted ? NETWORK_ERROR : GENERIC_ERROR);
      setStatus('idle');
    } finally {
      clearTimeout(timer);
    }
  }

  if (status === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setStatus('idle')}
        className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center rounded-lg border border-gray-300 bg-white px-4 font-semibold text-gray-700 transition-colors hover:bg-gray-50 motion-reduce:transition-none"
      >
        Передзвоніть мені
      </button>
    );
  }

  if (status === 'success') {
    return (
      <p
        role="status"
        className="mt-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800"
      >
        Дякуємо! Ми зателефонуємо вам найближчим часом
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3" noValidate>
      <label htmlFor={`callback-name-${productId}`} className="sr-only">
        Ваше ім&apos;я
      </label>
      <input
        id={`callback-name-${productId}`}
        type="text"
        name="name"
        autoComplete="name"
        placeholder="Ваше ім'я"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={status === 'submitting'}
        maxLength={60}
        className="mb-2 min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 text-base transition-colors focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400 motion-reduce:transition-none"
      />
      <label htmlFor={`callback-phone-${productId}`} className="sr-only">
        Ваш телефон
      </label>
      <input
        id={`callback-phone-${productId}`}
        type="tel"
        name="phone"
        inputMode="tel"
        autoComplete="tel"
        placeholder="+380 __ ___ __ __"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        disabled={status === 'submitting'}
        maxLength={20}
        className="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 py-2 text-base transition-colors focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400 motion-reduce:transition-none"
      />
      {/* Honeypot: hidden from humans (sr-only + zero size + tabindex -1),
          dropped server-side when filled. */}
      <div aria-hidden="true" className="sr-only h-0 w-0 overflow-hidden">
        <label htmlFor={`callback-website-${productId}`}>Сайт</label>
        <input
          id={`callback-website-${productId}`}
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>
      <button
        type="submit"
        disabled={status === 'submitting' || name.trim() === '' || phone.trim() === ''}
        className="mt-2 inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-blue-600 px-4 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 motion-reduce:transition-none"
      >
        {status === 'submitting' ? 'Надсилаємо…' : 'Надіслати'}
      </button>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}
