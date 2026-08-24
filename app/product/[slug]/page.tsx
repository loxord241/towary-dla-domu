import Link from 'next/link'
import { notFound } from 'next/navigation'
import { fetchProductBySlug } from '@/app/lib/catalog'
import { getPublicImageUrls } from '@/app/lib/supabase-storage'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import AddToCartButton from '@/app/components/AddToCartButton'
import FavoriteButton from '@/app/components/FavoriteButton'
import ProductGallery from '@/app/components/ProductGallery'
import ProductDescription from '@/app/components/ProductDescription'

function availabilityLabel(status: string): string {
  if (status === 'in_stock') return 'В наявності'
  if (status === 'out_of_stock') return 'Немає в наявності'
  return 'Обмежена наявність'
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const product = await fetchProductBySlug(slug)

  // Unknown or inactive slug must be a real HTTP 404, not a rendered error box.
  if (!product) {
    notFound()
  }

  const galleryUrls = getPublicImageUrls(product.images)

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <SiteHeader />

      <div className="container mx-auto flex-1 px-4 py-8">
        <nav aria-label="Навігація" className="mb-5 text-sm text-gray-500">
          <Link href="/catalog" className="hover:text-blue-600 hover:underline">Каталог</Link>
          {product.category && (
            <>
              <span className="mx-1.5 text-gray-300">/</span>
              <Link
                href={`/catalog?category=${encodeURIComponent(product.category.slug)}`}
                className="hover:text-blue-600 hover:underline"
              >
                {product.category.name}
              </Link>
            </>
          )}
          <span className="mx-1.5 text-gray-300">/</span>
          <span className="text-gray-900">{product.name}</span>
        </nav>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
          {/* Product Images */}
          <div className="bg-white rounded-lg shadow p-4">
            <ProductGallery
              images={galleryUrls.map((url, idx) => ({
                url,
                alt:
                  product.images.find((image) => image.is_main && idx === 0)
                    ?.alt ??
                  product.images[idx]?.alt ??
                  product.name,
              }))}
            />
          </div>

          {/* Product Details */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-start justify-between gap-3">
              <h1 className="text-2xl font-bold mb-2">{product.name}</h1>
              <FavoriteButton productId={product.id} productName={product.name} />
            </div>

            <div className="flex items-center mb-4">
              <span className="text-gray-500 mr-2">Артикул:</span>
              <span className="font-semibold">{product.sku}</span>
            </div>

            <div className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-gray-50 px-4 py-3">
              <span className="text-3xl font-extrabold tracking-tight text-blue-700">
                {product.price} {product.currency}
              </span>
              {product.old_price && product.old_price > product.price && (
                <>
                  <span className="text-lg text-gray-400 line-through">
                    {product.old_price} {product.currency}
                  </span>
                  <span className="rounded bg-red-50 px-2 py-0.5 text-sm font-semibold text-red-600">
                    −{Math.round((1 - product.price / product.old_price) * 100)}%
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center mb-6">
              <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                product.availability_status === 'in_stock' ? 'bg-green-100 text-green-800' :
                product.availability_status === 'out_of_stock' ? 'bg-red-100 text-red-800' :
                'bg-yellow-100 text-yellow-800'
              }`}>
                {availabilityLabel(product.availability_status)}
              </span>
              {product.stock_quantity > 0 && (
                <span className="text-sm text-gray-500 ml-2">
                  на складі: {product.stock_quantity} шт
                </span>
              )}
            </div>

            <div className="mb-6">
              <h3 className="mb-2 font-semibold text-gray-900">Опис</h3>
              <ProductDescription
                description={product.description}
                shortDescription={product.short_description}
              />
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6">
              {product.brand && (
                <div>
                  <h4 className="font-semibold">Бренд:</h4>
                  <p>{product.brand.name}</p>
                </div>
              )}

              {product.category && (
                <div>
                  <h4 className="font-semibold">Категорія:</h4>
                  <p>{product.category.name}</p>
                </div>
              )}
            </div>

            <AddToCartButton
              productId={product.id}
              productName={product.name}
              stockQuantity={product.stock_quantity}
              availabilityStatus={product.availability_status}
              variants={product.variants.map((v) => ({
                id: v.id,
                name: v.name,
                stockQuantity: v.stock_quantity,
                availabilityStatus: v.availability_status,
              }))}
            />
          </div>
        </div>

        {/* Product Variants */}
        {product.variants.length > 0 && (
          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <h2 className="text-xl font-bold mb-4">Варіанти товару</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {product.variants.map((variant) => (
                <div key={variant.id} className="border rounded-lg p-4">
                  <h3 className="font-semibold">{variant.name}</h3>
                  <div className="flex items-baseline mt-2 gap-2">
                    <span className="text-lg font-bold text-blue-600">
                      {variant.price} ₴
                    </span>
                    {variant.old_price && variant.old_price > variant.price && (
                      <span className="text-sm text-gray-500 line-through">
                        {variant.old_price} ₴
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-2">
                    Наявність: {availabilityLabel(variant.availability_status)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer — full-bleed, outside the content container */}
      </div>

      <SiteFooter />
    </div>
  )
}
