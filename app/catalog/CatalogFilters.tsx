'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Brand, Category } from '@/app/lib/catalog';

/**
 * Catalog sidebar filters. All state is mirrored into the /catalog query
 * string (category, brand, min, max, stock), so filtered views are
 * shareable URLs rendered server-side.
 *
 * Mobile: the panel is collapsed behind a toggle so product cards start
 * above the fold (2026-08 UX audit). Desktop (md+) keeps it always open.
 * `defaultOpen` auto-expands when filters are active; `activeCount` is
 * shown as a badge on the collapsed toggle.
 */
export default function CatalogFilters({
  categories,
  brands,
  initial,
  defaultOpen = false,
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
  /** initial expanded state on mobile (true when filters are active) */
  defaultOpen?: boolean;
  /** number of currently applied filters, for the toggle badge */
  activeCount?: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);

  const [category, setCategory] = useState(initial?.categorySlug ?? '');
  const [brand, setBrand] = useState(initial?.brandSlug ?? '');
  const [minPrice, setMinPrice] = useState(
    initial?.minPrice !== undefined ? String(initial.minPrice) : ''
  );
  const [maxPrice, setMaxPrice] = useState(
    initial?.maxPrice !== undefined ? String(initial.maxPrice) : ''
  );
  const [inStockOnly, setInStockOnly] = useState(initial?.inStockOnly ?? false);

  const applyFilters = () => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (brand) params.set('brand', brand);
    if (minPrice.trim() !== '' && Number.isFinite(Number(minPrice))) {
      params.set('min', minPrice.trim());
    }
    if (maxPrice.trim() !== '' && Number.isFinite(Number(maxPrice))) {
      params.set('max', maxPrice.trim());
    }
    if (inStockOnly) params.set('stock', '1');
    router.push(params.size > 0 ? `/catalog?${params}` : '/catalog');
  };

  const resetFilters = () => {
    setCategory('');
    setBrand('');
    setMinPrice('');
    setMaxPrice('');
    setInStockOnly(false);
    router.push('/catalog');
  };

  return (
    <div>
      {/* Mobile toggle — hidden on desktop where the panel is always open */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="card mb-4 flex w-full cursor-pointer select-none items-center justify-between px-5 py-4 font-semibold text-gray-900 md:hidden"
      >
        <span className="flex items-center gap-2">
          Фільтри
          {activeCount > 0 && (
            <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white">
              {activeCount}
            </span>
          )}
        </span>
        <span
          aria-hidden
          className={`text-blue-600 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          ▾
        </span>
      </button>

      <div className={`card p-5 md:p-6 ${open ? 'block' : 'hidden'} md:block`}>
        <h3 className="mb-4 hidden font-bold text-lg md:block">Фільтри</h3>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters();
        }}
      >
        <div className="mb-6">
          <h4 className="font-semibold mb-2">Категорії</h4>
          {categories.length === 0 ? (
            <p className="text-sm text-gray-500">Категорії відсутні</p>
          ) : (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Категорія"
              className="input"
            >
              <option value="">Всі категорії</option>
              {categories.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>

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

        <div className="mb-6">
          <h4 className="font-semibold mb-2">Ціна (₴)</h4>
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

        <div className="mb-6">
          <h4 className="font-semibold mb-2">Наявність</h4>
          <label className="flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={inStockOnly}
              onChange={(e) => setInStockOnly(e.target.checked)}
              className="mr-2"
            />
            <span>Тільки в наявності</span>
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <button type="submit" className="btn btn-primary">
            Застосувати
          </button>
          <button type="button" onClick={resetFilters} className="btn btn-secondary">
            Скинути
          </button>
        </div>
      </form>
      </div>
    </div>
  );
}
