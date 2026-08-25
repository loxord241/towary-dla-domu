'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * Admin feedback viewer: anonymous site suggestions submitted through the
 * storefront footer. Reads and deletes via the guarded /api/admin/feedback
 * route (the page itself is additionally protected by the (dashboard)
 * layout). Feedback is anonymous by design — message text + timestamp only.
 */

interface FeedbackRow {
  id: string;
  message: string;
  created_at: string;
}

const dateFormatter = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

// Data loading happens inside async callbacks — never synchronously in an
// effect body (project react-hooks pattern, mirrors admin/orders).
async function fetchFeedbackApi(
  onDone: (items: FeedbackRow[], last24h: number) => void,
  onError: (message: string) => void
) {
  try {
    const res = await fetch('/api/admin/feedback');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { items: FeedbackRow[]; last24h: number };
    onDone(data.items, data.last24h);
  } catch (e) {
    onError(e instanceof Error ? e.message : 'невідома помилка');
  }
}

async function deleteFeedbackApi(
  id: string,
  onDone: () => void,
  onError: (message: string) => void
) {
  try {
    const res = await fetch('/api/admin/feedback', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    onDone();
  } catch (e) {
    onError(e instanceof Error ? e.message : 'невідома помилка');
  }
}

export default function AdminFeedbackPage() {
  const [items, setItems] = useState<FeedbackRow[] | null>(null);
  const [last24h, setLast24h] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const applyLoad = () => {
    setError(null);
    fetchFeedbackApi((rows, count) => {
      setItems(rows);
      setLast24h(count);
    }, setError);
  };

  useEffect(() => {
    let cancelled = false;
    fetchFeedbackApi(
      (rows, count) => {
        if (!cancelled) {
          setItems(rows);
          setLast24h(count);
        }
      },
      (message) => {
        if (!cancelled) setError(message);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (id: string) => {
    if (!window.confirm('Видалити цей відгук? Дію не можна скасувати.')) return;
    setDeletingId(id);
    deleteFeedbackApi(
      id,
      () => {
        setItems((prev) => (prev ?? []).filter((row) => row.id !== id));
        setLast24h((n) => Math.max(0, n - 1));
        setDeletingId(null);
      },
      (message) => {
        setError(message);
        setDeletingId(null);
      }
    );
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Зворотний зв&apos;язок
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Анонімні пропозиції з футера сайту. За останні 24 години:{' '}
            <span className="font-semibold text-gray-700">{last24h}</span>
          </p>
        </div>
        <Link
          href="/admin"
          className="text-sm text-gray-500 underline hover:text-blue-600"
        >
          ← До панелі
        </Link>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          Помилка: {error}{' '}
          <button type="button" onClick={applyLoad} className="underline font-medium">
            Спробувати ще
          </button>
        </div>
      )}

      {items === null ? (
        <p className="text-sm text-gray-500">Завантаження...</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
          <p className="text-gray-900">Відгуків поки що немає</p>
          <p className="mt-1 text-sm text-gray-500">
            Нові з&apos;являться тут, коли відвідувачі надішлють їх через футер сайту.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((row) => (
            <li
              key={row.id}
              className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
                <time dateTime={row.created_at}>
                  {dateFormatter.format(new Date(row.created_at))}
                </time>
                <button
                  type="button"
                  onClick={() => remove(row.id)}
                  disabled={deletingId === row.id}
                  className="rounded px-2 py-1 text-red-500 transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingId === row.id ? 'Видаляємо...' : 'Видалити'}
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
                {row.message}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
