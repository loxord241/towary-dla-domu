'use client';

import { useState, useEffect } from 'react';

type BaseEntity = { id: string; name: string; slug: string } | null;

type TranslationRow = {
  id: string;
  language_code: string;
  name: string;
  description: string | null;
  short_description?: string | null;
  base?: BaseEntity;
};

type EntityKey = 'categories' | 'products' | 'brands';

const ENTITIES: { key: EntityKey; title: string }[] = [
  { key: 'products', title: 'Товари' },
  { key: 'categories', title: 'Категорії' },
  { key: 'brands', title: 'Бренди' },
];

// Module-scope loader: receives callbacks instead of calling setState
// directly so that the effect below never calls setState synchronously.
async function loadTranslations(
  entity: EntityKey,
  onSuccess: (rows: TranslationRow[]) => void,
  onError: (message: string) => void,
  onDone: () => void
) {
  try {
    const response = await fetch(`/api/admin/translations/${entity}`);
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || `Не вдалося завантажити переклади: ${entity}`);
    }

    onSuccess((data?.translations as TranslationRow[]) ?? []);
  } catch (err) {
    onError(err instanceof Error ? err.message : 'Невідома помилка');
  } finally {
    onDone();
  }
}

function TranslationList({
  entityKey,
  title,
}: {
  entityKey: EntityKey;
  title: string;
}) {
  const [rows, setRows] = useState<TranslationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTranslations(
      entityKey,
      (data) => {
        if (!cancelled) setRows(data);
      },
      (message) => {
        if (!cancelled) setError(message);
      },
      () => {
        if (!cancelled) setLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [entityKey]);

  return (
    <div className="border rounded-lg p-4">
      <h2 className="text-xl font-semibold mb-3">{title}</h2>

      {loading && <p className="text-sm text-gray-500">Завантаження…</p>}
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-3 py-2 rounded text-sm" role="alert">
          {error}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-gray-500">Перекладів ще немає</p>
      )}

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {rows.map((row) => {
          const base = row.base ?? null;
          return (
            <div key={row.id} className="p-3 border rounded bg-gray-50">
              <div className="font-medium">{base ? base.name : '(видалений запис)'}</div>
              {base && <div className="text-xs text-gray-500">slug: {base.slug}</div>}
              <div>Lang: {row.language_code}</div>
              <div className="text-sm mt-1">Name: {row.name}</div>
              {row.short_description && (
                <div className="text-sm text-gray-600 mt-1">Short: {row.short_description}</div>
              )}
              {row.description && (
                <div className="text-sm text-gray-600 mt-1">Desc: {row.description}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function TranslationsPage() {
  return (
    <div className="p-4">
      <h1 className="mb-6 text-2xl font-bold tracking-tight text-gray-900">Переклади</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {ENTITIES.map((entity) => (
          <TranslationList key={entity.key} entityKey={entity.key} title={entity.title} />
        ))}
      </div>
    </div>
  );
}
