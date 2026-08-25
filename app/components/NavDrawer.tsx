'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import type { Brand, Category } from '@/app/lib/catalog';
import { MenuIcon, XIcon } from './icons';

/**
 * Hamburger + slide-in navigation drawer (client island — the rest of
 * SiteHeader stays a server component). Content loads from the public
 * dictionaries endpoint on first open. Closes via: close button, hamburger
 * toggle, Escape, overlay click, and any link navigation.
 *
 * The panel is portalled to <body> and sits at z-30 (below the header's
 * z-40): the header — including this hamburger — stays visible and
 * clickable above the overlay ("click hamburger again to close"), and the
 * panel starts below the header edge. Never render this drawer INSIDE the
 * header's stacking context: it would paint above the header content.
 */

const MAX_LIST_ITEMS = 8;

const SHOP_LINKS = [
  { href: '/about', label: 'Про нас' },
  { href: '/delivery', label: 'Доставка і оплата' },
  { href: '/returns', label: 'Повернення' },
  { href: '/orders/lookup', label: 'Статус замовлення' },
];

interface Dictionaries {
  categories: Category[];
  brands: Brand[];
}

const linkClass =
  'flex min-h-[44px] items-center rounded-lg px-3 text-gray-700 hover:bg-gray-100 hover:text-blue-700';

export default function NavDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Відкрити меню"
        aria-expanded={open}
        aria-controls="nav-drawer"
        onClick={() => setOpen((o) => !o)}
        className="-ml-1 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 hover:text-blue-700"
      >
        <MenuIcon className="h-6 w-6" />
      </button>
      {open && <DrawerPanel id="nav-drawer" onClose={() => setOpen(false)} />}
    </>
  );
}

function DrawerPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [dicts, setDicts] = useState<Dictionaries | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [headerH, setHeaderH] = useState(0);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Load dictionaries once on first open (fresh data, static pages stay static)
  useEffect(() => {
    if (dicts || loadFailed) return;
    let cancelled = false;
    fetch('/api/catalog-dictionaries')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: Dictionaries) => {
        if (!cancelled) setDicts(data);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dicts, loadFailed]);

  // Panel starts below the sticky header (measured, resize-safe). The panel
  // is portalled to <body>, so the header must be looked up globally.
  useEffect(() => {
    const header = document.querySelector('header');
    const measure = () => setHeaderH(header?.offsetHeight ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Focus handling, Escape, focus trap, body scroll lock
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
          'a[href], button:not([disabled])'
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

  const closeAfterNavigate = () => onClose();

  const renderList = (items: { href: string; label: string }[]) => (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.href}>
          <Link href={item.href} className={linkClass} onClick={closeAfterNavigate}>
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );

  const skeleton = (width: string) => (
    <div className="space-y-2 px-3 py-2" aria-hidden>
      {[...Array(5)].map((_, i) => (
        <div key={i} className={`h-6 ${width} animate-pulse rounded bg-gray-100`} />
      ))}
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-30">
      {/* overlay */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        id={id}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Навігаційне меню"
        style={{ top: headerH, height: `calc(100% - ${headerH}px)` }}
        className="absolute left-0 flex w-80 max-w-[85vw] flex-col bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-gray-200 p-3">
          <span className="text-lg font-bold text-blue-600">E-Shop</span>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="Закрити меню"
            onClick={onClose}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <XIcon className="h-6 w-6" />
          </button>
        </div>

        <nav aria-label="Меню магазину" className="flex-1 space-y-4 overflow-y-auto p-3">
          <section>
            <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Категорії
            </h2>
            {!dicts ? (
              loadFailed ? (
                <p className="px-3 py-2 text-sm text-gray-500">
                  Не вдалося завантажити категорії.
                </p>
              ) : (
                skeleton('w-3/4')
              )
            ) : (
              <>
                {renderList(
                  dicts.categories.slice(0, MAX_LIST_ITEMS).map((c) => ({
                    href: `/catalog?category=${encodeURIComponent(c.slug)}`,
                    label: c.name,
                  }))
                )}
                <Link
                  href="/catalog"
                  className={`${linkClass} font-medium text-blue-700`}
                  onClick={closeAfterNavigate}
                >
                  Усі категорії →
                </Link>
              </>
            )}
          </section>

          <section>
            <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Бренди
            </h2>
            {!dicts ? (
              loadFailed ? (
                <p className="px-3 py-2 text-sm text-gray-500">
                  Не вдалося завантажити бренди.
                </p>
              ) : (
                skeleton('w-2/3')
              )
            ) : (
              <>
                {renderList(
                  dicts.brands.slice(0, MAX_LIST_ITEMS).map((b) => ({
                    href: `/catalog?brand=${encodeURIComponent(b.slug)}`,
                    label: b.name,
                  }))
                )}
                <Link
                  href="/catalog"
                  className={`${linkClass} font-medium text-blue-700`}
                  onClick={closeAfterNavigate}
                >
                  Усі бренди →
                </Link>
              </>
            )}
          </section>

          <section>
            <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Магазин
            </h2>
            {renderList(SHOP_LINKS)}
          </section>
        </nav>
      </div>
    </div>,
    document.body
  );
}
