'use client';

import { useState } from 'react';
// Type-only import: erased at build time, no server module reaches the bundle.
import type {
  FieldTypeHistogram,
  YcCrossAnalysis,
  YcPreviewStats,
} from '@/app/lib/yugcontract/types';

type PreviewResponse = {
  generatedAt: string;
  durationMs: number;
  fieldTypes: FieldTypeHistogram;
  stats: YcPreviewStats;
  cross: YcCrossAnalysis;
};

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

export default function YugcontractAdminPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PreviewResponse | null>(null);

  async function loadPreview() {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const response = await fetch('/api/admin/yugcontract/preview');
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Не вдалося отримати прев’ю каталогу');
      }
      setData(payload as PreviewResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Yugcontract — прев’ю каталогу</h2>
        <p className="mt-1 text-gray-600">
          Лише читання: дані нашого магазину не змінюються. Отримує статистику
          повного фіду постачальника та порівнює її з наявним каталогом.{' '}
          <a href="/admin/yugcontract/categories" className="text-blue-600 underline">
            Дерево категорій →
          </a>
        </p>
      </div>

      <button
        onClick={loadPreview}
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition disabled:opacity-50"
      >
        {loading ? 'Завантаження (може тривати до хвилини)…' : 'Отримати прев’ю'}
      </button>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-red-700">
          {error}
        </div>
      )}

      {data && (
        <div className="space-y-8">
          <p className="text-sm text-gray-500">
            Згенеровано: {new Date(data.generatedAt).toLocaleString('uk-UA')} ·{' '}
            {(data.durationMs / 1000).toFixed(1)} с
          </p>

          <section>
            <h3 className="text-lg font-semibold mb-3">Загальна статистика фіду</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="Всього товарів" value={data.stats.totalProducts} />
              <StatCard label="Унікальних брендів" value={data.stats.uniqueBrands} />
              <StatCard label="Унікальних категорій" value={data.stats.uniqueCategories} />
              <StatCard
                label="Ціна (мін … макс)"
                value={
                  data.stats.minPrice === null
                    ? '—'
                    : `${data.stats.minPrice} … ${data.stats.maxPrice}`
                }
              />
              <StatCard label="В наявності (qty_main > 0)" value={data.stats.inStockCount} />
              <StatCard label="Немає (qty_main = 0)" value={data.stats.outOfStockCount} />
              <StatCard label="Невідома кількість" value={data.stats.unknownQtyCount} />
              <StatCard label="Без бренду" value={data.stats.noBrandCount} />
              <StatCard label="Без категорії" value={data.stats.noCategoryCount} />
              <StatCard
                label="Дублікатів id у фіді"
                value={data.stats.duplicateIds.length}
              />
            </div>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-3">
              Реальні типи полів API (перевірено на відповіді)
            </h3>
            <table className="min-w-full text-sm border">
              <thead className="bg-gray-100">
                <tr>
                  <th className="border px-3 py-2 text-left">Поле</th>
                  {Object.keys(data.fieldTypes.id ?? {}).map((t) => (
                    <th key={t} className="border px-3 py-2 text-left">{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.fieldTypes).map(([field, counts]) => (
                  <tr key={field}>
                    <td className="border px-3 py-2 font-mono">{field}</td>
                    {Object.entries(counts).map(([t, n]) => (
                      <td key={t} className="border px-3 py-2">{n}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="grid md:grid-cols-2 gap-8">
            <div>
              <h3 className="text-lg font-semibold mb-3">Приклади товарів</h3>
              <ul className="space-y-2 text-sm list-disc list-inside">
                {data.stats.productSamples.map((p) => (
                  <li key={p.externalId}>
                    [{p.externalId}] {p.nameUkr} — ціна {p.price ?? '—'} (RRP{' '}
                    {p.rrp ?? '—'}), qty_main {p.qtyMain ?? '—'}, бренд{' '}
                    {p.brand ?? '—'}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-3">Топ-категорії</h3>
              <ul className="space-y-1 text-sm list-disc list-inside">
                {data.stats.categorySamples.map((c, i) => (
                  <li key={`${c.catId}-${i}`}>
                    {c.catTop} → {c.cat2l ?? '—'} → {c.cat ?? '—'} (id:{' '}
                    {c.catId ?? '—'}, товарів: {c.productCount})
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="grid md:grid-cols-2 gap-8">
            <div>
              <h3 className="text-lg font-semibold mb-3">Топ-бренди</h3>
              <ul className="space-y-1 text-sm list-disc list-inside">
                {data.stats.brandSamples.map((b) => (
                  <li key={b.name}>
                    {b.name} — товарів: {b.productCount}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-3">Дублікати id (топ-20)</h3>
              {data.stats.duplicateIds.length === 0 ? (
                <p className="text-sm text-green-700">Дублікатів не виявлено.</p>
              ) : (
                <ul className="space-y-1 text-sm list-disc list-inside">
                  {data.stats.duplicateIds.map((d) => (
                    <li key={d.externalId}>
                      id {d.externalId} — повторень: {d.count}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-3">
              Порівняння з нашим каталогом ({data.cross.ourTotalProducts} товарів)
            </h3>
            <div className="space-y-4 text-sm">
              <div>
                <b>Збіги SKU (id або «YC-id»):</b> {data.cross.skuMatches.count}
                {data.cross.skuMatches.examples.length > 0 && (
                  <ul className="list-disc list-inside mt-1">
                    {data.cross.skuMatches.examples.map((m, i) => (
                      <li key={i}>
                        {m.sku} — {m.name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <b>Збіги за назвою:</b> {data.cross.nameMatches.count}
                {data.cross.nameMatches.examples.length > 0 && (
                  <ul className="list-disc list-inside mt-1">
                    {data.cross.nameMatches.examples.map((m, i) => (
                      <li key={i}>{m.ycName}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <b>Спільні бренди:</b> {data.cross.brandOverlap.count}{' '}
                {data.cross.brandOverlap.examples.length > 0 &&
                  `(${data.cross.brandOverlap.examples.map((b) => b.ycBrand).slice(0, 10).join(', ')})`}
              </div>
              <div>
                <b>Спільні категорії (за назвою):</b> {data.cross.categoryOverlap.count}{' '}
                {data.cross.categoryOverlap.examples.length > 0 &&
                  `(${data.cross.categoryOverlap.examples.map((c) => c.ycCategory).slice(0, 10).join(', ')})`}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
