import type { Category } from './catalog';

/**
 * Pure category-hierarchy helpers for the catalog category picker.
 *
 * The live categories table is a tree (205 active rows: 11 roots, depth ≤ 3,
 * several duplicate names across different branches). A flat <select> hides
 * that structure, so these helpers produce display options carrying the
 * root→leaf path: duplicates stay distinguishable («Декор → Глечики» vs
 * «Кухонний посуд → Глечики») and search can match against a parent name.
 *
 * Everything here is pure and synchronous — the caller already holds the
 * full category set fetched server-side (fetchActiveCategories), so no
 * additional database reads happen anywhere in this module.
 */

export interface CategoryOption {
  id: string;
  slug: string;
  /** leaf name only */
  name: string;
  /** 0 for roots */
  depth: number;
  /** labels from root to this node, inclusive */
  path: string[];
  /** full disambiguated label: path joined with ' → ' */
  label: string;
}

/**
 * Sibling ordering is a commercial rule shared by storefront and admin:
 * explicit sort_order wins, deterministic fallbacks (ukrainian name, then
 * id) keep ties stable — never created_at, never input order.
 */
export function compareCategories(a: Category, b: Category): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  const byName = a.name.localeCompare(b.name, 'uk');
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

function compareSiblings(a: Category, b: Category): number {
  return compareCategories(a, b);
}

/**
 * Category ids of `seedId` plus every descendant (any depth). Direct
 * assignments live in product_categories; parent categories are found by
 * expanding the subtree in memory over the already-fetched active list.
 * Cycle-safe: each node enters the set at most once.
 */
export function collectSubtreeIds(
  categories: Category[],
  seedId: string
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  const known = new Set(categories.map((c) => c.id));
  for (const category of categories) {
    const parentId = category.parent_id;
    if (parentId && known.has(parentId)) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(category.id);
      childrenOf.set(parentId, list);
    }
  }
  const out = new Set<string>([seedId]);
  const stack = [seedId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}

/**
 * Build display options in tree order (depth-first from the roots).
 * Defensive by design:
 *  - a node whose parent is missing from the input set is treated as a root
 *    (the storefront fetch returns only active rows);
 *  - parent/child cycles cannot hang the walk and lose no nodes.
 *
 * `opts.expanded` (when provided) drives the collapsible tree picker: only
 * parents present in the set render their children. Without it the FULL
 * tree is emitted — every existing consumer keeps its behavior.
 */
export function buildCategoryOptions(
  categories: Category[],
  opts?: { expanded?: ReadonlySet<string> }
): CategoryOption[] {
  const expanded = opts?.expanded;
  const childrenOf = new Map<string, Category[]>();
  const knownIds = new Set(categories.map((c) => c.id));
  const roots: Category[] = [];

  for (const category of categories) {
    const parentId = category.parent_id;
    if (parentId && knownIds.has(parentId)) {
      // An unexpanded parent hides its children from the flat option list.
      if (!expanded || expanded.has(parentId)) {
        const list = childrenOf.get(parentId) ?? [];
        list.push(category);
        childrenOf.set(parentId, list);
      }
    } else {
      // True roots and orphans are always visible — only parents toggle.
      roots.push(category);
    }
  }

  // Roots keep the same ordering rules as siblings.
  roots.sort(compareSiblings);

  const options: CategoryOption[] = [];
  const visited = new Set<string>();

  const walk = (node: Category, path: string[]): void => {
    // Cycle guard: a node reached twice keeps its first (shallowest) placement.
    if (visited.has(node.id)) return;
    visited.add(node.id);

    const nextPath = [...path, node.name];
    options.push({
      id: node.id,
      slug: node.slug,
      name: node.name,
      depth: nextPath.length - 1,
      path: nextPath,
      label: nextPath.join(' → '),
    });
    for (const child of (childrenOf.get(node.id) ?? []).sort(compareSiblings)) {
      walk(child, nextPath);
    }
  };

  for (const root of roots) walk(root, []);
  if (expanded) {
    // Collapsible mode: unvisited nodes here are INTENTIONALLY hidden
    // (collapsed parents), not lost — the fallback below must not run.
    return options;
  }
  // Nodes unreachable from any root (e.g. parent/child cycles among
  // themselves) must not disappear: surface them as pseudo-roots.
  for (const node of categories) {
    if (!visited.has(node.id)) walk(node, []);
  }
  return options;
}

/** Case-insensitive trimmed query; empty query matches everything. */
export function filterCategoryOptions(
  options: CategoryOption[],
  query: string
): CategoryOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) =>
    option.path.some((part) => part.toLowerCase().includes(needle))
  );
}
