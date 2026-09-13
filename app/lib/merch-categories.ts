/**
 * Merchandising category anchors shared by the nav drawer and the footer
 * (Task #28 internal linking, 2026-09). Pure and runtime-dependency-free so
 * node:test loads it without Supabase (category-seo.ts pattern).
 *
 * Slugs point to the closest existing categories (the labels are
 * merchandising names, not rows in the categories table).
 *
 * The former third anchor «Господарчі товари» (hospodarchi-tovary-1451,
 * the TDD_CATEGORY_SLUG in category-seo.ts) was removed by the owner on
 * 2026-09-12 — the category row is gone from the DB, so the anchor led to
 * a 404. The pinned SEO intent anchor was repointed to
 * mala-kukhonna-tekhnika-69 (see category-seo.ts).
 */

export interface MerchCategory {
  slug: string;
  label: string;
}

export const MERCH_CATEGORIES: readonly MerchCategory[] = [
  { slug: 'mala-kukhonna-tekhnika-69', label: 'Дрібна побутова техніка' },
  { slug: 'velyka-pobutova-tekhnika-739', label: 'Велика побутова техніка' },
] as const;

/** Hard cap so a future category-tree edit can never make the footer endless. */
export const MAX_FOOTER_CATEGORY_LINKS = 15;

export interface FooterCategoryInput {
  id: string;
  name: string;
  slug: string;
  /**
   * Strictly `null` marks a top-level category. `undefined` (a legacy slim
   * prop without the field) is treated as «unknown», not top-level.
   */
  parent_id?: string | null;
}

/**
 * The crawlable footer category list: the merchandising anchors first
 * (merchandising label wins over the DB name), then every OTHER top-level
 * category — the hub pages of the tree. Mid/leaf levels are reachable from
 * their parent hub and their own PDP breadcrumbs; listing all ~205 rows
 * here would be an endless, low-value link farm.
 *
 * Categories absent from `all` (inactive or not-yet-imported) are skipped —
 * never link a URL the catalog cannot resolve.
 */
export function selectFooterCategories(
  all: readonly FooterCategoryInput[]
): FooterCategoryInput[] {
  const bySlug = new Map(all.map((c) => [c.slug, c]));
  const merch = MERCH_CATEGORIES.map((m) => bySlug.get(m.slug)).filter(
    (c): c is FooterCategoryInput => Boolean(c)
  );
  const merchSlugs = new Set(merch.map((c) => c.slug));
  const topLevel = all.filter(
    (c) => c.parent_id === null && !merchSlugs.has(c.slug)
  );
  return [...merch, ...topLevel].slice(0, MAX_FOOTER_CATEGORY_LINKS);
}

/** Merchandising anchor label where one exists, the DB name otherwise. */
export function footerCategoryLabel(
  category: Pick<FooterCategoryInput, 'slug' | 'name'>
): string {
  return (
    MERCH_CATEGORIES.find((m) => m.slug === category.slug)?.label ??
    category.name
  );
}
