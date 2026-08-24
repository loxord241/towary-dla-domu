'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
// Type-only import: erased at build time, no server module reaches the bundle.
import type {
  YcCategoryStats,
  YcCategoryTreeNode,
  YcDetectedFields,
} from '@/app/lib/yugcontract/types';

interface CategoriesResponse {
  generatedAt: string;
  durationMs: number;
  detected: {
    arrayPath: string | null;
    fields: YcDetectedFields;
    rawSample: Record<string, unknown>[];
  };
  stats: YcCategoryStats;
  tree: YcCategoryTreeNode[];
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function TreeNode({ node, depth }: { node: YcCategoryTreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;

  return (
    <li className="leading-relaxed">
      <div className="flex items-center gap-2">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="w-5 h-5 flex items-center justify-center rounded border text-xs hover:bg-gray-100"
          >
            {open ? '−' : '+'}
          </button>
        ) : (
          <span className="w-5 h-5" />
        )}
        <span className="font-mono text-xs text-gray-500">[{node.externalId}]</span>
        <span>{node.name || '— (без назви) —'}</span>
        {hasChildren && (
          <span className="text-xs text-gray-400">({node.children.length})</span>
        )}
      </div>
      {hasChildren && open && (
        <ul className="ml-6 border-l pl-3">
          {node.children.map((child) => (
            <TreeNode key={child.externalId} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function YugcontractCategoriesPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CategoriesResponse | null>(null);
  const [query, setQuery] = useState('');

  // Search runs client-side over the already-loaded tree and keeps the
  // full ancestor chain of every match so hierarchy stays readable.
  const filteredTree = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    if (needle === '') return data.tree;

    const filterNode = (
      node: YcCategoryTreeNode
    ): YcCategoryTreeNode | null => {
      const kept = node.children
        .map(filterNode)
        .filter((c): c is YcCategoryTreeNode => c !== null);
      const self =
        node.name.toLowerCase().includes(needle) ||
        node.externalId.toLowerCase().includes(needle);
      if (self || kept.length > 0) return { ...node, children: kept };
      return null;
    };
    return data.tree
      .map(filterNode)
      .filter((n): n is YcCategoryTreeNode => n !== null);
  }, [data, query]);

  async function loadCategories() {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const response = await fetch('/api/admin/yugcontract/categories');
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Не вдалося отримати категорії');
      }
      setData(payload as CategoriesResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Невідома помилка');
    } finally {
      setLoading(false);
    }
  }

  const matchCount = useMemo(() => {
    let count = 0;
    const walk = (nodes: YcCategoryTreeNode[]) => {
      for (const n of nodes) {
        count += 1;
        walk(n.children);
      }
    };
    walk(filteredTree);
    return count;
  }, [filteredTree]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">
          Yugcontract — дерево категорій (get-categories)
        </h2>
        <p className="mt-1 text-gray-600">
          Лише читання: наш каталог не змінюється. Ієрархія cat_top → cat_2l → cat
          будується з відповіді постачальника.{' '}
          <Link href="/admin/yugcontract" className="text-blue-600 underline">
            До прев’ю товарів
          </Link>
        </p>
      </div>

      <button
        onClick={loadCategories}
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition disabled:opacity-50"
      >
        {loading ? 'Завантаження…' : 'Отримати категорії'}
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
            {(data.durationMs / 1000).toFixed(1)} с · масив у відповіді:{' '}
            <code>{data.detected.arrayPath ?? '—'}</code>
          </p>

          <section>
            <h3 className="text-lg font-semibold mb-3">Статистика</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="Всього категорій" value={data.stats.totalNodes} />
              <StatCard label="Кореневих (рівень 0)" value={data.stats.rootCount} />
              <StatCard label="Максимальна глибина" value={data.stats.maxDepth} />
              <StatCard label="Сиріт (батько невідомий)" value={data.stats.orphanCount} />
            </div>
            <p className="mt-3 text-sm text-gray-600">
              За рівнями:{' '}
              {Object.entries(data.stats.levelCounts)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([level, count]) => `L${level}: ${count}`)
                .join(' · ') || '—'}
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-3">
              Визначені поля відповіді API
            </h3>
            <p className="text-sm text-gray-700">
              ID: <code>{data.detected.fields.id ?? '—'}</code> · Назва:{' '}
              <code>{data.detected.fields.name ?? '—'}</code> · Батько:{' '}
              <code>{data.detected.fields.parent ?? '—'}</code>
            </p>
            {data.detected.rawSample.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-blue-600">
                  Сирі приклади рядків ({data.detected.rawSample.length})
                </summary>
                <pre className="mt-2 overflow-auto rounded bg-gray-900 p-3 text-xs text-green-200">
                  {JSON.stringify(data.detected.rawSample, null, 2)}
                </pre>
              </details>
            )}
          </section>

          <section>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <h3 className="text-lg font-semibold">Дерево категорій</h3>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Пошук за назвою або ID…"
                className="border rounded px-3 py-1.5 text-sm w-64"
              />
              {query.trim() !== '' && (
                <span className="text-sm text-gray-500">
                  Знайдено гілок разом із предками: {matchCount}
                </span>
              )}
            </div>
            {filteredTree.length === 0 ? (
              <p className="text-sm text-gray-500">Нічого не знайдено.</p>
            ) : (
              <ul className="text-sm">
                {filteredTree.map((root) => (
                  <TreeNode key={root.externalId} node={root} depth={0} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
