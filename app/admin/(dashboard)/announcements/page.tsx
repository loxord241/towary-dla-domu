'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Modal from '@/app/components/Modal';
import {
  ANNOUNCEMENT_TYPES,
  ANNOUNCEMENT_TYPE_META,
  ANNOUNCEMENT_TITLE_MAX,
  ANNOUNCEMENT_MESSAGE_MAX,
  type Announcement,
  type AnnouncementType,
} from '@/app/lib/announcements';

/**
 * Admin store announcements (migration 031): list, ON/OFF toggle,
 * create/edit, delete. Reads and writes go through the guarded
 * /api/admin/announcements route; the page itself is additionally
 * protected by the (dashboard) layout.
 *
 * Safety contract: toggling affects ONLY is_active of that row — active
 * neighbors keep their state and order. New announcements always start
 * inactive; publishing is an explicit toggle click.
 */

type Draft = {
  title: string;
  message: string;
  type: AnnouncementType;
  sortOrder: string;
};

const EMPTY_DRAFT: Draft = {
  title: '',
  message: '',
  type: 'info',
  sortOrder: '0',
};

const TYPE_BADGE: Record<AnnouncementType, string> = {
  info: 'bg-blue-100 text-blue-700',
  warning: 'bg-amber-100 text-amber-700',
  important: 'bg-red-100 text-red-700',
  success: 'bg-emerald-100 text-emerald-700',
};

async function callApi(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<{ ok: boolean; data: { items?: Announcement[]; item?: Announcement; error?: string } }> {
  const res = await fetch('/api/admin/announcements', {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    items?: Announcement[];
    item?: Announcement;
    error?: string;
  };
  return { ok: res.ok, data };
}

export default function AdminAnnouncementsPage() {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setError(null);
    const { ok, data } = await callApi('GET');
    if (ok) {
      setItems(data.items ?? []);
    } else {
      setError(data.error ?? `HTTP error`);
    }
  };

  useEffect(() => {
    let cancelled = false;
    callApi('GET').then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) setItems(data.items ?? []);
      else setError(data.error ?? 'HTTP error');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (row: Announcement) => {
    setBusyId(row.id);
    setError(null);
    const { ok, data } = await callApi('PATCH', {
      id: row.id,
      is_active: !row.is_active,
    });
    if (ok && data.item) {
      setItems((prev) =>
        (prev ?? []).map((r) => (r.id === row.id ? (data.item as Announcement) : r))
      );
    } else {
      setError(data.error ?? 'HTTP error');
    }
    setBusyId(null);
  };

  const remove = async (row: Announcement) => {
    if (!window.confirm(`Видалити «${row.title}»? Дію не можна скасувати.`)) return;
    setBusyId(row.id);
    setError(null);
    const { ok, data } = await callApi('DELETE', { id: row.id });
    if (ok) {
      setItems((prev) => (prev ?? []).filter((r) => r.id !== row.id));
    } else {
      setError(data.error ?? 'HTTP error');
    }
    setBusyId(null);
  };

  const openEdit = (row: Announcement) => {
    setEditing(row);
    setCreating(false);
    setDraft({
      title: row.title,
      message: row.message,
      type: row.type,
      sortOrder: String(row.sort_order),
    });
  };

  const openCreate = () => {
    setCreating(true);
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  };

  const closeModal = () => {
    setCreating(false);
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      title: draft.title,
      message: draft.message,
      type: draft.type,
      sortOrder: Number(draft.sortOrder),
    };
    const { ok, data } = editing
      ? await callApi('PATCH', { id: editing.id, ...payload })
      : await callApi('POST', payload);
    if (ok) {
      await reload();
      closeModal();
    } else {
      setError(data.error ?? 'HTTP error');
    }
    setSaving(false);
  };

  const draftValid =
    draft.title.trim().length > 0 &&
    draft.title.trim().length <= ANNOUNCEMENT_TITLE_MAX &&
    draft.message.trim().length > 0 &&
    draft.message.trim().length <= ANNOUNCEMENT_MESSAGE_MAX &&
    /^\d+$/.test(draft.sortOrder.trim()) &&
    Number(draft.sortOrder) <= 100_000;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Повідомлення магазину
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Інформаційні картки на головній, в каталозі, на сторінках товарів і в
            кошику. Активні показуються покупцям у порядку сортування.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={openCreate}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            Створити
          </button>
          <Link href="/admin" className="text-sm text-gray-500 underline hover:text-blue-600">
            ← До панелі
          </Link>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          Помилка: {error}{' '}
          <button type="button" onClick={reload} className="font-medium underline">
            Спробувати ще
          </button>
        </div>
      )}

      {items === null ? (
        <p className="text-sm text-gray-500">Завантаження...</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
          <p className="text-gray-900">Повідомлень ще немає</p>
          <p className="mt-1 text-sm text-gray-500">
            Натисніть «Створити», щоб додати перше повідомлення.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((row) => (
            <li
              key={row.id}
              className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    row.is_active
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {row.is_active ? 'Active' : 'Inactive'}
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TYPE_BADGE[row.type]}`}
                >
                  {ANNOUNCEMENT_TYPE_META[row.type].label}
                </span>
                <span className="text-xs text-gray-400">
                  Порядок: {row.sort_order}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggle(row)}
                    disabled={busyId === row.id}
                    aria-pressed={row.is_active}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      row.is_active ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                    title={row.is_active ? 'Вимкнути' : 'Увімкнути'}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                        row.is_active ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(row)}
                    className="rounded px-2 py-1 text-sm text-blue-600 transition hover:bg-blue-50"
                  >
                    Редагувати
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(row)}
                    disabled={busyId === row.id}
                    className="rounded px-2 py-1 text-sm text-red-500 transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyId === row.id ? '...' : 'Видалити'}
                  </button>
                </div>
              </div>
              <p className="mt-2 font-semibold text-gray-900">{row.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-600">
                {row.message}
              </p>
            </li>
          ))}
        </ul>
      )}

      {(creating || editing !== null) && (
        <Modal title={editing ? 'Редагувати повідомлення' : 'Нове повідомлення'} onClose={closeModal}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draftValid) void save();
            }}
            className="space-y-4"
          >
            <div>
              <label htmlFor="ann-title" className="mb-1 block text-sm font-medium text-gray-700">
                Заголовок
              </label>
              <input
                id="ann-title"
                type="text"
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                maxLength={ANNOUNCEMENT_TITLE_MAX}
                required
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="ann-message" className="mb-1 block text-sm font-medium text-gray-700">
                Текст
              </label>
              <textarea
                id="ann-message"
                value={draft.message}
                onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
                maxLength={ANNOUNCEMENT_MESSAGE_MAX}
                rows={3}
                required
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="ann-type" className="mb-1 block text-sm font-medium text-gray-700">
                  Тип
                </label>
                <select
                  id="ann-type"
                  value={draft.type}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, type: e.target.value as AnnouncementType }))
                  }
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  {ANNOUNCEMENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {ANNOUNCEMENT_TYPE_META[t].label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ann-order" className="mb-1 block text-sm font-medium text-gray-700">
                  Порядок
                </label>
                <input
                  id="ann-order"
                  type="number"
                  min={0}
                  max={100000}
                  step={1}
                  value={draft.sortOrder}
                  onChange={(e) => setDraft((d) => ({ ...d, sortOrder: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeModal}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 transition hover:bg-gray-50"
              >
                Скасувати
              </button>
              <button
                type="submit"
                disabled={!draftValid || saving}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Зберігаємо...' : 'Зберегти'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
