'use client';

import { useMemo, useState } from 'react';
import type { Category } from '@/app/lib/catalog';
import {
  buildCategoryOptions,
  compareCategories,
  filterCategoryOptions,
} from '@/app/lib/category-tree';

/**
 * Admin multi-select for a product's DIRECT category assignments.
 *
 * The checkboxes are independent on purpose: product_categories stores
 * direct links only, so checking «Побутова техніка» does NOT check its
 * children (parents are resolved through the tree at read time). Search
 * always runs against the FULL option set; duplicate names stay
 * distinguishable via their root→leaf path labels.
 */
export default function AdminCategoryMultiSelect({
  categories,
  selectedIds,
  onChange,
}: {
  categories: Category[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');

  const options = useMemo(() => buildCategoryOptions(categories), [categories]);
  const filtered = useMemo(
    () => filterCategoryOptions(options, query),
    [options, query]
  );

  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  // Chips ordered by the shared commercial comparator.
  const selected = useMemo(
    () =>
      selectedIds
        .map((id) => byId.get(id))
        .filter((c): c is Category => Boolean(c))
        .sort(compareCategories),
    [byId, selectedIds]
  );

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div>
      {selected.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1" aria-label="Вибрані категорії">
          {selected.map((c) => {
            const label = options.find((o) => o.id === c.id)?.label ?? c.name;
            return (
              <li
                key={c.id}
                className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-800"
              >
                <span title={label}>{c.name}</span>
                <button
                  type="button"
                  aria-label={`Видалити ${label}`}
                  onClick={() => toggle(c.id)}
                  className="text-blue-600 hover:text-blue-900"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="relative mb-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Пошук категорій для товару"
          placeholder="Пошук категорій…"
          className="input w-full"
        />
      </div>

      {query !== '' && (
        <p className="sr-only">
          Показано результати пошуку по всіх категоріях: {filtered.length}
        </p>
      )}

      <ul className="max-h-56 overflow-y-auto rounded border border-gray-200 p-1" aria-label="Дерево категорій">
        {filtered.map((option) => (
          <li key={option.id}>
            <label
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50"
              style={{ paddingLeft: `${8 + option.depth * 16}px` }}
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(option.id)}
                onChange={() => toggle(option.id)}
                aria-describedby={`cat-path-${option.id}`}
              />
              <span>{option.name}</span>
              {/* Full branch path keeps same-name categories distinguishable */}
              <span id={`cat-path-${option.id}`} className="sr-only">
                {option.path.join(' → ')}
              </span>
              <span className="sr-only">{option.label}</span>
            </label>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="px-3 py-3 text-sm text-gray-500">Нічого не знайдено</li>
        )}
      </ul>
    </div>
  );
}
