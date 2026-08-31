import type { MetadataRoute } from 'next';
import { createClient } from '@supabase/supabase-js';
import { fetchActiveCategories, fetchActiveBrands } from '@/app/lib/catalog';
import { collectPaged } from '@/app/lib/seo-sitemap';
import { DU_REDIRECT_SLUGS } from '@/app/lib/du-redirects';

/**
 * Sitemap for public surfaces only (SEO package 2026-08-26, spec C): static
 * pages, active categories, active brands and EVERY product the storefront
 * grid can show — same eligibility join (active + ≥1 photo via
 * product_images!inner), same anonymous-key visibility as lib/catalog.ts,
 * whitelist columns only (slug, updated_at). Private and technical routes
 * are never listed. Product reads walk bounded 1000-row windows with a
 * deterministic id order (see seo-sitemap.collectPaged).
 */
// Perf audit Step 4 (2026-08-28): the sitemap was force-dynamic — a full
// paged product scan (2.1s TTFB, ~940KB) on EVERY crawler hit. Product and
// category URLs are deterministic slugs and `lastModified` comes from real
// updated_at values, so a daily ISR window keeps every URL correct while
// serving repeats from the edge cache. The importer runs every 6 hours;
// a day of URL-set staleness is acceptable for SEO (no wrong URLs — only
// newly-imported products may appear up to a day later).
export const revalidate = 86400;

interface SitemapProductRow {
  slug: string;
  updated_at: string;
}

async function fetchEligibleProducts(): Promise<SitemapProductRow[]> {
  // Same anonymous client shape as app/lib/catalog.ts: RLS decides what is
  // visible; the service key must never appear here.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } }
  );

  try {
    return await collectPaged(async (from, limit) => {
      const { data, error } = await supabase
        .from('products')
        .select('slug, updated_at, images:product_images!inner(id)')
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, from + limit - 1);
      if (error) throw new Error(error.message);
      return (data ?? []).map(({ slug, updated_at }) => ({ slug, updated_at }));
    });
  } catch {
    // The sitemap route must never fail over product data: categories and
    // static entries still ship (same contract as the previous version).
    return [];
  }
}

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

  const [categories, brands, products] = await Promise.all([
    fetchActiveCategories().catch(() => []),
    fetchActiveBrands().catch(() => []),
    fetchEligibleProducts(),
  ]);

  const categoryEntries: MetadataRoute.Sitemap = categories.map((category) => ({
    url: `${base}/catalog?category=${encodeURIComponent(category.slug)}`,
    lastModified: new Date(category.updated_at),
    changeFrequency: 'daily',
    priority: 0.7,
  }));

  const brandEntries: MetadataRoute.Sitemap = brands.map((brand) => ({
    url: `${base}/catalog?brand=${encodeURIComponent(brand.slug)}`,
    lastModified: new Date(brand.updated_at),
    changeFrequency: 'weekly',
    priority: 0.6,
  }));

  const productEntries: MetadataRoute.Sitemap = products
    // _du URLs that 301-redirect to base must NOT be listed (spec C invariant:
    // the indexable set is EXACTLY the sitemap set). Price-diff _du pages and
    // orphans are NOT in DU_REDIRECT_SLUGS and stay listed.
    .filter((product) => !DU_REDIRECT_SLUGS.has(product.slug))
    .map((product) => ({
    url: `${base}/product/${encodeURIComponent(product.slug)}`,
    lastModified: new Date(product.updated_at),
    changeFrequency: 'weekly',
    priority: 0.5,
  }));

  return [
    ...staticEntries,
    ...categoryEntries,
    ...brandEntries,
    ...productEntries,
  ];
}
