import type { MetadataRoute } from 'next';

/**
 * Storefront robots: keep private surfaces (admin, APIs, checkout, guest
 * order views) out of search indexes. The public catalog is indexable.
 * The production domain must be provided via NEXT_PUBLIC_SITE_URL.
 */
export default function robots(): MetadataRoute.Robots {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/admin/', '/api/', '/checkout', '/orders/'],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
