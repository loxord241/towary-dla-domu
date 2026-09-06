// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import type { YcCategoryNode } from './types.ts';
import type { ExistingCategoryRow, CategoryPlan } from './import-plan.ts';
import { buildCategoryPlan } from './import-plan.ts';
import { collectExpandedIds } from './selection.ts';
import type { YcSelectedCategory } from './selection.ts';

/**
 * Pure planning for the one-time Yugcontract category remap (incident
 * 2026-09: the supplier regenerated category ids while the feed was
 * collapsed). Everything here is side-effect free so the mapping, the
 * verification forecast and the generated SQL can be inspected and
 * unit-tested BEFORE anything touches production.
 *
 * Identity rule: an old yugcontract_id is matched to a new one ONLY by the
 * FULL normalized name path (root -> ... -> node). Leaf names repeat across
 * branches in this tree, so name-only or id-only matching is forbidden.
 */

export const PATH_SEPARATOR = ' \u2192 '; // " -> "

/** Whitespace/case-insensitive name key used for path matching. */
export function normalizeNameKey(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Minimal node shape needed from the fresh supplier tree. */
export interface RemapSupplierNode {
  externalId: string;
  parentId: string | null;
  name: string;
}

/** Row shape of our-categories.json (mirrors the categories table). */
export interface OurCategoryRow {
  id: string;
  yugcontract_id: string | null;
  name: string;
  slug: string;
  parent_id: string | null;
}

// ---------------------------------------------------------------------------
// Full-path index over the fresh supplier tree
// ---------------------------------------------------------------------------

/**
 * Map normalized full path -> external ids. Multiple ids under one path are
 * legitimate supplier-side duplicates (reported as ambiguous downstream).
 * Cycles and orphans are tolerated: an orphan's path starts at itself.
 */
export function buildSupplierPathIndex(
  nodes: readonly RemapSupplierNode[]
): Map<string, string[]> {
  const byId = new Map<string, RemapSupplierNode>();
  for (const n of nodes) byId.set(n.externalId, n);

  const paths = new Map<string, string>();
  const pathOf = (id: string, guard: Set<string>): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    if (guard.has(id)) return normalizeNameKey(byId.get(id)?.name ?? id); // cycle guard
    guard.add(id);
    const node = byId.get(id);
    if (!node) return id;
    const key = normalizeNameKey(node.name);
    const full =
      node.parentId !== null && byId.has(node.parentId)
        ? `${pathOf(node.parentId, guard)}${PATH_SEPARATOR}${key}`
        : key;
    paths.set(id, full);
    return full;
  };
  for (const n of nodes) pathOf(n.externalId, new Set());

  const index = new Map<string, string[]>();
  for (const n of nodes) {
    const p = paths.get(n.externalId)!;
    const list = index.get(p);
    if (list) list.push(n.externalId);
    else index.set(p, [n.externalId]);
  }
  return index;
}

/**
 * Full normalized path of one OUR row (via the uuid parent chain of the
 * categories snapshot). Manual rows participate as path nodes — only their
 * names matter here, never their (null) yugcontract_id.
 */
export function buildOurPath(
  row: OurCategoryRow,
  rowsById: ReadonlyMap<string, OurCategoryRow>
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur: OurCategoryRow | undefined = row;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.push(normalizeNameKey(cur.name));
    cur = cur.parent_id !== null ? rowsById.get(cur.parent_id) : undefined;
  }
  return parts.reverse().join(PATH_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Mapping old yugcontract_id -> new yugcontract_id
// ---------------------------------------------------------------------------

export interface RemapMappingEntry {
  old_yc_id: string;
  new_yc_id: string;
  /** our categories.id (uuid) this mapping will UPDATE */
  db_category_id: string;
  name: string;
  /** normalized full path the match was made on */
  path: string;
  /** true when the new id happens to equal the old one */
  unchanged: boolean;
}

export interface RemapUnmatched {
  old_yc_id: string;
  db_category_id: string;
  name: string;
  path: string;
}

export interface RemapAmbiguous {
  path: string;
  candidate_new_ids: string[];
  /** our rows that hit this ambiguous path */
  old_yc_ids: string[];
}

export interface RemapConflict {
  path: string;
  new_yc_id: string;
  /** two+ of OUR rows claim the same supplier node — owner decides */
  old_yc_ids: string[];
}

export interface RemapResult {
  mappings: RemapMappingEntry[];
  unmatched: RemapUnmatched[];
  ambiguous: RemapAmbiguous[];
  conflicts: RemapConflict[];
}

/**
 * Match every snapshot row that HAS a yugcontract_id against the fresh tree
 * by full normalized path. Never guesses: zero or multiple candidates stay
 * out of `mappings` and are reported for the owner's decision.
 */
export function buildRemapMapping(
  supplierNodes: readonly RemapSupplierNode[],
  ourRows: readonly OurCategoryRow[]
): RemapResult {
  const index = buildSupplierPathIndex(supplierNodes);
  const rowsById = new Map<string, OurCategoryRow>(ourRows.map((r) => [r.id, r]));

  const mappings: RemapMappingEntry[] = [];
  const unmatched: RemapUnmatched[] = [];
  const ambiguousMap = new Map<string, RemapAmbiguous>();

  for (const row of ourRows) {
    if (row.yugcontract_id === null) continue; // manual category — not remapped
    const path = buildOurPath(row, rowsById);
    const candidates = index.get(path) ?? [];
    if (candidates.length === 0) {
      unmatched.push({
        old_yc_id: row.yugcontract_id,
        db_category_id: row.id,
        name: row.name,
        path,
      });
      continue;
    }
    if (candidates.length > 1) {
      const existing = ambiguousMap.get(path);
      if (existing) existing.old_yc_ids.push(row.yugcontract_id);
      else
        ambiguousMap.set(path, {
          path,
          candidate_new_ids: [...candidates],
          old_yc_ids: [row.yugcontract_id],
        });
      continue;
    }
    const newId = candidates[0];
    if (newId === undefined) continue; // unreachable (candidates.length === 1)
    mappings.push({
      old_yc_id: row.yugcontract_id,
      new_yc_id: newId,
      db_category_id: row.id,
      name: row.name,
      path,
      unchanged: newId === row.yugcontract_id,
    });
  }

  // Bijection pre-check: two of OUR rows matched the same single supplier
  // node -> neither is written; the owner resolves the duplicate path.
  const byNew = new Map<string, RemapMappingEntry[]>();
  for (const m of mappings) {
    const list = byNew.get(m.new_yc_id);
    if (list) list.push(m);
    else byNew.set(m.new_yc_id, [m]);
  }
  const conflicts: RemapConflict[] = [];
  const conflictedOlds = new Set<string>();
  for (const [newId, list] of byNew) {
    if (list.length <= 1) continue;
    conflicts.push({
      path: list[0]!.path,
      new_yc_id: newId,
      old_yc_ids: list.map((m) => m.old_yc_id),
    });
    for (const m of list) conflictedOlds.add(m.old_yc_id);
  }
  const finalMappings = conflicts.length
    ? mappings.filter((m) => !conflictedOlds.has(m.old_yc_id))
    : mappings;

  return { mappings: finalMappings, unmatched, ambiguous: [...ambiguousMap.values()], conflicts };
}

/** Post-check on a persisted mapping.json: each old once, each new once. */
export function verifyBijection(
  mappings: readonly { old_yc_id: string; new_yc_id: string }[]
): string[] {
  const errors: string[] = [];
  const byOld = new Map<string, number>();
  const byNew = new Map<string, number>();
  for (const m of mappings) {
    byOld.set(m.old_yc_id, (byOld.get(m.old_yc_id) ?? 0) + 1);
    byNew.set(m.new_yc_id, (byNew.get(m.new_yc_id) ?? 0) + 1);
  }
  for (const [oldId, n] of byOld) {
    if (n > 1) errors.push(`старий id ${oldId} зустрічається ${n} разів`);
  }
  for (const [newId, n] of byNew) {
    if (n > 1) errors.push(`новий id ${newId} призначено ${n} різним старим категоріям`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Post-remap forecast (reuses the importer's pure planners)
// ---------------------------------------------------------------------------

export interface RemapForecast {
  /** selection expanded over the fresh tree (assumption: same subtrees) */
  expandedCount: number;
  plan: CategoryPlan;
  /** unmatched rows that still hold products — the real impact list */
  unmatchedWithProducts: { old_yc_id: string; name: string; products: number }[];
  /** supplier tree nodes inside the expanded selection WITHOUT a remapped row */
  createsPreview: { yugcontract_id: string; name: string }[];
}

/**
 * Simulate the categories table AFTER apply.sql and run the importer's
 * buildCategoryPlan against the fresh tree. Criterion for Monday:
 * plan.creates.length === 0 (and conflicts empty). Assumes the regenerated
 * selection.ts covers exactly the remapped subtrees — i.e. its ids are the
 * `newSelectionIds` (the mapped ids of the previously approved nodes).
 */
export function forecastRemap(
  supplierNodes: readonly YcCategoryNode[],
  ourRows: readonly OurCategoryRow[],
  mappingPairs: readonly { old_yc_id: string; new_yc_id: string }[],
  productsByOldYcId: ReadonlyMap<string, number>
): RemapForecast {
  const oldToNew = new Map(mappingPairs.map((m) => [m.old_yc_id, m.new_yc_id]));
  const newIds = [...new Set(mappingPairs.map((m) => m.new_yc_id))];

  const simulated: ExistingCategoryRow[] = ourRows.map((r) => ({
    ...r,
    yugcontract_id: r.yugcontract_id !== null ? oldToNew.get(r.yugcontract_id) ?? r.yugcontract_id : null,
  }));

  const { expanded } = collectExpandedIds(supplierNodes, newIds);
  const plan = buildCategoryPlan(supplierNodes, expanded, simulated);

  const unmatchedWithProducts = ourRows
    .filter((r) => r.yugcontract_id !== null && !oldToNew.has(r.yugcontract_id))
    .map((r) => ({
      old_yc_id: r.yugcontract_id as string,
      name: r.name,
      products: productsByOldYcId.get(r.yugcontract_id as string) ?? 0,
    }))
    .sort((a, b) => b.products - a.products);

  const createsPreview = plan.creates.slice(0, 50).map((c) => ({
    yugcontract_id: c.yugcontract_id,
    name: c.name,
  }));

  return {
    expandedCount: expanded.size,
    plan,
    unmatchedWithProducts,
    createsPreview,
  };
}

// ---------------------------------------------------------------------------
// Selection draft (pure transform of SELECTED_CATEGORIES)
// ---------------------------------------------------------------------------

export interface SelectionDraftResult {
  tree: YcSelectedCategory[];
  /** old ids that had no mapping — kept verbatim, flagged */
  unresolvedOldIds: string[];
}

/** Replace every node id through the mapping; structure/names preserved. */
export function mapSelectionTree(
  selection: readonly YcSelectedCategory[],
  oldToNew: ReadonlyMap<string, string>
): SelectionDraftResult {
  const unresolved: string[] = [];
  const walk = (nodes: readonly YcSelectedCategory[]): YcSelectedCategory[] =>
    nodes.map((node) => {
      const mapped = oldToNew.get(node.id);
      if (mapped === undefined) unresolved.push(node.id);
      return {
        id: mapped ?? node.id,
        name: node.name,
        children: walk(node.children),
      };
    });
  return { tree: walk(selection), unresolvedOldIds: unresolved };
}

// ---------------------------------------------------------------------------
// apply.sql generation (the manual apply step stays 100% human-driven)
// ---------------------------------------------------------------------------

/** One UPDATE per mapping, guarded by the old value; single transaction. */
export function buildApplySql(
  mappings: readonly RemapMappingEntry[],
  generatedAt: string
): string {
  const lines: string[] = [
    '-- Yugcontract category remap — apply.sql (generated by',
    '-- scripts/yugcontract-category-remap.ts --dry-run; DO NOT edit by hand).',
    `-- Generated: ${generatedAt}`,
    '-- Statements: ' + mappings.length,
    '-- Safety: every UPDATE is guarded by the OLD yugcontract_id, so a',
    '-- re-run is a no-op and a drifted table changes nothing. Review, then',
    '-- run manually in the Supabase SQL Editor.',
    '-- Rollback: swap SET/WHERE values (old ids are in the comments).',
    '',
    'BEGIN;',
    '',
  ];
  for (const m of mappings) {
    const note = m.unchanged ? ' -- (id без змін)' : '';
    lines.push(
      `UPDATE categories SET yugcontract_id = '${m.new_yc_id}' WHERE id = '${m.db_category_id}' AND yugcontract_id = '${m.old_yc_id}'; -- ${m.name}${note}`
    );
  }
  lines.push('', 'COMMIT;', '');
  return lines.join('\n');
}
