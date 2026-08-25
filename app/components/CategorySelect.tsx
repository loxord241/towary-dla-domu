'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Category } from '@/app/lib/catalog';
import {
  buildCategoryOptions,
  filterCategoryOptions,
} from '@/app/lib/category-tree';
import { ChevronDownIcon, SearchIcon } from './icons';

/**
 * Searchable hierarchical category picker for the catalog filters.
 * Replaces the ~205-option native select element: options render as a tree
 * («ПОБУТОВА ТЕХНІКА → Блендери») so duplicate branch names stay
 * distinguishable, and the search field filters the FULL option set.
 *
 * Accessibility contract: the trigger is a button with aria-expanded/
 * aria-controls/aria-haspopup; the list is role="listbox" with
 * role="option" children tracked via aria-activedescendant. Opening moves
 * focus to the search field; Escape (and any selection) closes and returns
 * focus to the trigger; ArrowDown/ArrowUp move the active option with
 * clamping and Enter selects it — fully keyboard operable, no mouse
 * required anywhere.
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

  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // The full option set is derived once per categories payload — search
  // always runs against ALL categories, never a rendered subset.
  const options = useMemo(() => buildCategoryOptions(categories), [categories]);
  const filtered = useMemo(
    () => filterCategoryOptions(options, query),
    [options, query]
  );

  const selected = options.find((o) => o.slug === value);

  // Active index must always point at a rendered option, even right after
  // the filtered set shrinks — derived clamp instead of effect-based reset.
  const activeIndex = Math.min(rawActiveIndex, Math.max(filtered.length - 1, 0));

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
      setRawActiveIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setRawActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = filtered[activeIndex];
      if (option) {
        commitAndClose();
        onChange(option.slug);
      }
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
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
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
              id="category-opt-all"
              role="option"
              aria-selected={!value}
            >
              <button
                type="button"
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
            {filtered.map((option, index) => (
              <li
                key={option.id}
                id={`category-opt-${index}`}
                role="option"
                aria-selected={value === option.slug}
              >
                <button
                  type="button"
                  onClick={() => {
                    commitAndClose();
                    onChange(option.slug);
                  }}
                  onMouseMove={() => setRawActiveIndex(index)}
                  title={option.label}
                  className={`w-full py-2 pr-3 text-left text-sm hover:bg-gray-50 ${
                    index === activeIndex ? 'bg-gray-50' : ''
                  } ${value === option.slug ? 'font-semibold text-blue-700' : 'text-gray-700'}`}
                  style={{ paddingLeft: `${12 + option.depth * 16}px` }}
                >
                  {option.depth > 0 && (
                    <span className="sr-only">
                      {option.path.slice(0, -1).join(' → ')} →{' '}
                    </span>
                  )}
                  <span className={option.depth > 0 ? '' : 'font-medium'}>
                    {/* Full path in title; sr-only branch context for duplicates */}
                    {option.name}
                  </span>
                </button>
              </li>
            ))}
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
