'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SearchIcon,
} from './icons';

/**
 * A single option row of the FilterCombobox listbox.
 */
export interface ComboboxOption {
  /** value reported to onChange (category/brand slug; never '') */
  value: string;
  /** full disambiguated label (trigger text, title tooltip, search) */
  label: string;
  /** short visible row text; defaults to label (categories: leaf name) */
  name?: string;
  /** visible secondary line under the label (flat lists) */
  hint?: string;
  /** screen-reader-only context prepended to the row (ancestor path) */
  srPrefix?: string;
  /** row indentation depth (tree rendering); 0/undefined = flat */
  depth?: number;
  /** the row carries a separate expand/collapse toggle (tree parents) */
  expandable?: boolean;
  expanded?: boolean;
  /** toggle handler; the argument is the REQUESTED next state so the
      keyboard (Right = expand, Left = collapse) and the pointer click
      both stay exact */
  onToggleExpand?: (expand: boolean) => void;
}

/**
 * Shared searchable combobox for the catalog filters (2026-09-08).
 *
 * ONE trigger + absolute panel implementation powering BOTH filter
 * dropdowns: the category tree (CategorySelect, collapsible via the option
 * extension fields) and the flat brand list (CatalogFilters) — replacing
 * the native brand <select> whose huge unsearchable list opened a
 * full-screen system picker on phones.
 *
 * Unified panel look: rounded-xl bordered panel with shadow-lg, sticky
 * search input on top (.input style), scrollable list with hover
 * highlight, the selected row in blue with a check mark, and a first reset
 * row (value '') labelled `allLabel` («Всі категорії» / «Всі бренди»).
 * The panel is absolute + w-full inside the filter's relative container,
 * so inside the mobile sheet it opens as a full-width block of the sheet
 * (no system picker, no off-sheet popup). Touch targets are ≥40px tall.
 *
 * Animation: entry is the globals.css `.dropdown-in` class with a
 * motion-reduce opt-out; EXIT stays instant (unmount), consistent with the
 * modals. The panel is absolutely positioned and the keyframes are
 * transform/opacity-only → CLS stays 0.
 *
 * Options: pass an ARRAY (the combobox filters it by label itself) or a
 * selector FUNCTION receiving the raw query and returning the FINAL list —
 * the category tree uses that to keep collapse-aware visibility plus
 * full-path search on its side without leaking tree state in here.
 *
 * Accessibility contract (inherited verbatim from the pre-refactor
 * CategorySelect): trigger = button with aria-expanded/aria-controls/
 * aria-haspopup; list = role="listbox" with role="option" children tracked
 * via aria-activedescendant; expand arrows are separate buttons with
 * aria-expanded/aria-controls; ArrowDown/Up move the active option,
 * ArrowRight/Left expand/collapse it, Enter selects, Escape closes and
 * refocuses the trigger. Opening moves focus to the search field.
 */
export default function FilterCombobox({
  idPrefix,
  label,
  listLabel,
  allLabel,
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyMessage = 'Нічого не знайдено',
  selectedOption,
}: {
  /** DOM id namespace: `${idPrefix}-listbox`, `${idPrefix}-opt-N`, ... */
  idPrefix: string;
  /** trigger accessible-name prefix: «Категорія» / «Бренд» */
  label: string;
  /** listbox accessible name («Категорії» / «Бренди»); defaults to label */
  listLabel?: string;
  /** first reset row (value ''): «Всі категорії» / «Всі бренди» */
  allLabel: string;
  options: ComboboxOption[] | ((query: string) => ComboboxOption[]);
  /** selected value ('' = reset row) */
  value: string;
  onChange: (value: string) => void;
  /** trigger text when nothing is selected; defaults to allLabel */
  placeholder?: string;
  /** search input placeholder AND accessible name */
  searchPlaceholder: string;
  emptyMessage?: string;
  /**
   * Pre-resolved selected option for the trigger label — needed when the
   * selection is hidden from the rendered list by collapse/filtering
   * (category deep inside a collapsed branch). Defaults to a lookup in
   * the provided options.
   */
  selectedOption?: ComboboxOption;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rawActiveIndex, setRawActiveIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const isSelector = typeof options === 'function';
  // Selector form: the provider returns the FINAL list (the category tree
  // keeps collapse-aware visibility + path search on its side).
  const provided = useMemo(
    () => (isSelector ? options(query) : options),
    [isSelector, options, query]
  );
  // Array form: default label filtering — the needle matches anywhere in
  // the full (disambiguated) label, case-insensitively.
  const filtered = useMemo(() => {
    if (isSelector) return provided;
    const needle = query.trim().toLowerCase();
    if (needle === '') return provided;
    return provided.filter((o) => o.label.toLowerCase().includes(needle));
  }, [isSelector, provided, query]);

  const selected = selectedOption ?? provided.find((o) => o.value === value);
  const triggerText = selected ? selected.label : (placeholder ?? allLabel);

  // Tree lists align leaf names with parent names via a spacer where the
  // expand toggle would sit; flat lists (brands) get no dead space.
  const isTreeList = filtered.some((o) => o.expandable);

  // Keyboard navigation covers the reset row too: activeIndex 0 is that
  // row, activeIndex n>0 is filtered[n-1]. The derived clamp keeps the
  // index pointing at a rendered option even right after the filtered
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
  // then reports the value to the parent draft state.
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
        onChange(option.value);
      }
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (activeIndex === 0) return;
      const option = filtered[activeIndex - 1];
      if (!option?.expandable || !option.onToggleExpand) return;
      option.onToggleExpand(e.key === 'ArrowRight');
    }
  };

  // Keep the active option visible while navigating with the keyboard.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`#${idPrefix}-opt-${activeIndex}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, filtered.length, idPrefix]);

  return (
    <div className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${label}: ${triggerText}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${idPrefix}-listbox` : undefined}
        onClick={() => {
          // Reset the search + active row on every fresh open (event-driven,
          // not effect-driven, per the react-hooks lint rules).
          setQuery('');
          setRawActiveIndex(0);
          setOpen((o) => !o);
        }}
        className="input flex min-h-[40px] w-full cursor-pointer items-center justify-between gap-2 text-left"
      >
        <span className={`truncate ${selected ? '' : 'text-gray-500'}`}>
          {triggerText}
        </span>
        <ChevronDownIcon
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="dropdown-in motion-reduce:animate-none absolute z-20 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg">
          {/* One scroll container: the sticky search stays pinned while the
              option list (and scrollIntoView) scrolls underneath it. */}
          <div className="max-h-80 overflow-y-auto">
            <div className="sticky top-0 z-10 border-b border-gray-100 bg-white p-2">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setRawActiveIndex(0);
                  }}
                  aria-label={searchPlaceholder}
                  placeholder={searchPlaceholder}
                  className="input min-h-[40px] pl-9"
                />
              </div>
            </div>

            <ul
              ref={listRef}
              id={`${idPrefix}-listbox`}
              role="listbox"
              aria-label={listLabel ?? label}
              aria-activedescendant={`${idPrefix}-opt-${activeIndex}`}
              className="py-1"
            >
              <li
                id={`${idPrefix}-opt-0`}
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
                  className={`flex min-h-[40px] w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                    !value ? 'font-semibold text-blue-700' : 'text-gray-700'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{allLabel}</span>
                  {!value && <CheckIcon className="h-4 w-4 shrink-0" />}
                </button>
              </li>
              {filtered.map((option, index) => {
                const canExpand = !!option.expandable;
                const isOpen = !!option.expanded;
                const row = index + 1;
                return (
                  <li
                    key={option.value}
                    id={`${idPrefix}-opt-${row}`}
                    role="option"
                    aria-selected={value === option.value}
                  >
                    <div
                      className={`flex items-center pr-2 ${row === activeIndex ? 'bg-gray-50' : ''}`}
                      style={{ paddingLeft: `${12 + (option.depth ?? 0) * 16}px` }}
                    >
                      {/* Nested list anchor lives outside the option button
                          flow but inside the li for DOM locality of
                          aria-controls. */}
                      {canExpand && (
                        <span
                          id={`${idPrefix}-kids-${row}`}
                          hidden
                          aria-hidden="true"
                        />
                      )}
                      {canExpand && (
                        <button
                          type="button"
                          aria-label={`${option.name ?? option.label}: розгорнути/згорнути`}
                          aria-expanded={isOpen}
                          aria-controls={isOpen ? `${idPrefix}-kids-${row}` : undefined}
                          tabIndex={-1}
                          onMouseMove={() => setRawActiveIndex(row)}
                          onClick={() => option.onToggleExpand?.(!isOpen)}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded hover:bg-gray-200"
                        >
                          <ChevronRightIcon
                            className={`h-3.5 w-3.5 text-gray-500 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                          />
                        </button>
                      )}
                      {!canExpand && isTreeList && (
                        <span className="w-10 shrink-0" aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        onMouseMove={() => setRawActiveIndex(row)}
                        title={option.label}
                        onClick={() => {
                          commitAndClose();
                          onChange(option.value);
                        }}
                        className={`flex min-h-[40px] flex-1 items-center gap-2 py-2 pr-1 text-left text-sm hover:bg-gray-50 ${
                          value === option.value
                            ? 'font-semibold text-blue-700'
                            : 'text-gray-700'
                        }`}
                      >
                        {option.srPrefix && (
                          <span className="sr-only">{option.srPrefix} </span>
                        )}
                        <span
                          className={`min-w-0 flex-1 truncate ${
                            (option.depth ?? 0) > 0 ? '' : 'font-medium'
                          }`}
                        >
                          {option.name ?? option.label}
                        </span>
                        {option.hint && (
                          <span className="shrink-0 text-xs text-gray-500">
                            {option.hint}
                          </span>
                        )}
                        {value === option.value && (
                          <CheckIcon className="h-4 w-4 shrink-0" />
                        )}
                      </button>
                    </div>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-3 py-3 text-sm text-gray-500" aria-live="polite">
                  {emptyMessage}
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
