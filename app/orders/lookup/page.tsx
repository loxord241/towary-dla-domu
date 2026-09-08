'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * Guest order lookup: the capability pair is (order number, email).
 * On success the API returns an HMAC token and we redirect to
 * /orders/<number>?t=<token> — the durable view URL.
 */
export default function OrderLookupPage() {
  const router = useRouter();
  const [orderNumber, setOrderNumber] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/orders/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber: orderNumber.trim(), email: email.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.orderNumber || !data?.accessToken) {
        throw new Error(data?.error || 'Замовлення не знайдено');
      }
      router.push(
        `/orders/${encodeURIComponent(data.orderNumber)}?t=${data.accessToken}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Помилка пошуку');
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full">
        <h1 className="text-2xl font-bold mb-2 text-center">Статус замовлення</h1>
        <p className="text-gray-600 mb-6 text-sm text-center">
          Вкажіть номер замовлення та email, вказаний при оформленні.
        </p>

        {error && (
          <div role="alert" className="mb-4 px-4 py-3 rounded bg-red-100 border border-red-300 text-red-700 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="mb-4">
            <label htmlFor="ol-number" className="block text-sm font-medium text-gray-700 mb-1">
              Номер замовлення *
            </label>
            <input
              id="ol-number"
              type="text"
              required
              placeholder="ORD-YYYYMMDD-XXXXXX"
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
          </div>

          <div className="mb-6">
            <label htmlFor="ol-email" className="block text-sm font-medium text-gray-700 mb-1">
              Email *
            </label>
            <input
              id="ol-email"
              type="email"
              required
              autoComplete="email"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 transition disabled:opacity-50"
          >
            {submitting ? 'Пошук…' : 'Знайти замовлення'}
          </button>
        </form>

        <p className="mt-4 text-sm text-gray-500 text-center">
          <Link href="/catalog" className="text-blue-600 hover:underline">
            До каталогу
          </Link>
        </p>
      </div>
    </main>
  );
}
