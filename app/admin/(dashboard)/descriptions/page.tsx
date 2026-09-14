'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * Admin description-drafts queue (migration 050, spec 2026-09-14 Phase 2):
 * pending generated descriptions, «Затвердити» / «Відхилити» per card.
 * Reads and writes go through the guarded /api/admin/descriptions route;
 * the page itself is additionally protected by the (dashboard) layout.
 *
 * SAFETY CONTRACT: «Затвердити» publishes the draft text onto the product
 * (products.description — the one and only write path, atomic server-side)
 * and removes the card from the queue; «Відхилити» only marks the draft
 * rejected. Both actions are final for the card — no edit-in-place here,
 * текст чернетки згенерований ядром Фази 1 і правиться тільки повторним
 * прогоном генератора, не в адмінці.
 */

type DraftItem = {
  id: string;
  product_id: string;
  lead: string;
  description_text: string;
  status: string;
  source: string;
  created_at: string;
  reviewed_at: string | null;
  product: { name: string; sku: string; slug: string } | null;
};

type ListResponse = {
  items?: DraftItem[];
  total?: number;
  page?: number;
  pageSize?: number;
  pageCount?: number;
  error?: string;
};

export default function AdminDescriptionsPage() {
  const [items, setItems] = useState<DraftItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Pure fetcher (no setState) so the mount effect can follow the
  // announcements pattern: state updates happen inside .then(), never
  // synchronously in the effect body (react-hooks/set-state-in-effect).
  const fetchPage = useCallback(
    async (p: number): Promise<ListResponse & { ok: boolean }> => {
      const res = await fetch(`/api/admin/descriptions?page=${p}`);
      const data = (await res.json().catch(() => ({}))) as ListResponse;
      return { ok: res.ok, ...data };
    },
    []
  );

  const applyList = (data: ListResponse & { ok: boolean }, requestedPage: number) => {
    if (data.ok) {
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setPageCount(data.pageCount ?? 1);
      setPage(data.page ?? requestedPage);
      setError(null);
    } else {
      setItems((prev) => prev ?? []);
      setError(data.error ?? 'HTTP error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchPage(1).then((data) => {
      if (cancelled) return;
      applyList(data, 1);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  const load = useCallback(
    async (p: number) => {
      applyList(await fetchPage(p), p);
    },
    [fetchPage]
  );

  const review = async (row: DraftItem, action: 'approve' | 'reject') => {
    const confirmText =
      action === 'approve'
        ? `Опублікувати опис для «${row.product?.name ?? row.product_id}»? Текст стане описом товару на сайті.`
        : `Відхилити чернетку для «${row.product?.name ?? row.product_id}»?`;
    if (!window.confirm(confirmText)) return;

    setBusyId(row.id);
    setError(null);
    const res = await fetch('/api/admin/descriptions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row.id, action }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) {
      // Reviewed drafts leave the pending queue immediately.
      setItems((prev) => (prev ?? []).filter((r) => r.id !== row.id));
      setTotal((t) => Math.max(0, t - 1));
    } else {
      setError(data.error ?? 'HTTP error');
    }
    setBusyId(null);
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Чернетки описів товарів
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Згенеровані з характеристик описи для товарів без тексту.
            «Затвердити» публікує текст на картці товару, «Відхилити» —
            лише позначає чернетку; сама картка товару при відхиленні не
            змінюється.
          </p>
        </div>
        <Link href="/admin" className="text-sm text-gray-500 underline hover:text-blue-600">
          ← До панелі
        </Link>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          Помилка: {error}{' '}
          <button
            type="button"
            onClick={() => {
              setError(null);
              void load(page);
            }}
            className="font-medium underline"
          >
            Спробувати ще
          </button>
        </div>
      )}

      {items === null ? (
        <p className="text-sm text-gray-500">Завантаження...</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
          <p className="text-gray-900">Чернеток немає</p>
          <p className="mt-1 text-sm text-gray-500">
            Чернетки створюються генератором: node scripts/description-generate.ts --run --limit N
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-500">
            У черзі: {total} · сторінка {page} з {pageCount} (до 50 на сторінці)
          </p>
          <ul className="space-y-3">
            {items.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    {row.product ? (
                      <a
                        href={`/product/${encodeURIComponent(row.product.slug)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-gray-900 underline-offset-2 hover:text-blue-700 hover:underline"
                      >
                        {row.product.name}
                      </a>
                    ) : (
                      <span className="font-semibold text-gray-900">
                        Товар видалено ({row.product_id})
                      </span>
                    )}
                    <span className="ml-2 text-xs text-gray-400">
                      SKU: {row.product?.sku ?? '—'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void review(row, 'approve')}
                      disabled={busyId === row.id}
                      className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyId === row.id ? '...' : 'Затвердити'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void review(row, 'reject')}
                      disabled={busyId === row.id}
                      className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyId === row.id ? '...' : 'Відхилити'}
                    </button>
                  </div>
                </div>
                {row.lead !== '' && (
                  <p className="mt-3 border-l-4 border-blue-200 pl-3 text-sm leading-relaxed text-gray-700">
                    {row.lead}
                  </p>
                )}
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-600">
                  {row.description_text}
                </p>
                <p className="mt-2 text-xs text-gray-400">
                  Джерело: {row.source} · створено{' '}
                  {new Date(row.created_at).toLocaleString('uk-UA')}
                </p>
              </li>
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => void load(page - 1)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ← Назад
              </button>
              <span className="text-sm text-gray-500">
                {page} / {pageCount}
              </span>
              <button
                type="button"
                disabled={page >= pageCount}
                onClick={() => void load(page + 1)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Вперед →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
