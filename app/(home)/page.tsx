import Link from 'next/link'
import type { Metadata } from 'next'
import {
  fetchSelectedProducts,
  fetchPopularProducts,
  fetchActiveCategories,
  POPULAR_LIMIT,
} from '@/app/lib/catalog'
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import Announcements from '@/app/components/Announcements'
import ProductCard from '@/app/components/ProductCard'

// Unique home metadata (SEO package 2026-08-26; audit R6 2026-09-15): the
// title previously duplicated the brand twice and the description carried
// no quotable fact. The copy now names the three real assortment pillars
// and the catalog size. The «понад 5 000» fact was true at audit time
// (5 288 active / 5 021 sitemap-eligible products) — revisit if the catalog
// ever shrinks below that.
export const metadata: Metadata = {
  title: 'Товари для дому — побутова техніка, посуд, шпалери',
  description:
    'Побутова техніка, кухонний посуд і шпалери — понад 5 000 товарів. Доставка по Україні, самовивіз у Кривому Розі.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Товари для дому — побутова техніка, посуд, шпалери',
    description:
      'Побутова техніка, кухонний посуд і шпалери — понад 5 000 товарів. Доставка по Україні, самовивіз у Кривому Розі.',
    locale: 'uk_UA',
    type: 'website',
    siteName: 'Товари для дому',
    images: ['/og-image.png'],
  },
}

// Without this the home page would be prerendered once at build time and
// featured products/categories would freeze until the next deploy.
export const revalidate = 60

export default async function Home() {
  const [selectedProducts, categories] = await Promise.all([
    fetchSelectedProducts(),
    fetchActiveCategories(),
  ])
  // Popular runs AFTER the selected read: the already-shown «Обрані» ids
  // are excluded so a product flagged both is_selected and is_featured no
  // longer renders on both home shelves (2026-09 audit). The popular read
  // backfills to the limit from the next featured candidates in SQL.
  const popularProducts = await fetchPopularProducts(
    POPULAR_LIMIT,
    selectedProducts.map((product) => product.id)
  )
  // Categories section feed (owner decision 2026-09-17): only TOP-LEVEL
  // hubs (parent_id === null), capped at 5, in the admin-managed sort_order
  // (fetchActiveCategories orders sort_order → id; hubs are reordered via
  // admin/categories/[id]/order, so no separate hand-picked list). The
  // `categories` array itself stays FULL — SiteFooter below must keep all
  // its hub anchors.
  const featuredCategories = categories
    .filter((category) => category.parent_id === null)
    .slice(0, 5)

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <SiteHeader />
      <Announcements />

      <main className="flex-1">
      {/* Hero */}
      <section className="bg-gradient-to-br from-blue-700 via-blue-600 to-indigo-600 text-white">
        <div className="container mx-auto px-4 py-16 text-center md:py-20">
          {/* clamp keeps «Товари для дому» on a single line: the fluid size
              scales down on narrow screens, nowrap forbids the orphan wrap. */}
          <h1 className="whitespace-nowrap text-[clamp(0.9rem,4.6vw,2.25rem)] font-extrabold tracking-tight">
            Ласкаво просимо до «Товари для дому»
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-lg text-blue-100">
            Найкращі товари за найкращими цінами — з доставкою по всій Україні
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link
              href="/catalog"
              className="btn bg-white px-6 py-3 text-blue-700 hover:bg-blue-50"
            >
              Каталог техніки
            </Link>
            <Link
              href="/oboi"
              className="btn border border-white/40 px-6 py-3 text-white hover:bg-white/10"
            >
              Каталог шпалер
            </Link>
            <Link
              href="/linoleum"
              className="btn border border-white/40 px-6 py-3 text-white hover:bg-white/10"
            >
              Каталог лінолеуму
            </Link>
          </div>
        </div>
      </section>

      {/* Обрані товари — purely admin-curated via the SEPARATE is_selected
          flag (migration 028); is_featured stays on the popular shelf. */}
      <section className="container mx-auto px-4 py-12">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">
            Обрані товари
          </h2>
          <Link
            href="/catalog"
            className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
          >
            Усі товари →
          </Link>
        </div>

        {selectedProducts.length === 0 ? (
          // Intentional promo banner, not an empty-state box: the section must
          // look designed while no product is flagged is_selected yet (admins
          // flag them via /admin/products). The grid below activates
          // automatically as soon as selected data exists.
          <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50 via-indigo-50 to-blue-50 px-6 py-8 sm:flex-row sm:items-center">
            <div>
              <p className="text-lg font-semibold text-gray-900">
                Добірка найкращих товарів з’явиться тут незабаром
              </p>
              <p className="mt-1 text-sm text-gray-500">
                Ми готуємо для вас вибрані позиції — а в каталозі вже чекає великий асортимент.
              </p>
            </div>
            <Link href="/catalog" className="btn btn-primary shrink-0">
              Переглянути каталог
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4">
            {selectedProducts.map((product, idx) => (
              <ProductCard
                key={product.id}
                product={product}
                imageUrl={getMainPublicImageUrl(product.images)}
                  eager={idx < 4}
              />
            ))}
          </div>
        )}
      </section>

      {/* Популярні товари — purely admin-curated (is_featured). The whole
          section is hidden while nothing is selected (decision 2026-08-26):
          no giant empty box, no random/newest filler. */}
      {popularProducts.length > 0 && (
        <section className="container mx-auto px-4 py-12">
          <div className="mb-6 flex items-end justify-between">
            <h2 className="text-2xl font-bold tracking-tight text-gray-900">
              Популярні товари
            </h2>
            <Link
              href="/catalog"
              className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
            >
              Усі товари →
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4">
            {popularProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                imageUrl={getMainPublicImageUrl(product.images)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Categories */}
      <section id="categories" className="scroll-mt-24 bg-gray-100/70 py-14">
        <div className="container mx-auto px-4">
          <div className="mb-6 flex items-end justify-between">
            <h2 className="text-2xl font-bold tracking-tight text-gray-900">
              Категорії
            </h2>
            {categories.length > 5 && (
              <Link
                href="/catalog"
                className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
              >
                Усі категорії →
              </Link>
            )}
          </div>
          {categories.length === 0 ? (
            <p className="text-gray-500">Категорії відсутні</p>
          ) : (
            // Owner decision 2026-09-17: at most 5 cards — the first 5
            // top-level hubs by the admin-managed sort_order. The R9
            // 2026-09-15 state (render every active category) was a
            // defect: ~175 cards of every tree level ended up here.
            // Every hub stays reachable: SiteFooter links the same hubs
            // on every page, and /catalog + the sitemap carry the full
            // tree.
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
              {featuredCategories.map((category, idx) => (
                <Link
                  key={category.id}
                  // Path form (SEO package 2026-09-13): legacy query-form
                  // category URLs only 308-redirect now, so internal links
                  // point straight at /catalog/<slug>.
                  href={`/catalog/${encodeURIComponent(category.slug)}`}
                  // Odd counts leave an orphan half-width card on the 2-col
                  // mobile grid: the LAST card spans the full row (the same
                  // affordance the old slice-5 hack served). sm:col-span-1
                  // cancels it for the 3-col layout.
                  className={`card group p-5 transition-shadow hover:shadow-md ${
                    idx === featuredCategories.length - 1 && featuredCategories.length % 2 === 1
                      ? 'col-span-2 sm:col-span-1'
                      : ''
                  }`}
                >
                  <h3 className="font-semibold text-gray-900 transition-colors motion-reduce:transition-none group-hover:text-blue-700">
                    {category.name}
                  </h3>
                  {/* Always visible: touch devices have no hover — the
                      affordance must not depend on it (P3-R3). */}
                  <p className="mt-1 text-sm text-blue-600">
                    Переглянути товари →
                  </p>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Офлайн-магазин: коротка довідка перед футером */}
      <section className="container mx-auto px-4 pb-10">
        <p className="mx-auto max-w-2xl text-center text-sm text-gray-600">
          Наш офлайн магазин «Товари для дому» знаходиться за адресою: м. Кривий
          Ріг, вул. Гетьмана Івана Мазепи, 87А.
        </p>
      </section>
      </main>

      <div className="mt-auto">
        <SiteFooter categories={categories} />
      </div>
    </div>
  )
}
