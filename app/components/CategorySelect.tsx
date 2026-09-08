'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Category } from '@/app/lib/catalog';
import {
  buildCategoryOptions,
  filterCategoryOptions,
} from '@/app/lib/category-tree';
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from './icons';

/**
 * Searchable COLLAPSIBLE category tree for the catalog filters.
 * Replaces the ~205-option flat list: roots render collapsed («▸»), the
 * arrow expands/collapses children without selecting, and clicking a NAME
 * selects that category (parents and children are equally selectable).
 * Duplicate names stay distinguishable via their root→leaf path.
 *
 * Accessibility contract: trigger = button with aria-expanded/aria-controls/
 * aria-haspopup; list = role="listbox" with role="option" children tracked
 * via aria-activedescendant; toggle arrows are separate buttons with
 * aria-expanded/aria-controls; ArrowDown/Up move the active option,
 * ArrowRight/Left expand/collapse it; Enter selects; Escape closes and
 * refocuses the trigger. Opening moves focus to the search field.
 *
 * Visibility rule: an EMPTY search honors the collapsed state; any search
 * reveals the full tree (search must always reach every category).
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rawActiveIndex, setRawActiveIndex] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Full tree walk once per payload; `expanded` hides unexpanded branches.
  const options = useMemo(
    () => buildCategoryOptions(categories, { expanded: expandedIds }),
    [categories, expandedIds]
  );
  // Any query bypasses collapsing — search reaches the FULL set.
  const searchable = useMemo(
    () =>
      query.trim() === ''
        ? options
        : buildCategoryOptions(categories),
    [categories, options, query]
  );
  const filtered = useMemo(
    () => filterCategoryOptions(searchable, query),
    [searchable, query]
  );

  // Children presence is derived from the input set (no extra state).
  const hasChildren = useMemo(() => {
    const ids = new Set(categories.map((c) => c.id));
    const set = new Set<string>();
    for (const c of categories) {
      if (c.parent_id && ids.has(c.parent_id)) set.add(c.parent_id);
    }
    return set;
  }, [categories]);

  // Full-tree list (ignores collapse) drives the trigger label so a
  // selection hidden inside a collapsed branch still displays its path.
  const allOptions = useMemo(() => buildCategoryOptions(categories), [categories]);

  const selected = useMemo(
    () => allOptions.find((c) => c.slug === value),
    [allOptions, value]
  );

  // Keyboard navigation covers the «Всі категорії» row too: activeIndex 0
  // is that row, activeIndex n>0 is filtered[n-1]. The derived clamp keeps
  // the index pointing at a rendered option even right after the filtered
  // set shrinks (no effect-based reset).
  const activeIndex = Math.min(rawActiveIndex, filtered.length);

  useEffect(() => {
    if (!open) return;
    // Move focus into the panel so keyboard users land in the search field.
    searchInputRef.current?.focus();
  }, [open]);

  // Close on outside pointer down (selection/Escape handle the rest).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const rootEl = triggerRef.current?.parentElement;
      if (rootEl && !rootEl.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // Every selection closes first (so focus lands back on the trigger),
  // then reports the slug to the parent draft state.
  const commitAndClose = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      commitAndClose();
      return;
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setRawActiveIndex((i) => Math.min(i + 1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setRawActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex === 0) {
        commitAndClose();
        onChange('');
        return;
      }
      const option = filtered[activeIndex - 1];
      if (option) {
        commitAndClose();
        onChange(option.slug);
      }
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (activeIndex === 0) return;
      const option = filtered[activeIndex - 1];
      if (!option || !hasChildren.has(option.id)) return;
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (e.key === 'ArrowRight') next.add(option.id);
        else next.delete(option.id);
        return next;
      });
    }
  };

  // Keep the active option visible while navigating with the keyboard.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`#category-opt-${activeIndex}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, filtered.length]);

  return (
    <div className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Категорія: ${selected ? selected.label : 'Всі категорії'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? 'category-listbox' : undefined}
        onClick={() => {
          // Reset the search + active row on every fresh open (event-driven,
          // not effect-driven, per the react-hooks lint rules).
          setQuery('');
          setRawActiveIndex(0);
          setOpen((o) => !o);
        }}
        className="input flex w-full cursor-pointer items-center justify-between gap-2 text-left"
      >
        <span className={`truncate ${selected ? '' : 'text-gray-500'}`}>
          {selected ? selected.label : 'Всі категорії'}
        </span>
        <ChevronDownIcon
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="dropdown-in motion-reduce:animate-none absolute z-20 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="relative border-b border-gray-100 p-2">
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setRawActiveIndex(0);
              }}
              aria-label="Пошук категорій"
              placeholder="Пошук категорій..."
              className="input pl-9"
            />
          </div>

          <ul
            ref={listRef}
            id="category-listbox"
            role="listbox"
            aria-label="Категорії"
            aria-activedescendant={`category-opt-${activeIndex}`}
            className="max-h-72 overflow-y-auto py-1"
          >
            <li
              id="category-opt-0"
              role="option"
              aria-selected={!value}
              className={activeIndex === 0 ? 'bg-gray-50' : ''}
            >
              <button
                type="button"
                onMouseMove={() => setRawActiveIndex(0)}
                onClick={() => {
                  commitAndClose();
                  onChange('');
                }}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                  !value ? 'font-semibold text-blue-700' : 'text-gray-700'
                }`}
              >
                Всі категорії
              </button>
            </li>
            {filtered.map((option, index) => {
              const canExpand = hasChildren.has(option.id);
              const isOpen = expandedIds.has(option.id);
              const row = index + 1;
              return (
                <li
                  key={option.id}
                  id={`category-opt-${row}`}
                  role="option"
                  aria-selected={value === option.slug}
                >
                  {/* Nested list lives outside the option button flow but
                      inside the li for DOM locality of aria-controls. */}
                  <div
                    className={`flex items-center pr-2 ${row === activeIndex ? 'bg-gray-50' : ''}`}
                    style={{ paddingLeft: `${12 + option.depth * 16}px` }}
                  >
                    {canExpand && (
                      <span
                        id={`category-kids-${row}`}
                        hidden
                        aria-hidden="true"
                      />
                    )}
                    <button
                      type="button"
                      aria-label={`${option.name}: розгорнути/згорнути`}
                      aria-expanded={canExpand ? isOpen : undefined}
                      aria-controls={isOpen ? `category-kids-${row}` : undefined}
                      tabIndex={-1}
                      onMouseMove={() => setRawActiveIndex(row)}
                      onClick={() => {
                        if (!canExpand) return;
                        setExpandedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(option.id)) next.delete(option.id);
                          else next.add(option.id);
                          return next;
                        });
                      }}
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded ${
                        canExpand ? 'hover:bg-gray-200' : ''
                      }`}
                    >
                      {canExpand ? (
                        <ChevronRightIcon
                          className={`h-3.5 w-3.5 text-gray-500 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                        />
                      ) : (
                        <span className="w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onMouseMove={() => setRawActiveIndex(row)}
                      title={option.label}
                      onClick={() => {
                        commitAndClose();
                        onChange(option.slug);
                      }}
                      className={`flex-1 py-2 pr-1 text-left text-sm hover:bg-gray-50 ${
                        value === option.slug ? 'font-semibold text-blue-700' : 'text-gray-700'
                      }`}
                    >
                      {option.depth > 0 && (
                        <span className="sr-only">
                          {option.path.slice(0, -1).join(' → ')} →{' '}
                        </span>
                      )}
                      <span className={option.depth > 0 ? '' : 'font-medium'}>
                        {option.name}
                      </span>
                    </button>
                  </div>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-3 text-sm text-gray-500" aria-live="polite">
                Нічого не знайдено
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
