import type { Metadata } from 'next';
import Link from 'next/link';
import SiteHeader from '@/app/components/SiteHeader';
import SiteFooter from '@/app/components/SiteFooter';
import ProductJsonLd from '@/app/components/ProductJsonLd';
import { fetchActiveBrands, fetchBrandProductCount } from '@/app/lib/catalog';
import { buildBrandsBreadcrumbJsonLd } from '@/app/lib/schema-org';
import { SITE_NAME } from '@/app/lib/seo';

/**
 * /brands — єдина індексована посадочна всіх брендів (SEO-батч
 * 2026-09-17, задача S3). Брендові в'юхи /catalog?brand=<slug> до цього
 * часу були досяжні лише з клієнтського фільтра — краулер їх майже не бачив;
 * хаб дає їм краулабельні входи (плюс посилання у футері та sitemap).
 *
 * Статичний ISR-роут за прецедентом /samovyviz і /oboi: сторінка читає
 * NO searchParams, тому revalidate = 300 тримає весь HTML (метадані та
 * JSON-LD включно) в ISR-кеші. Бренди — словник із рідкісними змінами
 * (dictionary-TTL Data Cache 300с у categories.ts), тому 300s узгоджені
 * з цим вікном; товари всередині брендових в'юх оновлюються власними
 * ISR-вікнами каталогу.
 */
export const revalidate = 300;

// Geo tail — у стилі шаблонних описів lib/seo.ts: description only,
// title лишається без гео (SERP-вікно).
const DESCRIPTION =
  `Бренди побутової техніки й товарів для дому в інтернет-магазині ${SITE_NAME}: ` +
  'обирайте виробника, щоб переглянути його товари — з доставкою по Україні та самовивозом у Кривому Розі.';

// Page-level openGraph REPLACES the root layout's whole openGraph object
// (shallow metadata merge — the lib/seo.ts lesson): repeat locale/type/
// siteName AND the default image, or a share in Viber/Telegram would lose
// og:image entirely.
export async function generateMetadata(): Promise<Metadata> {
  const title = 'Бренди — Товари для дому';
  return {
    title,
    description: DESCRIPTION,
    openGraph: {
      title,
      description: DESCRIPTION,
      locale: 'uk_UA',
      type: 'website',
      siteName: SITE_NAME,
      images: ['/og-image.png'],
    },
    alternates: { canonical: '/brands' },
  };
}

import { pluralProducts } from '@/app/lib/format';

export { pluralProducts };

export default async function BrandsPage() {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const breadcrumbJsonLd = buildBrandsBreadcrumbJsonLd(siteUrl);

  const brands = await fetchActiveBrands();
  // Same parallel counting shape as filterNonEmptyChildren
  // (app/lib/category-seo.ts), with the EXACT same null/0 semantics:
  // a count of 0 drops the brand (its view is excluded from indexing by
  // lib/seo.ts and must never be linked); a null count (unknown/inactive
  // slug) degrades to non-empty and stays (practically unreachable here —
  // slugs come from the same active dictionary the counter itself
  // resolves); a DB read error propagates, so the page can never render
  // a half-gated list that silently hides a whole branch.
  const counts = await Promise.all(
    brands.map((brand) => fetchBrandProductCount(brand.slug))
  );
  const listed = brands
    .map((brand, index) => ({ brand, count: counts[index] }))
    .filter((entry) => entry.count !== 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      <main className="container mx-auto px-4 py-10">
        <div className="mx-auto max-w-4xl">
          <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 mb-2">
            Бренди
          </h1>
          <div aria-hidden className="mb-6 h-1 w-12 rounded bg-blue-600" />
          <p className="mb-8 text-base leading-relaxed text-gray-600">
            Усі бренди каталогу, в яких є товари. Натисніть на бренд, щоб
            перейти до переліку його товарів — з фільтрами та сортуванням
            каталогу.
          </p>

          {/* BreadcrumbList for the hub — rendered through ProductJsonLd,
              the sanctioned JSON-LD sink of the allowlist. */}
          <ProductJsonLd data={breadcrumbJsonLd} />

          <ul className="flex flex-wrap gap-2">
            {listed.map(({ brand, count }) => (
              <li key={brand.id}>
                <Link
                  // Canonical form of a brand view (lib/seo.ts): the query
                  // form — brands have no path route (unlike categories).
                  href={`/catalog?brand=${encodeURIComponent(brand.slug)}`}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm text-blue-700 transition hover:bg-blue-50"
                >
                  {brand.name}
                  {/* Same count that gated the entry; null (kept by the
                      filter as non-empty) renders without a counter. */}
                  {count != null && (
                    <span className="text-xs font-normal text-gray-500">
                      {pluralProducts(count)}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
