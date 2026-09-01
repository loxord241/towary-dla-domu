import type { Metadata } from 'next';

/**
 * Canonical/noindex policy for the storefront (spec 2026-08-26 + Task #14
 * 2026-09): the indexable set is EXACTLY the sitemap set — bare /catalog
 * plus single valid, NON-EMPTY category/brand views on page 1 with the
 * default sort and no extra filters. «Non-empty» means ≥1 eligible product
 * (active + ≥1 photo; category counts follow the junction + subtree
 * semantics of fetchCatalogProducts). Everything else (search results,
 * filter combinations, pagination depth, empty views, unknown slugs) is
 * noindex,follow WITHOUT a canonical tag: Google ignores canonicals on
 * noindexed pages, and emitting one would send contradictory signals.
 * Unknown category/brand slugs stay a normal 200 empty state — they are
 * filter VALUES on an existing resource (/catalog), not missing resources
 * (approved decision A of the spec).
 */

export const SITE_NAME = 'Товари для дому';

/** Default sort value of /catalog — anything else is a duplicate-content view. */
const DEFAULT_SORT = 'newest';

export interface CatalogIndexInput {
  search?: string;
  categorySlug?: string;
  brandSlug?: string;
  /** slug resolved to an ACTIVE entity (fetchCategoryBySlug/fetchBrandBySlug) */
  categoryFound?: boolean;
  brandFound?: boolean;
  /**
   * Eligible-product fact for the requested view (Task #14): false marks an
   * EMPTY view (0 eligible products) → noindex. Undefined = fact unknown →
   * treated as non-empty so callers that cannot measure it keep legacy
   * behavior. Never read for the non-requested entity.
   */
  categoryHasProducts?: boolean;
  brandHasProducts?: boolean;
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
  const emptyView =
    (categoryValid && input.categoryHasProducts === false) ||
    (brandValid && input.brandHasProducts === false);
  const multiFilter =
    (categoryRequested && brandRequested) ||
    input.minPrice !== undefined ||
    input.maxPrice !== undefined ||
    input.inStockOnly === true ||
    (input.sort ?? DEFAULT_SORT) !== DEFAULT_SORT ||
    (input.page ?? 1) > 1;

  if (hasSearch || invalidSlug || emptyView || multiFilter) {
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
    'Каталог товарів інтернет-магазину Товари для дому з фільтрами та сортуванням.';

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

// ---------------------------------------------------------------------------
// PDP meta-description policy (audit 2026-08-31)
//
// Two classes of supplier descriptions must NOT leak into meta descriptions:
//   1) placeholder HTML — tags/whitespace/nbsp only (133 live products);
//   2) brand boilerplate templates shared verbatim across hundreds of
//      products (Tramontina/Luminarc/Pyrex families) — the first 160 chars
//      produced massive duplicated metas.
// Policy: short_description → unique description (capped) → generic
// name-based fallback. Nothing is ever invented: the fallback is the same
// name-based template the page already used. Visible page content,
// Product JSON-LD, sitemap and canonicals are intentionally NOT affected.
// ---------------------------------------------------------------------------

/** HTML → plain text (same normalization the page used for metas). */
function htmlToPlainText(html: string | null | undefined): string {
  return (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the description carries no text at all (tags/nbsp/whitespace). */
export function isPlaceholderDescription(html: string | null | undefined): boolean {
  return htmlToPlainText(html) === '';
}

/**
 * Supplier boilerplate markers (audit 2026-08-31, verified on live data).
 * Matched case-insensitively on the PLAIN text; extend only with a
 * marker verified against real duplicated descriptions.
 */
const BOILERPLATE_MARKERS: readonly string[] = [
  'кожен виріб', // Tramontina family (×377)
  'бренд високоякісного посуду', // Luminarc family (×229, with/without ®)
  'винайдений у франції', // Pyrex family (×91)
];

/** True when the description is a shared supplier template. */
export function isBoilerplateDescription(html: string | null | undefined): boolean {
  const plain = htmlToPlainText(html).toLowerCase();
  if (plain === '') return false;
  return BOILERPLATE_MARKERS.some((marker) => plain.includes(marker));
}

export interface ProductMetaDescriptionInput {
  productName: string;
  shortDescription?: string | null;
  description?: string | null;
}

/**
 * Meta description for a product page. Chain: short_description →
 * unique description (capped at 160) → generic name-based template.
 * Always returns a non-empty string (the page previously fell back to the
 * same template inline).
 */
export function buildProductMetaDescription(
  input: ProductMetaDescriptionInput
): string {
  const cap = (text: string): string | undefined => {
    const plain = htmlToPlainText(text);
    return plain ? plain.slice(0, 160) : undefined;
  };
  return (
    cap(input.shortDescription ?? '') ??
    (!isPlaceholderDescription(input.description) &&
    !isBoilerplateDescription(input.description)
      ? cap(input.description ?? '')
      : undefined) ??
    `Купити ${input.productName} в інтернет-магазині ${SITE_NAME}.`
  );
}
