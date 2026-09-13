import type { Metadata } from 'next';
import type { Category } from './catalog';
import { compareCategories } from './category-tree.ts';

/**
 * Category-level SEO layer (2026-08). Pure and runtime-dependency-free
 * (type-only import from catalog.ts) so node:test loads it without Supabase.
 *
 * The storefront carries one pinned merchandising category with intent
 * copy, an H1, footer anchor reuse and child-category links. Every other
 * category keeps the generic metadata behavior.
 *
 * History: the pin originally pointed at «Господарчі товари»
 * (hospodarchi-tovary-1451). The owner removed that category on 2026-09-12
 * (row deleted from the DB), so the anchor was repointed to the live
 * merchandising category mala-kukhonna-tekhnika-69 («Дрібна побутова
 * техніка», first entry of MERCH_CATEGORIES in merch-categories.ts).
 */

/** The category pinned to the commercial merchandising intent. */
export const TDD_CATEGORY_SLUG = 'mala-kukhonna-tekhnika-69';

/** Heading above the direct-children link list on NON-pinned categories. */
export const SUBCATEGORIES_HEADING = 'Підкатегорії';

export interface CategorySeoOverride {
  /** Page H1 for the category view (single h1 per page is preserved). */
  h1: string;
  /** <title> override; the canonical/noindex decision is NOT affected. */
  title: string;
  /** meta description override. */
  description: string;
  /** Unique Ukrainian intro paragraphs rendered above the product grid. */
  intro: string[];
  /** Heading above the direct-children link list. */
  introHeading: string;
}

const OVERRIDES: Record<string, CategorySeoOverride> = {
  [TDD_CATEGORY_SLUG]: {
    h1: 'Дрібна побутова техніка',
    // Audit 2026-09-13: the previous tail «— купити в інтернет-магазині
    // Товари для дому» pushed the title to 69 chars (SERP truncation);
    // the brand-only tail fits the ~55-char window with the full intent
    // keyword leading.
    title: 'Дрібна побутова техніка — Товари для дому',
    description:
      'Дрібна побутова техніка в інтернет-магазині «Товари для дому»: блендери, кавомолки, чайники та інша техніка для кухні. Доставка по всій Україні.',
    intro: [
      'У цьому розділі зібрана компактна техніка для щоденних кухонних задач: блендери, кавомолки, міксери, електрочайники та інші дрібні побутові прилади. Асортимент підбирається так, щоб закрити типові потреби дому без великої вбудованої техніки.',
      'Щоб швидше знайти потрібне, скористайтеся підкатегоріями нижче або фільтрами в каталозі. Замовлення доставляємо по всій Україні, а ключові характеристики кожної позиції вказані на сторінці товару.',
    ],
    introHeading: 'Підкатегорії',
  },
};

/** Override for the pinned slug, null for everything else. */
export function getCategorySeo(
  slug: string | undefined
): CategorySeoOverride | null {
  if (!slug) return null;
  return OVERRIDES[slug] ?? null;
}

/**
 * Merge the SEO copy override into already-built catalog view metadata.
 * Indexability/robots/canonical fields are never touched here — the
 * decision stays exclusively in lib/seo.ts. When the built metadata
 * carries openGraph, the override reaches og:title/og:description too:
 * a page-level og object REPLACES the layout default (shallow metadata
 * merge), so leaving the generic og behind would make the messenger card
 * disagree with the SERP snippet on the pinned category.
 */
export function applyCategorySeoMetadata<
  M extends Partial<Pick<Metadata, 'title' | 'description' | 'openGraph'>>,
>(metadata: M, categorySlug: string | undefined): M {
  const seo = getCategorySeo(categorySlug);
  if (!seo) return metadata;
  return {
    ...metadata,
    title: seo.title,
    description: seo.description,
    ...(metadata.openGraph
      ? {
          openGraph: {
            ...metadata.openGraph,
            title: seo.title,
            description: seo.description,
          },
        }
      : {}),
  } as M;
}

/**
 * Direct children of `parentId` from the already-fetched active category
 * list — no extra DB reads. Sorted by the shared commercial rule
 * (sort_order, then ukrainian name, then id) so the rendered link list
 * matches the order used everywhere else in the storefront.
 */
export function listDirectChildren(
  categories: Category[],
  parentId: string
): Category[] {
  return categories
    .filter((category) => category.parent_id === parentId)
    .sort(compareCategories);
}

// ---------------------------------------------------------------------------
// Crawlable path to mid/leaf categories (storefront audit 2026-09, P1).
// The SEO contract (lib/seo.ts + sitemap) says: a category view with 0
// eligible products is noindex,follow and must never be linked. These two
// helpers gate the subcategory-chip block so every pure, indexable
// category view lists ONLY its non-empty direct children. Both stay pure
// and runtime-dependency-free so node:test loads them without Supabase.
// ---------------------------------------------------------------------------

/** Minimal filter shape needed for the pure-view decision (structural). */
export interface CatalogViewFiltersLike {
  categorySlug?: string;
  brandSlug?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort?: string;
  page?: number;
}

/**
 * True for the pure, indexable category view a link block may render on:
 * a single category, page 1, default sort, no other filters. Mirrors the
 * multiFilter branch of decideCatalogIndexing (lib/seo.ts) — anything else
 * (search, brand, price/stock filters, pagination depth, non-default sort)
 * is noindex,follow and stays link-free («noindex pages are not linked»).
 */
export function isPureCategoryView(
  filters: CatalogViewFiltersLike
): boolean {
  return (
    Boolean(filters.categorySlug) &&
    !filters.brandSlug &&
    !filters.search &&
    filters.minPrice === undefined &&
    filters.maxPrice === undefined &&
    !filters.inStockOnly &&
    (filters.sort ?? 'newest') === 'newest' &&
    (filters.page ?? 1) === 1
  );
}

/**
 * Direct children whose view is NON-empty (≥1 eligible product). `countOf`
 * resolves the eligible-product count for a child slug — on the page this
 * is fetchCategoryProductCount (same junction + subtree eligibility shapes
 * as the grid, so a linked child view can never render the empty state).
 * A null/failed count degrades to non-empty — the SAME direction
 * generateMetadata uses, so a transient read error can never silently
 * unlink a whole branch. Children with count === 0 are dropped: their
 * views are noindex and must not be linked.
 */
export async function filterNonEmptyChildren(
  children: Category[],
  countOf: (slug: string) => Promise<number | null>
): Promise<Category[]> {
  if (children.length === 0) return [];
  const counts = await Promise.all(
    children.map((child) => countOf(child.slug))
  );
  return children.filter((_, index) => counts[index] !== 0);
}
