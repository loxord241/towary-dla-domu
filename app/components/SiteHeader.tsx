import Link from 'next/link';
import CartBadge from './CartBadge';
import FavoritesBadge from './FavoritesBadge';
import NavDrawer from './NavDrawer';
import { SearchIcon } from './icons';

/**
 * Shared storefront header. The search input is a plain GET form targeting
 * /catalog?q=... so it works without client-side JavaScript.
 */
export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white shadow-sm">
      {/* Note: no backdrop-filter here on purpose — backdrop-filter makes the
          header the containing block for fixed descendants and breaks any
          fixed overlay rendered inside it (the nav drawer portals to body
          and layers under this header instead). */}
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center space-x-3">
            <NavDrawer />
            <Link href="/" className="text-xl font-bold text-blue-600">
              Товари для дому
            </Link>
            {/* Избранное доступно через сердечко-бейдж справа (с живым
                счётчиком) — отдельная текстовая ссылка дублировала бы его. */}
            <nav className="flex space-x-4" aria-label="Основна навігація">
              <Link href="/catalog" className="text-gray-600 hover:text-blue-600">
                Каталог
              </Link>
            </nav>
          </div>

          {/* Search collapses to its own row on small screens */}
          <form action="/catalog" method="get" className="order-last w-full sm:order-none sm:w-auto sm:flex-1 sm:mx-8">
            <div className="relative">
              <input
                type="search"
                name="q"
                aria-label="Пошук"
                placeholder="Пошук товарів..."
                className="w-full px-4 py-2 pr-12 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                type="submit"
                aria-label="Шукати"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center text-gray-400 hover:text-blue-600"
              >
                <SearchIcon className="h-5 w-5" />
              </button>
            </div>
          </form>

          <div className="flex items-center space-x-1">
            <a
              href="tel:+380973144221"
              className="mr-2 hidden text-right text-sm leading-tight text-gray-600 hover:text-blue-600 md:block"
            >
              <span className="block text-xs text-gray-500">
                Телефон для консультації
              </span>
              <span className="font-medium">+380 (97) 314 42 21</span>
            </a>
            <FavoritesBadge />
            <CartBadge />
          </div>
        </div>
      </div>
    </header>
  );
}
