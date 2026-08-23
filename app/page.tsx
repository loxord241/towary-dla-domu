import Link from 'next/link'
import { fetchFeaturedProducts, fetchActiveCategories } from '@/app/lib/catalog'
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import ProductCard from '@/app/components/ProductCard'
import EmptyState from '@/app/components/EmptyState'

// Without this the home page would be prerendered once at build time and
// featured products/categories would freeze until the next deploy.
export const revalidate = 60

export default async function Home() {
  const [featuredProducts, categories] = await Promise.all([
    fetchFeaturedProducts(),
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
          <EmptyState
            icon="🛍️"
            title="Вибраних товарів поки що немає"
            description="Загляньте в каталог — там точно є що цікаве."
            ctaHref="/catalog"
            ctaLabel="До каталогу"
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {featuredProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                imageUrl={getMainPublicImageUrl(product.images)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Categories */}
      <section id="categories" className="scroll-mt-24 bg-gray-100/70 py-14">
        <div className="container mx-auto px-4">
          <h2 className="mb-6 text-2xl font-bold tracking-tight text-gray-900">
            Категорії
          </h2>
          {categories.length === 0 ? (
            <p className="text-gray-500">Категорії відсутні</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {categories.map((category) => (
                <Link
                  key={category.id}
                  href={`/catalog?category=${encodeURIComponent(category.slug)}`}
                  className="card group p-5 transition-shadow hover:shadow-md"
                >
                  <h3 className="font-semibold text-gray-900 group-hover:text-blue-700">
                    {category.name}
                  </h3>
                  <p className="mt-1 text-sm text-blue-600 opacity-0 transition-opacity group-hover:opacity-100">
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
