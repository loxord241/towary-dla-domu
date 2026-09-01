/**
 * Bounded paged collection for the sitemap builder. PostgREST caps any
 * response at 1000 rows, so product enumeration walks explicit windows;
 * the CALLER owns ordering (.order('id')) — this module owns termination
 * (short page ⇒ done) and the absolute row cap that bounds worst-case
 * latency no matter how large the catalog grows.
 */
const MAX_PAGE_SIZE = 1000;
const DEFAULT_MAX_ROWS = 100_000;

export async function collectPaged<T>(
  fetchPage: (from: number, limit: number) => Promise<T[]>,
  opts: { pageSize?: number; maxRows?: number } = {}
): Promise<T[]> {
  const pageSize = Math.min(
    Math.max(opts.pageSize ?? MAX_PAGE_SIZE, 1),
    MAX_PAGE_SIZE
  );
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

  const out: T[] = [];
  let from = 0;
  for (;;) {
    const limit = Math.min(pageSize, maxRows - out.length);
    if (limit <= 0) return out;
    const rows = await fetchPage(from, limit);
    out.push(...rows);
    if (rows.length < limit) return out;
    from += limit;
  }
}

// ---------------------------------------------------------------------------
// Task #14 (2026-09): empty category/brand views (0 eligible products) are
// noindex'd (lib/seo.ts) and must stay OUT of the sitemap. These PURE
// helpers decide which entries survive, mirroring the storefront
// eligibility: a category view is non-empty when IT or any descendant holds
// a direct product_categories assignment (same subtree semantics as
// fetchCatalogProducts); a brand view when ≥1 eligible product carries its
// brand_id. Cycle-safe and dependency-free so node:test loads it without
// Supabase.
// ---------------------------------------------------------------------------

export interface SubtreeCategoryLike {
  id: string;
  parent_id?: string | null;
}

/**
 * Category ids whose subtree holds ≥1 directly assigned product id.
 * Implementation walks UP from each assigned id: the assignment makes that
 * node and every ancestor non-empty. Unknown assigned ids are ignored;
 * categories whose parent is missing from the list behave as roots.
 */
export function collectNonEmptyCategoryIds(
  categories: ReadonlyArray<SubtreeCategoryLike>,
  assignedCategoryIds: ReadonlySet<string>
): Set<string> {
  const known = new Set(categories.map((c) => c.id));
  const parentOf = new Map<string, string>();
  for (const category of categories) {
    if (category.parent_id && known.has(category.parent_id)) {
      parentOf.set(category.id, category.parent_id);
    }
  }
  const nonEmpty = new Set<string>();
  for (const assignedId of assignedCategoryIds) {
    if (!known.has(assignedId)) continue;
    let cursor: string | undefined = assignedId;
    // A node already marked stops the walk — also the cycle guard.
    while (cursor && !nonEmpty.has(cursor)) {
      nonEmpty.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
  return nonEmpty;
}

/**
 * Brand ids of the given list that have ≥1 eligible assignment.
 */
export function collectNonEmptyBrandIds(
  brands: ReadonlyArray<{ id: string }>,
  assignedBrandIds: ReadonlySet<string>
): Set<string> {
  const out = new Set<string>();
  for (const brand of brands) {
    if (assignedBrandIds.has(brand.id)) out.add(brand.id);
  }
  return out;
}
