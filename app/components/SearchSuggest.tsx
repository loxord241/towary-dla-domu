'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { SearchIcon } from './icons';
import { formatPrice } from '@/app/lib/format';
import {
  fetchSearchSuggest,
  SUGGEST_DEBOUNCE_MS,
  SUGGEST_MIN_QUERY_LENGTH,
  type SuggestItem,
} from '@/app/lib/search-suggest';

/**
 * Header search input WITH autocomplete suggestions (owner task
 * 2026-09-11). Renders the same <input name="q"> + submit button the
 * plain GET form in SiteHeader always had — the form itself stays a
 * server component, so searching still works with JavaScript disabled
 * (progressive enhancement); this island only ADDS the live dropdown.
 *
 * Behaviour:
 *  - debounce SUGGEST_DEBOUNCE_MS per keystroke, then GET
 *    /api/search/suggest (same-origin, CSP connect-src 'self'). Every
 *    request is time-bounded inside fetchSearchSuggest (never-stuck
 *    contract, lib/cart-preview.ts pattern); superseded responses are
 *    dropped by a sequence guard. Suggestions never break typing: any
 *    failure just keeps the dropdown closed.
 *  - dropdown: absolute within the header form, entrance via the shared
 *    globals.css `dropdown-in` keyframes (transform/opacity-only, CLS 0)
 *    with motion-reduce:animate-none; instant exit (unmount).
 *  - keyboard: ↑/↓ move the active row, Enter follows the active row,
 *    Escape closes; focus stays on the input (aria-activedescendant).
 *  - click/Enter on a suggestion navigates to /catalog?q=<name> — the
 *    catalog search stays the single entry point (owner decision); the
 *    DB query already guarantees the suggestion is active + has a photo,
 *    so hidden products can never be suggested.
 *  - closes on Escape, outside pointer-down and blur to outside.
 */
export default function SearchSuggest({
  defaultValue,
}: {
  defaultValue?: string;
}) {
  const router = useRouter();
  const listboxId = useId();

  const rootRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);
  const disposedRef = useRef(false);

  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SuggestItem[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  // The dropdown is visible only while the term is long enough to search —
  // a derived flag (no setState in the effect body) also hides stale items
  // during the debounce window after the query shrinks.
  const termReady = query.trim().length >= SUGGEST_MIN_QUERY_LENGTH;
  const listOpen = open && termReady;

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      seqRef.current += 1; // in-flight responses must not setState after unmount
    };
  }, []);

  // Debounced suggest fetch. The short-term short-circuit runs INSIDE the
  // timer (setState in the effect body is a cascading-render smell);
  // abort-on-supersede is replaced by the seq guard — stale responses land
  // after this effect moved on and are ignored, and each request is bounded
  // by its own timeout (never-stuck contract).
  useEffect(() => {
    const timer = setTimeout(() => {
      const term = query.trim();
      if (term.length < SUGGEST_MIN_QUERY_LENGTH) {
        setItems([]);
        setActiveIndex(-1);
        setOpen(false);
        return;
      }
      const seq = ++seqRef.current;
      void fetchSearchSuggest(term).then((rows) => {
        if (disposedRef.current || seq !== seqRef.current) return;
        setItems(rows);
        setActiveIndex(-1);
        setOpen(rows.length > 0);
      });
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Close on outside pointer-down (selection/Escape/blur handle the rest).
  useEffect(() => {
    if (!listOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [listOpen]);

  /** Follow a suggestion: the catalog search view for its full name. */
  const followSuggestion = (item: SuggestItem) => {
    setOpen(false);
    router.push(`/catalog?q=${encodeURIComponent(item.name)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (listOpen) {
        // Keep the typed text — the user is refining, not clearing.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length === 0 || !termReady) return;
      if (!listOpen) {
        // Re-open the cached suggestions without refetching.
        setOpen(true);
        return;
      }
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!listOpen) return;
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
      return;
    }
    if (e.key === 'Enter' && listOpen && activeIndex >= 0) {
      const item = items[activeIndex];
      if (item) {
        // No native submit: the suggestion IS the search (same /catalog?q=
        // target the form would produce, owner decision).
        e.preventDefault();
        followSuggestion(item);
      }
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <input
        type="search"
        name="q"
        id="site-search-input"
        aria-label="Пошук"
        placeholder="Пошук товарів..."
        defaultValue={defaultValue}
        autoComplete="off"
        role="combobox"
        aria-expanded={listOpen}
        aria-controls={listOpen ? listboxId : undefined}
        aria-activedescendant={
          listOpen && activeIndex >= 0
            ? `${listboxId}-opt-${activeIndex}`
            : undefined
        }
        aria-autocomplete="list"
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (
            !rootRef.current ||
            !rootRef.current.contains(e.relatedTarget as Node | null)
          ) {
            setOpen(false);
          }
        }}
        className="w-full text-base px-4 py-2 pr-12 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      <button
        type="submit"
        aria-label="Шукати"
        className="absolute right-0.5 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 items-center justify-center text-gray-400 hover:text-blue-600"
      >
        <SearchIcon className="h-5 w-5" />
      </button>

      {listOpen && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Пропозиції пошуку"
          className="dropdown-in motion-reduce:animate-none absolute left-0 right-0 top-full z-30 mt-1 max-h-96 overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg"
        >
          {items.map((item, index) => (
            <li
              key={item.slug}
              id={`${listboxId}-opt-${index}`}
              role="option"
              aria-selected={index === activeIndex}
            >
              <button
                type="button"
                // Keep focus on the input (a native mousedown would blur it
                // and close the dropdown before the click lands).
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => followSuggestion(item)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                  index === activeIndex ? 'bg-gray-50' : ''
                }`}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-gray-100 bg-white">
                  {item.imageUrl ? (
                    <Image
                      src={item.imageUrl}
                      alt=""
                      width={40}
                      height={40}
                      loading="lazy"
                      className="h-10 w-10 object-contain"
                    />
                  ) : (
                    <SearchIcon className="h-4 w-4 text-gray-300" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-gray-900">
                  {item.name}
                </span>
                <span className="shrink-0 text-sm font-semibold text-blue-700">
                  {formatPrice(item.price, item.currency)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
