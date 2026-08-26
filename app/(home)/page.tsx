import Link from 'next/link'
import type { Metadata } from 'next'
import {
  fetchFeaturedProducts,
  fetchPopularProducts,
  fetchActiveCategories,
} from '@/app/lib/catalog'
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import ProductCard from '@/app/components/ProductCard'

// Unique home metadata (SEO package 2026-08-26): previously the page fell
// through to the root-layout fallback title shared with every other route.
// Copy reuses the hero text already rendered on this page — nothing invented.
export const metadata: Metadata = {
  title: 'Інтернет-магазин товарів для дому | E-Shop',
  description:
    'Найкращі товари за найкращими цінами — з доставкою по всій Україні.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Інтернет-магазин товарів для дому | E-Shop',
    description:
      'Найкращі товари за найкращими цінами — з доставкою по всій Україні.',
    locale: 'uk_UA',
    type: 'website',
    siteName: 'E-Shop',
  },
}

// Without this the home page would be prerendered once at build time and
// featured products/categories would freeze until the next deploy.
export const revalidate = 60

export default async function Home() {
  const [featuredProducts, popularProducts, categories] = await Promise.all([
    fetchFeaturedProducts(),
    fetchPopularProducts(),
    fetchActiveCategories(),
  ])

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <SiteHeader />

      {/* Hero */}
      <section className="bg-gradient-to-br from-blue-700 via-blue-600 to-indigo-600 text-white">
        <div className="container mx-auto px-4 py-16 text-center md:py-20">
          <h1 className="mx-auto max-w-2xl text-3xl font-extrabold tracking-tight md:text-4xl">
            Ласкаво просимо до E-Shop
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-lg text-blue-100">
            Найкращі товари за найкращими цінами — з доставкою по всій Україні
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link
              href="/catalog"
              className="btn bg-white px-6 py-3 text-blue-700 hover:bg-blue-50"
            >
              Перейти до каталогу
            </Link>
            {categories.length > 0 && (
              <Link
                href="#categories"
                className="btn border border-white/40 px-6 py-3 text-white hover:bg-white/10"
              >
                Категорії товарів
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* Featured Products */}
      <section className="container mx-auto px-4 py-12">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">
            Вибрані товари
          </h2>
          <Link
            href="/catalog"
            className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
          >
            Усі товари →
          </Link>
        </div>

        {featuredProducts.length === 0 ? (
          // Intentional promo banner, not an empty-state box: the section must
          // look designed while no product is flagged is_featured yet (admins
          // flag them via /admin/products). The grid below activates
          // automatically as soon as featured data exists.
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
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {featuredProducts.map((product, idx) => (
              <ProductCard
                key={product.id}
                product={product}
                imageUrl={getMainPublicImageUrl(product.images)}
                priority={idx < 4}
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
            // Only the first 5: the full supplier list (~200) made the home
            // page an endless wall of cards. The rest lives in /catalog.
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
              {categories.slice(0, 5).map((category, idx) => (
                <Link
                  key={category.id}
                  href={`/catalog?category=${encodeURIComponent(category.slug)}`}
                  // 5th card spans the full row on the 2-col mobile grid so
                  // the layout never ends on an orphan half-width card.
                  className={`card group p-5 transition-shadow hover:shadow-md ${
                    idx === 4 ? 'col-span-2 sm:col-span-1' : ''
                  }`}
                >
                  <h3 className="font-semibold text-gray-900 group-hover:text-blue-700">
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

      <div className="mt-auto">
        <SiteFooter categories={categories} />
      </div>
    </div>
  )
}
