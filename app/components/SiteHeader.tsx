import Link from 'next/link';
import CartBadge from './CartBadge';
import FavoritesBadge from './FavoritesBadge';
import NavDrawer from './NavDrawer';
import SearchSuggest from './SearchSuggest';

/**
 * Shared storefront header. The search input is a plain GET form targeting
 * /catalog?q=... so it works without client-side JavaScript. When the
 * current view carries a search term, it is pre-filled (defaultValue) so
 * the user can refine their query on the results page. The input (+ submit
 * button) is wrapped by the SearchSuggest client island, which ADDS live
 * autocomplete suggestions on top of the unchanged no-JS form behaviour.
 */
export default function SiteHeader({
  searchQuery,
}: {
  searchQuery?: string;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white shadow-sm">
      {/* Note: no backdrop-filter here on purpose — backdrop-filter makes the
          header the containing block for fixed descendants and breaks any
          fixed overlay rendered inside it (the nav drawer portals to body
          and layers under this header instead). */}
      <div className="container mx-auto px-4 py-2 sm:py-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center space-x-3">
            <NavDrawer />
            <Link href="/" className="text-lg whitespace-nowrap sm:text-xl font-bold text-blue-600">
              Товари для дому
            </Link>
            {/* Избранное доступно через сердечко-бейдж справа (с живым
                счётчиком) — отдельная текстовая ссылка дублировала бы его. */}
            <nav className="flex space-x-4" aria-label="Основна навігація">
              <Link href="/catalog" className="hidden min-[420px]:inline-block text-gray-600 hover:text-blue-600">
                Каталог
              </Link>
            </nav>
          </div>

          {/* Search collapses to its own row on small screens */}
          <form action="/catalog" method="get" className="order-last w-full sm:order-none sm:w-auto sm:flex-1 sm:mx-8">
            <SearchSuggest defaultValue={searchQuery} />
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
            {/* Мобільна іконка-телефон: компактний тап-таргет поруч з
                бейджами, поки текстовий tel: схований за md. */}
            <a
              href="tel:+380973144221"
              aria-label="Подзвонити"
              className="flex h-11 w-11 items-center justify-center text-gray-600 hover:text-blue-600 md:hidden"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                focusable={false}
                className="h-5 w-5"
              >
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
            </a>
            <FavoritesBadge />
            <CartBadge />
          </div>
        </div>
      </div>
    </header>
  );
}
