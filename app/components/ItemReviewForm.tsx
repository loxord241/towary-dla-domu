'use client';

import { useState } from 'react';
import { StarIcon } from './icons';
import {
  REVIEW_MAX_LENGTH,
  REVIEW_MIN_LENGTH,
} from '@/app/lib/reviews';

/**
 * Inline post-order review widget on the checkout success page (owner
 * request 2026-09-13): five gray stars + a text field directly under the
 * purchased item — «сразу поставить и написать». Uses the SAME endpoint and
 * contract as the PDP review modal (POST /api/reviews, honeypot `website`,
 * pending moderation) — nothing is published without an admin.
 */
export default function ItemReviewForm({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [text, setText] = useState('');
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>(
    'idle'
  );

  const trimmed = text.trim().length;
  const canSubmit = rating >= 1 && trimmed >= REVIEW_MIN_LENGTH && trimmed <= REVIEW_MAX_LENGTH;
  const shown = hovered > 0 ? hovered : rating;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || status === 'sending') return;
    setStatus('sending');
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, rating, text, website }),
      });
      setStatus(res.status === 201 ? 'success' : 'error');
    } catch {
      setStatus('error');
    }
  };

  if (status === 'success') {
    return (
      <p className="mt-2 rounded-md bg-green-50 px-3 py-2 text-xs text-green-700" role="status">
        Дякуємо за відгук про «{productName}»! Він з&apos;явиться після перевірки.
      </p>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="mt-2 border-t border-gray-100 pt-2">
      <p className="text-xs text-gray-500">Як вам товар? Поставте оцінку:</p>
      <div className="mt-1 flex gap-0.5" role="radiogroup" aria-label={`Оцінка товару ${productName} від 1 до 5`}>
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={rating === value}
            aria-label={`${value} з 5`}
            onMouseEnter={() => setHovered(value)}
            onMouseLeave={() => setHovered(0)}
            onClick={() => setRating(value)}
            className={`rounded p-1 transition-colors ${
              value <= shown ? 'text-amber-500' : 'text-gray-300'
            } hover:text-amber-400`}
          >
            <StarIcon className="h-6 w-6" filled={value <= shown} />
          </button>
        ))}
      </div>
      <textarea
        aria-label={`Ваш відгук про ${productName}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={REVIEW_MAX_LENGTH}
        placeholder={`Кілька слів про «${productName}» (від ${REVIEW_MIN_LENGTH} символів)…`}
        className="mt-2 w-full rounded-md border border-gray-300 p-2 text-sm focus:border-transparent focus:ring-2 focus:ring-blue-500"
      />
      {/* honeypot — invisible to humans, bots fill it */}
      <input
        type="text"
        name="website"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[11px] text-gray-400">
          Відгук публікується після перевірки модератором.
        </span>
        <button
          type="submit"
          disabled={!canSubmit || status === 'sending'}
          className="min-h-[36px] rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'sending' ? 'Надсилаємо…' : 'Надіслати відгук'}
        </button>
      </div>
      {status === 'error' && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          Не вдалося надіслати. Перевірте оцінку та текст (від {REVIEW_MIN_LENGTH} символів).
        </p>
      )}
    </form>
  );
}
