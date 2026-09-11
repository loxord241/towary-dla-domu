'use client';

import { useState, type FormEvent } from 'react';

/**
 * «Повідомити про наявність» — restock request form for out-of-stock
 * positions (v1: the OWNER gets a Telegram digest and contacts the
 * customer; the customer never receives an automatic email).
 *
 * Mounting contract: the PDP renders this ONLY when
 * availability_status === 'out_of_stock' (server-side gate in
 * app/product/[slug]/page.tsx) — the client component itself does not
 * decide visibility.
 *
 * Network contract (lib/cart-preview.ts never-stuck invariant): every
 * submit settles within RESTOCK_TIMEOUT_MS — the fetch is bounded by an
 * AbortController timeout and every path (ok / 400 / 429 / 5xx / abort /
 * network error) ends in either the success state or an inline error,
 * so the button can never stay busy forever.
 *
 * The endpoint answers the same `200 { ok: true }` for duplicates and for
 * products that are no longer out of stock (anti-enumeration), so a 200 is
 * ALWAYS shown as success; only a malformed email (400 «Некоректний
 * email»), rate limiting (429) and server errors surface inline text.
 */

const ENDPOINT = '/api/products/restock-notify';
/** Hard upper bound for request + response (same budget as cart-preview). */
export const RESTOCK_TIMEOUT_MS = 12_000;

const GENERIC_ERROR = 'Не вдалося надіслати запит. Спробуйте пізніше.';
const NETWORK_ERROR =
  'Немає з’єднання з сервером. Перевірте інтернет і спробуйте ще раз.';
const RATE_LIMIT_ERROR = 'Забагато спроб. Спробуйте пізніше.';

type Status = 'idle' | 'submitting' | 'success';

export default function RestockNotify({ productId }: { productId: string }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === 'submitting') return;
    setError(null);
    setStatus('submitting');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESTOCK_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, email }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (res.ok && data?.ok === true) {
        // The generic 200 covers «saved», «duplicate» and «already back in
        // stock» alike — success is the only honest shared response.
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

  if (status === 'success') {
    return (
      <p
        role="status"
        className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800"
      >
        Готово! Повідомимо, коли з&apos;явиться
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4" noValidate>
      <label htmlFor={`restock-email-${productId}`} className="sr-only">
        Email для повідомлення про наявність
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={`restock-email-${productId}`}
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          placeholder="Ваш email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === 'submitting'}
          maxLength={254}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400 motion-reduce:transition-none"
        />
        <button
          type="submit"
          disabled={status === 'submitting' || email.trim() === ''}
          className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 motion-reduce:transition-none"
        >
          {status === 'submitting' ? 'Надсилаємо…' : 'Повідомити про наявність'}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}
