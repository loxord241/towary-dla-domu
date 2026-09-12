import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import type { Metadata } from 'next'
import { fetchProductBySlug, fetchPublishedReviews, fetchReviewSummary, fetchRelatedProducts, fetchActiveCategories, type ReviewsPageData, type ReviewSummary, type CatalogCardProduct } from '@/app/lib/catalog'
import { getPublicImageUrls, getMainPublicImageUrl } from '@/app/lib/supabase-storage'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import Announcements from '@/app/components/Announcements'
import AddToCartButton from '@/app/components/AddToCartButton'
import FavoriteButton from '@/app/components/FavoriteButton'
import ProductGallery from '@/app/components/ProductGallery'
import ProductDescription from '@/app/components/ProductDescription'
import ProductSpecifications from '@/app/components/ProductSpecifications'
import ProductReviews from '@/app/components/ProductReviews'
import RollCalculator from '@/app/components/RollCalculator'
import RestockNotify from '@/app/components/RestockNotify'
import CallbackRequest from '@/app/components/CallbackRequest'
import { parseRollSize } from '@/app/lib/wallpapers/parse'
import RecentProducts from '@/app/components/RecentProducts'
import RecentlyViewedTracker from '@/app/components/RecentlyViewedTracker'
import RelatedProducts from '@/app/components/RelatedProducts'
import ProductJsonLd from '@/app/components/ProductJsonLd'
import { buildProductJsonLd, buildProductBreadcrumbJsonLd } from '@/app/lib/schema-org'
import { buildProductMetaDescription } from '@/app/lib/seo'
import { shouldRenderDescriptionSection } from '@/app/lib/product-description'
import { formatPrice } from '@/app/lib/format'

// On-demand ISR (Task #5B 2026-08-31): the route no longer touches any
// request-time API — reviews pagination beyond the SSR-rendered page 1 is
// client-side via GET /api/reviews. Every slug renders on its first visit
// (dynamicParams defaults to true) and revalidates every 60s.
export const revalidate = 60

// Empty array = zero build-time prerendering: all ~5k slugs render on
// demand instead of inflating the build (audit Task #5A, Next.js 16 docs
// «All paths at runtime»).
export async function generateStaticParams() {
  return []
}

// React cache(): generateMetadata and the page component share ONE
// fetchProductBySlug execution per request instead of two.
const getProduct = cache(fetchProductBySlug)

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const product = await getProduct(slug)
  if (!product) return { title: 'Сторінку не знайдено | Товари для дому' }

  // PDP meta policy (audit 2026-08-31): placeholder/boilerplate supplier
  // descriptions fall back to the generic name-based meta — pure decision
  // logic lives in app/lib/seo.ts and is unit-tested.
  const description = buildProductMetaDescription({
    productName: product.name,
    shortDescription: product.short_description,
    description: product.description,
  })

  // Self-canonical plus full OG fields: page-level openGraph REPLACES the
  // layout's (shallow merge), so locale/siteName must be repeated here.
  // og:image is the product's REAL main image — the same URL the gallery
  // shows — only when one exists; no invented or placeholder URLs.
  const canonical = `/product/${slug}`
  const mainImage = getMainPublicImageUrl(product.images)
  return {
    title: `${product.name} — Товари для дому`,
    description,
    alternates: { canonical },
    openGraph: {
      title: `${product.name} — Товари для дому`,
      description,
      url: canonical,
      locale: 'uk_UA',
      // NOTE (audit 2026-09-06): og:type must stay 'website' — the og:type
      // 'product' from the OG spec is NOT in Next's OpenGraphType union and
      // its tag emitter throws E237 "Invalid OpenGraph type: product" for
      // any value outside {website, article, book, profile, music.*, video.*}
      // (verified in node_modules/next/dist/lib/metadata/metadata.js, default
      // branch of the og:type switch). Product semantics on the PDP are
      // already expressed by the Product JSON-LD below.
      type: 'website',
      siteName: 'Товари для дому',
      images: mainImage ? [mainImage] : [],
    },
  }
}

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
  const product = await getProduct(slug)

  // Unknown or inactive slug must be a real HTTP 404, not a rendered error box.
  if (!product) {
    notFound()
  }

  // Reviews page 1 is always server-rendered (Task #5B): pagination beyond
  // the first page is client-side (GET /api/reviews) so the route stays ISR.

  // Supplementary content (perf audit Step 2 2026-08-28): reviews, summary
  // and related products depend ONLY on `product`, so they all run in ONE
  // parallel wave instead of reviews-first-then-related waterfall. Each part
  // keeps its own degradation contract: a reviews failure degrades to an
  // empty state, a related failure hides the block — neither breaks the page.
  const [reviewsSettled, relatedSettled, categoriesSettled] = await Promise.allSettled([
    Promise.all([
      fetchReviewSummary(product.id),
      fetchPublishedReviews(product.id, 1),
    ]),
    fetchRelatedProducts(product),
    // Footer category links (2026-09 audit): the PDP footer used to fall
    // back to a single «Каталог» link because no categories were passed.
    // The page is a server component and the dictionary read is React
    // cache()d + unstable_cache(120s), so this is a pure pass-through; a
    // read failure degrades to the old fallback footer (empty array).
    fetchActiveCategories(),
  ]);

  // Reviews are supplementary content: until migration 015 is applied (or
  // during a storage hiccup) the reads fail — degrade to an empty state and
  // log honestly instead of breaking the whole product page.
  let reviewSummary: ReviewSummary
  let reviewsData: ReviewsPageData
  if (reviewsSettled.status === 'fulfilled') {
    ;[reviewSummary, reviewsData] = reviewsSettled.value
  } else {
    console.error('reviews unavailable:', reviewsSettled.reason)
    reviewSummary = { total: 0, average: null, distribution: [0, 0, 0, 0, 0] }
    reviewsData = { reviews: [], total: 0, page: 1, pageSize: 10 }
  }

  // Related products are supplementary content: a failed read degrades to a
  // hidden block instead of failing the whole page (same contract as reviews).
  let relatedProducts: CatalogCardProduct[] = []
  if (relatedSettled.status === 'fulfilled') {
    relatedProducts = relatedSettled.value
  } else {
    console.error('related products unavailable:', relatedSettled.reason)
  }

  // Footer categories: a failed read degrades to the single-link fallback
  // (SiteFooter renders the fallback for an empty array).
  const footerCategories =
    categoriesSettled.status === 'fulfilled' ? categoriesSettled.value : []

  const galleryUrls = getPublicImageUrls(product.images)

  // PDP UX: ONE decision point for both placements — «Опис» inside the
  // details card, or Характеристики in its slot when there is nothing to
  // describe (see shouldRenderDescriptionSection contract).
  const renderDescription = shouldRenderDescriptionSection(
    product.description,
    product.short_description
  )

  // Roll calculator (wallpapers, 2026-09): mounted for EVERY wc-* product.
  // Roll size is parsed on the SERVER from the product name (parseRollSize).
  // When the name states no size, rollSize is null and the calculator still
  // mounts — the size select starts on an explicit «оберіть розмір»
  // placeholder with a hint, so nothing is guessed (bug report 2026-09-11:
  // 198 of 327 active wallpaper names carry no size; hiding the calculator
  // for all of them hid it from most of the assortment).
  const isWallpaper = product.sku.startsWith('wc-')
  const rollSize = isWallpaper ? parseRollSize(product.name) : null

  // Structured data from REAL fields only; review summary is the try/catch
  // fallback (total=0) when reviews are unavailable → aggregateRating drops.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const productJsonLd = buildProductJsonLd(product, reviewSummary, siteUrl)
  // Mirrors the visible breadcrumb nav: Головна → Каталог → [Категорія] → Товар.
  const breadcrumbJsonLd = buildProductBreadcrumbJsonLd(
    { name: product.name, slug: product.slug },
    product.category ?? null,
    siteUrl
  )

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <SiteHeader />
      <Announcements />

      <main className="container mx-auto flex-1 px-4 py-8">
        <nav aria-label="Навігація" className="mb-5 text-sm text-gray-500">
          {/* Головна → Каталог → [Категорія] → Товар — the visible trail now
              mirrors the BreadcrumbList JSON-LD emitted below. */}
          <Link href="/" className="hover:text-blue-600 hover:underline">
            Головна
          </Link>
          <span className="mx-1.5 text-gray-300">/</span>
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
          {/* wrap-anywhere: назви шпалер — кома-ланцюжки без пробілів
              («коричневі,шпалери,53см*10м»), і хлібна крихта не повинна
              розсуваати сторінку на вузьких екранах. */}
          <span className="wrap-anywhere text-gray-900">{product.name}</span>
        </nav>

        {/* Structured data: real DB fields only (see schema-org.ts honesty rules) */}
        <ProductJsonLd data={productJsonLd} />
        <ProductJsonLd data={breadcrumbJsonLd} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
          {/* Product Images — md:self-start stops the card from stretching to
              the (taller) details column's height, which left an empty tail
              under the fixed h-96 gallery on desktop; the single-column
              mobile layout is unaffected (2026-09 audit). */}
          <div className="min-w-0 bg-white rounded-lg shadow p-4 md:self-start">
            <ProductGallery
              images={product.images.flatMap((image, idx) => {
                // galleryUrls is index-preserving (null for unresolvable
                // rows): idx lines up with product.images, so each slide's
                // alt comes from ITS OWN row — never from a shifted index.
                const url = galleryUrls[idx];
                if (!url) return [];
                return [{ url, alt: image.alt ?? product.name }];
              })}
            />
            {/* Візуалізатор тимчасово ПРИХОВАНО (2026-09-11): переробка на
                рендери-пресети; сторінка /vizualizатор доступна лише за
                прямим URL і noindex. Повернемо кнопку після апруву
                власником нових сцен. */}
          </div>

          {/* Product Details. min-w-0 на обох дітях grid: без нього
              grid-трек (min-width:auto) розсувається до min-content
              найдовшого нерозривного токена — на мобільному вся картка
              («текст») виїжджає за viewport (баг-репорт 2026-09-11). */}
          <div className="min-w-0 bg-white rounded-lg shadow p-6">
            {/* wrap-anywhere на h1: flex-сусід FavoriteButton + назви-кому-
                ланцюжки без пробілів — без цього h1 не стискається нижче
                min-content і виштовхує вміст картки за екран. */}
            <div className="flex items-start justify-between gap-3">
              <h1 className="min-w-0 wrap-anywhere text-2xl font-bold mb-2">{product.name}</h1>
              <FavoriteButton productId={product.id} productName={product.name} />
            </div>

            <div className="flex items-center mb-4">
              <span className="text-gray-500 mr-2">Артикул:</span>
              <span className="font-semibold">{product.sku}</span>
            </div>

            <div className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-gray-50 px-4 py-3">
              <span className="text-3xl font-extrabold tracking-tight text-blue-700">
                {formatPrice(product.price, product.currency)}
              </span>
              {product.old_price && product.old_price > product.price && (
                <>
                  <span className="text-lg text-gray-500 line-through">
                    {formatPrice(product.old_price, product.currency)}
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
              {/* Product-level stock lies for variant products: orders
                  decrement the VARIANT row, so show the counter only for
                  variant-less products (variant stock is per-option). */}
              {product.variants.length === 0 && product.stock_quantity > 0 && (
                <span className="text-sm text-gray-500 ml-2">
                  на складі: {product.stock_quantity} шт
                </span>
              )}
            </div>

            {/* Task #41: the «Опис» section (heading included) renders only
                when there is real content — a non-placeholder description or
                the short_description fallback. Legacy supplier HTML shells
                (<div><div></div></div>, nbsp-only) stay hidden.
                PDP UX: with nothing to describe, Характеристики take the
                description slot inside the card so the page does not feel
                empty; the below-grid section is skipped to avoid a duplicate. */}
            {renderDescription ? (
              <div className="mb-6">
                <h3 className="mb-2 font-semibold text-gray-900">Опис</h3>
                <ProductDescription
                  description={product.description}
                  shortDescription={product.short_description}
                />
              </div>
            ) : (
              <ProductSpecifications
                specifications={product.specifications}
                variant="inline"
              />
            )}

            <div className="grid grid-cols-2 gap-4 mb-6">
              {product.brand && (
                <div>
                  <h4 className="font-semibold">Бренд:</h4>
                  <p>
                    <Link
                      href={`/catalog?brand=${encodeURIComponent(product.brand.slug)}`}
                      className="text-blue-600 hover:underline"
                    >
                      {product.brand.name}
                    </Link>
                  </p>
                </div>
              )}

              {product.category && (
                <div>
                  <h4 className="font-semibold">Категорія:</h4>
                  <p>
                    <Link
                      href={`/catalog?category=${encodeURIComponent(product.category.slug)}`}
                      className="text-blue-600 hover:underline"
                    >
                      {product.category.name}
                    </Link>
                  </p>
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

            {/* Повідомити про наявність — лише для позицій «Немає в наявності»
                (сервер-гейт за availability_status; v1: Telegram власнику,
                автоemail покупцю — v2). */}
            {product.availability_status === 'out_of_stock' && (
              <RestockNotify productId={product.id} />
            )}

            {/* «Передзвоніть мені» — для КОЖНОГО товару (без гейта
                availability: консультація потрібна і «в наявності»).
                v1: ім'я + телефон → Telegram власнику, нічого не зберігаємо. */}
            <CallbackRequest productId={product.id} />

            {/* Калькулятор рулонів — для КОЖНОЇ шпалери (wc-*). rollSize=null
                (розміру немає в назві 1С) не ховає блок: покупець обирає
                розмір у select вручну — нічого не вгадується. */}
            {/* Статический пин roll-calculator-тесту матчить блок дослівно:
                обгортка id="roll-calculator" + умова всередині. */}
            <div id="roll-calculator">
              {isWallpaper && (
                <RollCalculator productId={product.id} rollSize={rollSize} />
              )}
            </div>

            {/* Компактний вказівник на повну політику: деталі живуть на
                /delivery — тут нічого не дублюємо і не вигадуємо. */}
            <div className="mt-6 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm">
              <p className="font-semibold text-gray-900">Доставка та оплата</p>
              <p className="mt-1 text-gray-600">
                Умови доставки та оплати — на сторінці{' '}
                <Link href="/delivery" className="text-blue-600 hover:underline">
                  «Доставка та оплата»
                </Link>
                .
              </p>
            </div>
          </div>
        </div>

        {/* Product Specifications — full-width below the grid only when the
            «Опис» section is shown; otherwise specs already render in its
            slot inside the details card (no duplicate block). */}
        {renderDescription && (
          <ProductSpecifications specifications={product.specifications} />
        )}

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
                      {formatPrice(variant.price, product.currency)}
                    </span>
                    {variant.old_price && variant.old_price > variant.price && (
                      <span className="text-sm text-gray-500 line-through">
                        {formatPrice(variant.old_price, product.currency)}
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

        {/* Схожі товари — bounded discovery shelf; hidden when empty. */}
        <RelatedProducts products={relatedProducts} />

        {/* Відгуки (published only, moderated) */}
        <ProductReviews
          productId={product.id}
          summary={reviewSummary}
          data={reviewsData}
          productSlug={product.slug}
        />

        {/* Нещодавно переглянуті (localStorage-only, hides itself when empty).
            Renders null until the post-mount read → no hydration mismatch. */}
        <RecentProducts excludeProductId={product.id} />

        {/* Footer — full-bleed, outside the content container */}
      </main>

      {/* Invisible recorder: client-only effect, renders nothing. */}
      <RecentlyViewedTracker productId={product.id} />

      <SiteFooter categories={footerCategories} />
    </div>
  )
}
