import type { Metadata } from 'next';

/**
 * Pure SEO decision layer for the storefront (spec 2026-08-26).
 *
 * Canonical/noindex policy: the indexable set is EXACTLY the sitemap set —
 * bare /catalog plus single valid category/brand views on page 1 with the
 * default sort and no extra filters. Everything else (search results, filter
 * combinations, pagination depth, unknown slugs) is noindex,follow WITHOUT a
 * canonical tag: Google ignores canonicals on noindexed pages, and emitting
 * one would send contradictory signals. Unknown category/brand slugs stay a
 * normal 200 empty state — they are filter VALUES on an existing resource
 * (/catalog), not missing resources (approved decision A of the spec).
 */

export const SITE_NAME = 'E-Shop';

/** Default sort value of /catalog — anything else is a duplicate-content view. */
const DEFAULT_SORT = 'newest';

export interface CatalogIndexInput {
  search?: string;
  categorySlug?: string;
  brandSlug?: string;
  /** slug resolved to an ACTIVE entity (fetchCategoryBySlug/fetchBrandBySlug) */
  categoryFound?: boolean;
  brandFound?: boolean;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort?: string;
  page?: number;
}

export interface IndexingDecision {
  indexable: boolean;
  /** Absolute-path canonical for THIS url; null → omit the tag entirely. */
  canonicalPath: string | null;
}

export function decideCatalogIndexing(
  input: CatalogIndexInput
): IndexingDecision {
  const hasSearch = Boolean(input.search);
  const categoryRequested = Boolean(input.categorySlug);
  const brandRequested = Boolean(input.brandSlug);
  const categoryValid =
    categoryRequested && input.categorySlug !== undefined && input.categoryFound === true;
  const brandValid =
    brandRequested && input.brandSlug !== undefined && input.brandFound === true;

  const invalidSlug =
    (categoryRequested && !categoryValid) || (brandRequested && !brandValid);
  const multiFilter =
    (categoryRequested && brandRequested) ||
    input.minPrice !== undefined ||
    input.maxPrice !== undefined ||
    input.inStockOnly === true ||
    (input.sort ?? DEFAULT_SORT) !== DEFAULT_SORT ||
    (input.page ?? 1) > 1;

  if (hasSearch || invalidSlug || multiFilter) {
    return { indexable: false, canonicalPath: null };
  }

  if (categoryValid) {
    return {
      indexable: true,
      canonicalPath: `/catalog?category=${encodeURIComponent(input.categorySlug!)}`,
    };
  }
  if (brandValid) {
    return {
      indexable: true,
      canonicalPath: `/catalog?brand=${encodeURIComponent(input.brandSlug!)}`,
    };
  }
  return { indexable: true, canonicalPath: '/catalog' };
}

/**
 * Normalize a raw user query for display in <title>/description:
 * strip control characters (they have no place in SERP snippets), collapse
 * whitespace, hard-cap length. PostgREST specials were already handled by
 * sanitizeSearchTerm for QUERIES; this is purely presentation-side.
 */
export function truncateQuery(raw: string, max = 50): string {
  const cleaned = raw
    // Non-whitespace control bytes are garbage → removed; \t\n\r fall
    // through and are treated as ordinary whitespace separators below.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[%,()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, max);
}

export interface CatalogViewMetadataArgs {
  input: CatalogIndexInput;
  categoryName?: string;
  brandName?: string;
}

type ViewMetadata = Pick<
  Metadata,
  'title' | 'description' | 'robots' | 'alternates'
>;

export function buildCatalogViewMetadata(
  args: CatalogViewMetadataArgs
): ViewMetadata {
  const { input, categoryName, brandName } = args;
  const decision = decideCatalogIndexing(input);

  let title = `Каталог товарів | ${SITE_NAME}`;
  let description =
    'Каталог товарів інтернет-магазину E-Shop з фільтрами та сортуванням.';

  if (input.search) {
    const q = truncateQuery(input.search);
    title = `Пошук: «${q}» | ${SITE_NAME}`;
    description = `Результати пошуку за запитом «${q}» в інтернет-магазині ${SITE_NAME}.`;
  } else if (input.categorySlug && categoryName) {
    title = `${categoryName} — купити в ${SITE_NAME}`;
    description = `Товари у категорії «${categoryName}» — купити в інтернет-магазині ${SITE_NAME}.`;
  } else if (input.brandSlug && brandName) {
    title = `${brandName} — купити в ${SITE_NAME}`;
    description = `Товари бренду ${brandName} — купити в інтернет-магазині ${SITE_NAME}.`;
  }

  return {
    title,
    description,
    ...(decision.indexable ? {} : { robots: { index: false, follow: true } }),
    ...(decision.canonicalPath
      ? { alternates: { canonical: decision.canonicalPath } }
      : {}),
  };
}
