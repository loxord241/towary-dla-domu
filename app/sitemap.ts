import type { MetadataRoute } from 'next';
import { createClient } from '@supabase/supabase-js';
import { fetchActiveCategories, fetchActiveBrands } from '@/app/lib/catalog';
import { collectPaged, collectNonEmptyCategoryIds, collectNonEmptyBrandIds } from '@/app/lib/seo-sitemap';
import { DU_REDIRECT_SLUGS } from '@/app/lib/du-redirects';

/**
 * Sitemap for public surfaces only (SEO package 2026-08-26, spec C + Task
 * #14 2026-09): static pages, NON-EMPTY active categories/brands and EVERY
 * product the storefront grid can show. «Non-empty» mirrors the same
 * eligibility join (active + ≥1 photo via product_images!inner): a category
 * view keeps its URL when its subtree holds ≥1 eligible assignment
 * (collectNonEmptyCategoryIds), a brand when ≥1 eligible product carries
 * its brand_id (collectNonEmptyBrandIds) — the empty views are noindex'd by
 * lib/seo.ts, so listing them here would violate the «indexable set =
 * sitemap set» invariant. Private and technical routes are never listed.
 * Product reads walk bounded 1000-row windows with a deterministic id
 * order (see seo-sitemap.collectPaged).
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
  brand_id: string | null;
  category_ids: string[];
}

/**
 * Resolves to null ONLY on a read failure (so the failure contract stays:
 * categories and static entries still ship unchanged); an empty list means
 * the catalog genuinely has no eligible products.
 */
async function fetchEligibleProducts(): Promise<SitemapProductRow[] | null> {
  // Same anonymous client shape as app/lib/catalog.ts: RLS decides what is
  // visible; the service key must never appear here.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } }
  );

  try {
    // The product eligibility join (images!inner) is UNCHANGED — Task #14
    // only rides along on the same rows: brand_id and the plain (non-inner)
    // product_categories embed add the view-emptiness facts without
    // changing which products qualify.
    return await collectPaged(async (from, limit) => {
      const { data, error } = await supabase
        .from('products')
        .select(
          'slug, updated_at, brand_id, images:product_images!inner(id), pc:product_categories(category_id)'
        )
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, from + limit - 1);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => ({
        slug: row.slug,
        updated_at: row.updated_at,
        brand_id: row.brand_id ?? null,
        category_ids: (row.pc ?? [])
          .map((pc) => pc.category_id)
          .filter((id): id is string => typeof id === 'string'),
      }));
    });
  } catch {
    // The sitemap route must never fail over product data: categories and
    // static entries still ship (same contract as the previous version).
    return null;
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000')
    .replace(/\/+$/, '');

  const staticEntries: MetadataRoute.Sitemap = [
    '',
    '/catalog',
    // Wallpapers storefront (owner task 2026-09-10): a static indexable
    // route — seo.ts's buildWallpapersMetadata emits the matching canonical,
    // so the «indexable set = sitemap set» invariant holds.
    '/oboi',
    '/delivery',
    '/contacts',
    '/about',
    '/returns',
    '/privacy',
    '/terms',
  ].map((path) => ({
    url: `${base}${path}`,
    // No lastModified for static pages (audit P2): `new Date()` re-stamps
    // every deploy and teaches crawlers the timestamp is noise — omit it
    // and let changeFrequency do the work.
    changeFrequency:
      path === '' || path === '/catalog' || path === '/oboi'
        ? 'daily'
        : 'monthly',
    priority: path === '' ? 1 : path === '/catalog' || path === '/oboi' ? 0.9 : 0.3,
  }));

  const [categories, brands, products] = await Promise.all([
    fetchActiveCategories().catch(() => []),
    fetchActiveBrands().catch(() => []),
    fetchEligibleProducts(),
  ]);

  // Task #14: empty views (0 eligible products) are noindex'd and must not
  // be listed. On a product-read failure (products === null) the OLD
  // failure contract applies: every active category/brand keeps its entry
  // (an empty assignment set would otherwise drop them all for a transient
  // read error).
  const assignedCategoryIds = new Set<string>();
  const assignedBrandIds = new Set<string>();
  if (products) {
    for (const product of products) {
      if (product.brand_id) assignedBrandIds.add(product.brand_id);
      for (const categoryId of product.category_ids) {
        assignedCategoryIds.add(categoryId);
      }
    }
  }
  const nonEmptyCategoryIds = products
    ? collectNonEmptyCategoryIds(categories, assignedCategoryIds)
    : new Set(categories.map((category) => category.id));
  const nonEmptyBrandIds = products
    ? collectNonEmptyBrandIds(brands, assignedBrandIds)
    : new Set(brands.map((brand) => brand.id));

  const categoryEntries: MetadataRoute.Sitemap = categories
    .filter((category) => nonEmptyCategoryIds.has(category.id))
    .map((category) => ({
    // Human-readable path form (owner task 2026-09-13): /catalog/<slug> is
    // the canonical of a valid category (lib/seo.ts) and the legacy
    // ?category= query form 308-redirects to it, so the sitemap must list
    // the path shape to keep the «indexable set = sitemap set» invariant.
    // Brand views keep the query form (no path route for brands).
    url: `${base}/catalog/${encodeURIComponent(category.slug)}`,
    lastModified: new Date(category.updated_at),
    changeFrequency: 'daily',
    priority: 0.7,
  }));

  const brandEntries: MetadataRoute.Sitemap = brands
    .filter((brand) => nonEmptyBrandIds.has(brand.id))
    .map((brand) => ({
    url: `${base}/catalog?brand=${encodeURIComponent(brand.slug)}`,
    lastModified: new Date(brand.updated_at),
    changeFrequency: 'weekly',
    priority: 0.6,
  }));

  const productEntries: MetadataRoute.Sitemap = (products ?? [])
    // _du URLs that 301-redirect to base must NOT be listed (spec C invariant:
    // the indexable set is EXACTLY the sitemap set). Policy 2026-09-12
    // («дві ціни на один товар»): ALL verified pairs redirect to base — the
    // price-diff pairs included, so DU_REDIRECT_SLUGS excludes every one of
    // them from the sitemap.
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
