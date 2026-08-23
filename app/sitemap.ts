import type { MetadataRoute } from 'next';
import { fetchActiveCategories } from '@/app/lib/catalog';

/**
 * Sitemap for public surfaces only: static pages + active categories.
 * Individual product pages are intentionally omitted — the catalog is
 * filter/pagination-driven and products change frequently; crawlers reach
 * them through category and catalog links.
 * The production domain must be provided via NEXT_PUBLIC_SITE_URL.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000')
    .replace(/\/+$/, '');

  const staticEntries: MetadataRoute.Sitemap = [
    '',
    '/catalog',
    '/delivery',
    '/contacts',
    '/about',
    '/returns',
    '/privacy',
    '/terms',
  ].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: path === '' || path === '/catalog' ? 'daily' : 'monthly',
    priority: path === '' ? 1 : path === '/catalog' ? 0.9 : 0.3,
  }));

  let categoryEntries: MetadataRoute.Sitemap = [];
  try {
    const categories = await fetchActiveCategories();
    categoryEntries = categories.map((category) => ({
      url: `${base}/catalog?category=${encodeURIComponent(category.slug)}`,
      lastModified: new Date(category.updated_at),
      changeFrequency: 'daily' as const,
      priority: 0.7,
    }));
  } catch {
    // Sitemap must never fail the route: static entries are still served.
  }

  return [...staticEntries, ...categoryEntries];
}
