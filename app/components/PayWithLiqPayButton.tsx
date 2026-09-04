'use client';

import { useState } from 'react';

/**
 * Client-side LiqPay launcher.
 *
 * POSTs the capability token to the init endpoint, which returns ONLY
 * { data, signature, checkoutUrl }. The values are submitted verbatim as a
 * generated form to LiqPay's checkout — the client never sees or supplies
 * amounts, currency or order identifiers, and never sees any secret.
 */
export default function PayWithLiqPayButton({
  orderNumber,
  accessToken,
}: {
  orderNumber: string;
  accessToken: string;
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function startPayment() {
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch(
        `/api/orders/${encodeURIComponent(orderNumber)}/payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: accessToken }),
          // A hung init call would pin «Підготовка оплати…» forever; 20 s
          // matches the CheckoutForm submit deadline convention.
          signal: AbortSignal.timeout(20_000),
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(body?.error ?? 'Не вдалося розпочати оплату. Спробуйте ще раз.');
        setStatus('error');
        return;
      }
      const { data, signature, checkoutUrl } = (await res.json()) as {
        data: string;
        signature: string;
        checkoutUrl: string;
      };

      // Submit exactly what our API produced — nothing else exists to send.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = checkoutUrl;
      for (const [name, value] of [
        ['data', data],
        ['signature', signature],
      ] as const) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.setAttribute('name', name);
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        setError('Сервер не відповів вчасно. Спробуйте ще раз.');
      } else {
        setError('Мережева помилка. Спробуйте ще раз.');
      }
      setStatus('error');
    }
  }

  return (
    <div className="px-6 pb-6">
      <button
        type="button"
        onClick={startPayment}
        disabled={status === 'loading'}
        className="w-full bg-blue-600 text-white py-3 rounded-md font-semibold hover:bg-blue-700 transition disabled:opacity-60"
      >
        {status === 'loading' ? 'Підготовка оплати…' : 'Оплатити через LiqPay'}
      </button>
      {error && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={startPayment}
            className="underline font-medium"
          >
            Спробуйте ще раз
          </button>
        </p>
      )}
    </div>
  );
}
