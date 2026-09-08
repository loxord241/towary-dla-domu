'use client';

import { useMemo, useState } from 'react';
import type { Category } from '@/app/lib/catalog';
import type { CategoryOption } from '@/app/lib/category-tree';
import {
  buildCategoryOptions,
  filterCategoryOptions,
} from '@/app/lib/category-tree';
import FilterCombobox, { type ComboboxOption } from './FilterCombobox';

/**
 * Searchable COLLAPSIBLE category tree for the catalog filters.
 *
 * 2026-09-08 refactor: the trigger/panel/search/animation mechanics and
 * the whole a11y+keyboard contract moved into the shared FilterCombobox
 * (the same component now powers the brand filter). This file stays as the
 * thin adapter owning only the category-specific semantics:
 *  - hierarchy via buildCategoryOptions (paths disambiguate duplicates);
 *  - roots render collapsed («▸»), the arrow expands/collapses children
 *    without selecting, and clicking a NAME selects that category
 *    (parents and children are equally selectable);
 *  - visibility rule: an EMPTY search honors the collapsed state; any
 *    search reveals the full tree (search must always reach every
 *    category);
 *  - the selection value stays the category slug (URL `category=...`
 *    compatibility untouched).
 */
export default function CategorySelect({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  /** selected category slug ('' = all categories) */
  value?: string;
  onChange: (slug: string) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // Children presence is derived from the input set (no extra state).
  const hasChildren = useMemo(() => {
    const ids = new Set(categories.map((c) => c.id));
    const set = new Set<string>();
    for (const c of categories) {
      if (c.parent_id && ids.has(c.parent_id)) set.add(c.parent_id);
    }
    return set;
  }, [categories]);

  // Full-tree list (ignores collapse): drives the trigger label so a
  // selection hidden inside a collapsed branch still displays its path,
  // and feeds the search path (any query bypasses collapsing).
  const allOptions = useMemo(
    () => buildCategoryOptions(categories),
    [categories]
  );

  const selected = useMemo(
    () => allOptions.find((c) => c.slug === value),
    [allOptions, value]
  );

  const toComboboxOption = (option: CategoryOption): ComboboxOption => ({
    value: option.slug,
    label: option.label,
    name: option.name,
    depth: option.depth,
    // Deep rows keep their ancestor path in the accessibility tree.
    srPrefix:
      option.depth > 0
        ? `${option.path.slice(0, -1).join(' → ')} →`
        : undefined,
    expandable: hasChildren.has(option.id),
    expanded: expandedIds.has(option.id),
    onToggleExpand: (expand) =>
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (expand) next.add(option.id);
        else next.delete(option.id);
        return next;
      }),
  });

  // Options provider for FilterCombobox: an EMPTY query honors the
  // collapsed state; any query searches the FULL tree via path matching.
  const optionsFor = (query: string): ComboboxOption[] =>
    query.trim() === ''
      ? buildCategoryOptions(categories, { expanded: expandedIds }).map(
          toComboboxOption
        )
      : filterCategoryOptions(allOptions, query).map(toComboboxOption);

  return (
    <FilterCombobox
      idPrefix="category"
      label="Категорія"
      listLabel="Категорії"
      allLabel="Всі категорії"
      searchPlaceholder="Пошук категорій..."
      options={optionsFor}
      value={value ?? ''}
      onChange={onChange}
      selectedOption={selected ? toComboboxOption(selected) : undefined}
    />
  );
}
