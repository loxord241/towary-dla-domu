'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Brand, Category } from '@/app/lib/catalog';
import { buildFilterUrl } from '@/app/lib/filter-url';
import CategorySelect from '@/app/components/CategorySelect';
import { ChevronDownIcon, FilterIcon, XIcon } from '../components/icons';

/**
 * Catalog sidebar filters. All state is mirrored into the /catalog query
 * string (category, brand, min, max, stock), so filtered views are
 * shareable URLs rendered server-side. Applying preserves the current
 * search term (`q`) and sort order and lands on page 1 — URL building
 * lives in app/lib/filter-url.ts (pure + unit-tested).
 *
 * Mobile (<md): the form lives in a right-side sheet behind a «Фільтри»
 * button so product cards start above the fold. The sheet reuses the
 * NavDrawer mechanics: body portal, CSS transform transition with a
 * deferred unmount for the exit animation, focus trap + scroll lock,
 * motion-reduce fallbacks. It closes via the ✕ button, overlay click,
 * Escape, and a successful apply. Browser Back/Forward are untouched:
 * navigation stays plain router.push over URL state.
 * Desktop (md+): unchanged always-open sidebar card.
 */

/** Must cover the longest element transition (panel: 280ms). */
const DRAWER_CLOSE_MS = 300;

export default function CatalogFilters({
  categories,
  brands,
  initial,
  activeCount = 0,
}: {
  categories: Category[];
  brands: Brand[];
  /** applied filters from the URL so controls never desync from the grid */
  initial?: {
    categorySlug?: string;
    brandSlug?: string;
    minPrice?: number;
    maxPrice?: number;
    inStockOnly?: boolean;
  };
  /** number of currently applied filters, for the toggle badge */
  activeCount?: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Sheet open state (mobile only; desktop ignores it entirely).
  const [open, setOpen] = useState(false);
  // `mounted` keeps the portal alive while the exit transition plays;
  // `shown` flips the CSS transform target (NavDrawer pattern).
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);

  // Draft filter state — shared by the desktop sidebar and the mobile sheet.
  const [category, setCategory] = useState(initial?.categorySlug ?? '');
  const [brand, setBrand] = useState(initial?.brandSlug ?? '');
  const [minPrice, setMinPrice] = useState(
    initial?.minPrice !== undefined ? String(initial.minPrice) : ''
  );
  const [maxPrice, setMaxPrice] = useState(
    initial?.maxPrice !== undefined ? String(initial.maxPrice) : ''
  );
  const [inStockOnly, setInStockOnly] = useState(initial?.inStockOnly ?? false);

  useEffect(() => {
    if (!open) {
      const flip = requestAnimationFrame(() => setShown(false));
      const timer = setTimeout(() => setMounted(false), DRAWER_CLOSE_MS);
      return () => {
        cancelAnimationFrame(flip);
        clearTimeout(timer);
      };
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      setMounted(true);
      raf2 = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open]);

  const onClose = () => setOpen(false);

  const applyFilters = () => {
    router.push(
      buildFilterUrl(searchParams, {
        categorySlug: category,
        brandSlug: brand,
        minPrice,
        maxPrice,
        inStockOnly,
      })
    );
  };

  /** Apply from inside the sheet also closes it (success closes). */
  const applyAndClose = () => {
    applyFilters();
    setOpen(false);
  };

  const resetFilters = () => {
    setCategory('');
    setBrand('');
    setMinPrice('');
    setMaxPrice('');
    setInStockOnly(false);
    router.push('/catalog');
  };

  /** Reset from inside the sheet navigates bare /catalog and closes. */
  const resetAndClose = () => {
    resetFilters();
    setOpen(false);
  };

  const categoryField = (
    <div className="mb-6">
      <h4 className="font-semibold mb-2">Категорії</h4>
      {categories.length === 0 ? (
        <p className="text-sm text-gray-500">Категорії відсутні</p>
      ) : (
        <CategorySelect
          categories={categories}
          value={category}
          onChange={setCategory}
        />
      )}
    </div>
  );

  const brandField = (
    <div className="mb-6">
      <h4 className="font-semibold mb-2">Бренди</h4>
      {brands.length === 0 ? (
        <p className="text-sm text-gray-500">Бренди відсутні</p>
      ) : (
        <select
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          aria-label="Бренд"
          className="input"
        >
          <option value="">Всі бренди</option>
          {brands.map((b) => (
            <option key={b.id} value={b.slug}>
              {b.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  const priceField = (
    <div className="mb-6">
      <h4 className="font-semibold mb-2">Ціна (UAH)</h4>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="від"
          value={minPrice}
          onChange={(e) => setMinPrice(e.target.value)}
          aria-label="Ціна від"
          className="input"
        />
        <span className="text-gray-400">—</span>
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="до"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          aria-label="Ціна до"
          className="input"
        />
      </div>
    </div>
  );

  const stockField = (
    <div className="mb-6">
      <h4 className="font-semibold mb-2">Наявність</h4>
      <label className="flex cursor-pointer items-center">
        <input
          type="checkbox"
          checked={inStockOnly}
          onChange={(e) => setInStockOnly(e.target.checked)}
          className="mr-2"
        />
        <span>Тільки в наявності</span>
      </label>
    </div>
  );

  return (
    <div>
      {/* Mobile trigger — hidden on desktop where the panel is always open */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="catalog-filters-sheet"
        className="card mb-4 flex min-h-[44px] w-full cursor-pointer select-none items-center justify-between px-5 py-3 font-semibold text-gray-900 md:hidden"
      >
        <span className="flex items-center gap-2">
          <FilterIcon className="h-5 w-5 text-blue-600" />
          Фільтри
          {activeCount > 0 && (
            <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white">
              {activeCount}
            </span>
          )}
        </span>
        <ChevronDownIcon
          className={`h-5 w-5 shrink-0 text-blue-600 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Desktop sidebar — unchanged always-open behaviour */}
      <div className="card hidden p-5 md:block md:p-6">
        <h3 className="mb-4 font-bold text-lg">Фільтри</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          {categoryField}
          {brandField}
          {priceField}
          {stockField}
          <div className="flex flex-col gap-2">
            <button type="submit" className="btn btn-primary">
              Застосувати
            </button>
            <button
              type="button"
              onClick={resetFilters}
              className="btn btn-secondary"
            >
              Скинути
            </button>
          </div>
        </form>
      </div>

      {/* Mobile sheet (portalled; mounted only around its animation window) */}
      {mounted && (
        <FiltersSheet
          id="catalog-filters-sheet"
          shown={shown}
          onClose={onClose}
          onApply={applyAndClose}
          onReset={resetAndClose}
        >
          {categoryField}
          {brandField}
          {priceField}
          {stockField}
        </FiltersSheet>
      )}
    </div>
  );
}

/**
 * Right-side slide-in sheet hosting the same filter fields as the desktop
 * sidebar. Close paths: ✕ button, overlay click, Escape, successful apply.
 */
function FiltersSheet({
  id,
  shown,
  onClose,
  onApply,
  onReset,
  children,
}: {
  id: string;
  shown: boolean;
  onClose: () => void;
  onApply: () => void;
  onReset: () => void;
  children: React.ReactNode;
}) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus handling, Escape, focus trap, body scroll lock (NavDrawer parity)
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = '';
      previouslyFocused?.focus();
    };
  }, [onClose]);

  // z-50 puts the sheet above the sticky header (z-40): nothing in the
  // header needs to stay clickable while filters are open, and at z-30
  // the tall mobile header covered the sheet's ✕ and the «Категорії»
  // block. Parity with Modal / ReviewFormModal / FeedbackModal.
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
          shown ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
        aria-hidden
      />
      <div
        id={id}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Фільтри"
        className={`absolute right-0 top-0 flex h-full w-80 max-w-[85vw] transform flex-col bg-white shadow-xl transition-transform duration-[280ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${
          shown ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-gray-200 p-3">
          <span className="text-lg font-bold text-gray-900">Фільтри</span>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="Закрити фільтри"
            onClick={onClose}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <XIcon className="h-6 w-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">{children}</div>

        <div className="border-t border-gray-200 p-4">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onApply}
              className="btn btn-primary min-h-[44px] flex-1"
            >
              Застосувати
            </button>
            <button
              type="button"
              onClick={onReset}
              className="btn btn-secondary min-h-[44px] flex-1"
            >
              Скинути
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
