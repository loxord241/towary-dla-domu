// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import type { YcCategoryNode, YcProduct } from './types';
import { slugifyText, slugWithId } from './translit.ts';

/**
 * Pure planning for the Yugcontract import (stage 2B).
 *
 * Everything here is side-effect free so the exact writes about to hit
 * production can be inspected and unit-tested BEFORE any execution.
 * Identity rules (project invariants):
 *   - categories: Yugcontract category id (stored in categories.yugcontract_id)
 *   - brands:     exact normalized name match first; creation otherwise
 *   - products:   Yugcontract id → products.yugcontract_id, never name/sku
 */

export function normalizeBrandKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function bareKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9а-яїієґ]/g, '');
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface ExistingCategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  yugcontract_id: string | null;
}

export interface CategoryCreateOp {
  yugcontract_id: string;
  name: string;
  slug: string;
  /** parent supplier id (null when the parent lives outside the selection) */
  parentYcId: string | null;
}

export interface CategoryUpdateOp {
  id: string;
  name?: string;
  parentYcId?: string | null;
}

export interface CategoryPlan {
  /** parents strictly precede children */
  creates: CategoryCreateOp[];
  updates: CategoryUpdateOp[];
  /** blocking problems (e.g. slug owned by a manual category) */
  conflicts: string[];
}

/** Depth inside the EXPANDED set; parents outside it are treated as roots. */
function depthsInSelection(
  byId: Map<string, YcCategoryNode>,
  expanded: ReadonlySet<string>
): Map<string, number> {
  const depths = new Map<string, number>();
  const depthOf = (id: string, guard: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (guard.has(id)) return 0; // cycle guard
    guard.add(id);
    const node = byId.get(id);
    let depth = 0;
    if (node && node.parentId !== null && expanded.has(node.parentId)) {
      depth = depthOf(node.parentId, guard) + 1;
    }
    depths.set(id, depth);
    return depth;
  };
  for (const id of expanded) depthOf(id, new Set());
  return depths;
}

export function buildCategoryPlan(
  nodes: readonly YcCategoryNode[],
  expanded: ReadonlySet<string>,
  existingRows: readonly ExistingCategoryRow[]
): CategoryPlan {
  const byId = new Map(nodes.map((n) => [n.externalId, n]));
  const depths = depthsInSelection(byId, expanded);

  const existingByYc = new Map<string, ExistingCategoryRow>();
  const uuidToYc = new Map<string, string>();
  const manualSlugs = new Set<string>();
  for (const row of existingRows) {
    if (row.yugcontract_id !== null) {
      existingByYc.set(row.yugcontract_id, row);
      uuidToYc.set(row.id, row.yugcontract_id);
    } else {
      manualSlugs.add(row.slug);
    }
  }

  const creates: CategoryCreateOp[] = [];
  const updates: CategoryUpdateOp[] = [];
  const conflicts: string[] = [];
  const plannedSlugs = new Set<string>();

  const ordered = [...expanded].sort(
    (a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0) || Number(a) - Number(b)
  );

  for (const id of ordered) {
    const node = byId.get(id);
    if (!node) continue; // cannot happen: expanded ⊆ live tree ids
    const parentYcId =
      node.parentId !== null && expanded.has(node.parentId) && byId.has(node.parentId)
        ? node.parentId
        : null;

    const existing = existingByYc.get(id);
    if (!existing) {
      const slug = slugWithId(node.name, id);
      if (manualSlugs.has(slug) || plannedSlugs.has(slug)) {
        conflicts.push(
          `категорія "${node.name}" [${id}]: slug "${slug}" вже зайнятий іншою категорією`
        );
        continue;
      }
      plannedSlugs.add(slug);
      creates.push({ yugcontract_id: id, name: node.name, slug, parentYcId });
    } else {
      const currentParentYc = uuidToYc.get(existing.parent_id ?? '') ?? null;
      const patch: CategoryUpdateOp = { id: existing.id };
      let dirty = false;
      if (existing.name !== node.name) {
        patch.name = node.name;
        dirty = true;
      }
      if ((currentParentYc ?? null) !== (parentYcId ?? null)) {
        patch.parentYcId = parentYcId;
        dirty = true;
      }
      if (dirty) updates.push(patch);
    }
  }

  return { creates, updates, conflicts };
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export interface ExistingBrandRow {
  id: string;
  name: string;
  slug: string;
}

export interface BrandPlan {
  /** normalized feed brand → existing brand uuid */
  links: Map<string, string>;
  /** brands that truly do not exist yet (exact normalized match missed) */
  creates: { name: string; slug: string }[];
  /** bare-key collisions kept SEPARATE on purpose — reported, never merged */
  nearMatches: { ycBrand: string; ourBrand: string }[];
}

export function buildBrandPlan(
  feedBrandNames: readonly string[],
  ourBrands: readonly ExistingBrandRow[]
): BrandPlan {
  const byExact = new Map<string, ExistingBrandRow>();
  const byBare = new Map<string, ExistingBrandRow>();
  const bySlug = new Set<string>();
  for (const b of ourBrands) {
    byExact.set(normalizeBrandKey(b.name), b);
    byBare.set(bareKey(b.name), b);
    bySlug.add(b.slug);
  }

  const links = new Map<string, string>();
  const creates: BrandPlan['creates'] = [];
  const nearMatches: BrandPlan['nearMatches'] = [];
  const usedSlugs = new Set(bySlug);
  const plannedKeys = new Set<string>();

  for (const raw of feedBrandNames) {
    const key = normalizeBrandKey(raw);
    if (key === '') continue;
    const exact = byExact.get(key);
    if (exact) {
      links.set(key, exact.id);
      continue;
    }
    // Potentially-same-but-not-exact: keep separate, surface to humans.
    if (!nearMatches.some((n) => normalizeBrandKey(n.ycBrand) === key)) {
      const bareHit = byBare.get(bareKey(raw));
      if (bareHit) nearMatches.push({ ycBrand: raw, ourBrand: bareHit.name });
    }
    // identical normalized key planned once only
    if (plannedKeys.has(key)) continue;
    plannedKeys.add(key);

    let slug = slugifyText(raw, 80) || 'brand';
    while (usedSlugs.has(slug)) slug = `${slug}-yc`;
    usedSlugs.add(slug);
    creates.push({ name: raw, slug });
  }

  return { links, creates, nearMatches };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface MappedProductRow {
  yugcontract_id: string;
  sku: string;
  slug: string;
  name: string;
  /**
   * Storefront price = supplier RRP (business rule 2026-08).
   * null = feed has no valid RRP → never invent a value: new products are
   * not created and existing prices are left untouched.
   */
  price: number | null;
  /** Always null: the supplier `price` is NOT a proven store discount. */
  old_price: number | null;
  stock_quantity: number;
  availability_status: 'in_stock' | 'out_of_stock';
  /** normalized brand key; resolved to brand_id at apply time */
  brandKey: string | null;
  /** supplier category id; resolved to category_id at apply time */
  catYcId: string | null;
}

export interface SkipEntry {
  id: string;
  reason: string;
}

export function mapFeedProducts(
  products: readonly YcProduct[]
): { rows: MappedProductRow[]; skipped: SkipEntry[] } {
  const rows: MappedProductRow[] = [];
  const skipped: SkipEntry[] = [];

  /** RRP is the only accepted storefront price source; must be positive. */
  const validRrp = (v: number | null): v is number =>
    v !== null && Number.isFinite(v) && v > 0;

  for (const p of products) {
    if (p.externalId === '') {
      skipped.push({ id: '(порожній id)', reason: 'немає external id' });
      continue;
    }
    if (p.nameUkr === '') {
      skipped.push({ id: p.externalId, reason: 'порожня назва' });
      continue;
    }
    // NOTE: supplier `price` is no longer a price source — only RRP is.
    // A missing RRP no longer skips the row: stock/name still sync, the
    // price decision happens in splitProductWrites (insert vs update).
    if (!validRrp(p.rrp) && p.price === null) {
      skipped.push({ id: p.externalId, reason: 'немає ні RRP, ні ціни у фіді' });
      continue;
    }
    if (p.catId === null) {
      skipped.push({ id: p.externalId, reason: 'немає категорії у фіді' });
      continue;
    }

    const stock = Math.max(0, Math.round(p.qtyMain ?? 0));
    rows.push({
      yugcontract_id: p.externalId,
      sku: `YC-${p.externalId}`,
      slug: slugWithId(p.nameUkr, p.externalId),
      name: p.nameUkr,
      price: validRrp(p.rrp) ? round2(p.rrp) : null,
      old_price: null,
      stock_quantity: stock,
      availability_status: stock > 0 ? 'in_stock' : 'out_of_stock',
      brandKey: p.brand !== null ? normalizeBrandKey(p.brand) : null,
      catYcId: p.catId,
    });
  }
  return { rows, skipped };
}

export interface ExistingProductRow {
  id: string;
  yugcontract_id: string | null;
  sku: string;
  name: string;
  slug: string;
  price: number | null;
  old_price: number | null;
  stock_quantity: number | null;
  availability_status: string | null;
  /** current default category — required for recategorization decisions */
  category_id: string | null;
}

export interface ResolvedInsert {
  yugcontract_id: string;
  sku: string;
  slug: string;
  name: string;
  price: number;
  old_price: number | null;
  stock_quantity: number;
  availability_status: string;
  category_id: string | null;
  brand_id: string | null;
  currency: string;
  is_active: boolean;
}

export interface ProductUpdateOp {
  id: string;
  /** Yugcontract identity — surfaces in per-row failure diagnostics. */
  yugcontractId: string;
  fields: Record<string, unknown>;
  /** true when stock_quantity changes — drives a stock-history entry */
  stockChanged: boolean;
  oldStock: number | null;
  newStock: number;
  /**
   * Present when the feed moved the product to a different leaf category:
   * products.category_id AND the junction links are replaced together
   * (replace-all semantics for YC rows — one direct link, the new leaf).
   */
  categorySync?: { oldCategoryId: string | null; newCategoryId: string };
}

export interface ProductWriteSplit {
  inserts: ResolvedInsert[];
  updates: ProductUpdateOp[];
  /** manual rows squatting a stable YC-<id> sku — MUST block the batch */
  hardConflicts: string[];
  unresolvedRefs: SkipEntry[];
  /**
   * EXISTING products whose feed category could not be resolved to a DB
   * row. Field updates still flow (never lose price/stock sync because of
   * category trouble); only the category decision is deferred and logged.
   */
  unresolvedCategoryUpdates: SkipEntry[];
}

export function splitProductWrites(
  rows: readonly MappedProductRow[],
  existingRows: readonly ExistingProductRow[],
  resolveRefs: (row: MappedProductRow) => { brand_id: string | null; category_id: string | null }
): ProductWriteSplit {
  const existingByYc = new Map<string, ExistingProductRow>();
  for (const r of existingRows) {
    if (r.yugcontract_id !== null) existingByYc.set(r.yugcontract_id, r);
  }

  const split: ProductWriteSplit = {
    inserts: [],
    updates: [],
    hardConflicts: [],
    unresolvedRefs: [],
    unresolvedCategoryUpdates: [],
  };

  for (const row of rows) {
    // A manual row owning the stable SKU blocks the batch: importing would
    // violate the sku UNIQUE constraint and identity would stay ambiguous.
    const skuSquatter = existingRows.find(
      (r) => r.sku === row.sku && (r.yugcontract_id === null || r.yugcontract_id !== row.yugcontract_id)
    );
    if (skuSquatter) {
      split.hardConflicts.push(
        `sku "${row.sku}" належить існуючому товару id=${skuSquatter.id} (yugcontract_id=${skuSquatter.yugcontract_id ?? 'null'})`
      );
      continue;
    }

    const refs = resolveRefs(row);
    const existing = existingByYc.get(row.yugcontract_id);

    if (!existing) {
      // New products need a resolvable category to be created at all;
      // price/stock of EXISTING products never depend on it (below).
      if (refs.category_id === null) {
        split.unresolvedRefs.push({
          id: row.yugcontract_id,
          reason: `новий товар не створено: категорію ${row.catYcId ?? '—'} не знайдено в БД`,
        });
        continue;
      }
      // New rows need a price to be sellable; without RRP we refuse to
      // invent one. (Existing rows keep flowing through updates below —
      // stock/name still sync while the current price stays untouched.)
      const insertPrice = row.price;
      if (insertPrice === null) {
        split.unresolvedRefs.push({
          id: row.yugcontract_id,
          reason: 'немає коректної RRP у фіді (новий товар не створено)',
        });
        continue;
      }
      split.inserts.push({
        yugcontract_id: row.yugcontract_id,
        sku: row.sku,
        slug: row.slug,
        name: row.name,
        price: insertPrice,
        old_price: row.old_price,
        stock_quantity: row.stock_quantity,
        availability_status: row.availability_status,
        category_id: refs.category_id,
        brand_id: refs.brand_id,
        currency: 'UAH',
        is_active: true,
      });
      continue;
    }

    if (refs.category_id === null) {
      // Never lose the price/stock sync because of a category problem:
      // fields keep updating; the existing category is left untouched.
      split.unresolvedCategoryUpdates.push({
        id: row.yugcontract_id,
        reason: `категорію ${row.catYcId ?? '—'} не знайдено в БД — поля оновлено без зміни категорії`,
      });
    }

    const fields: Record<string, unknown> = {};
    // Slug is deliberately NEVER updated: stable URLs beat name churn.
    // is_active is never auto-touched (no automatic deactivation).
    if (existing.name !== row.name) fields.name = row.name;
    // price=null (no valid RRP) → keep the existing correct price untouched.
    if (row.price !== null && (existing.price ?? null) !== row.price) {
      fields.price = row.price;
    }
    // No proven store discounts: old_price must stay empty for YC rows.
    if ((existing.old_price ?? null) !== null) fields.old_price = null;
    const newStock = row.stock_quantity;
    const oldStock = existing.stock_quantity ?? 0;
    if (oldStock !== newStock) fields.stock_quantity = newStock;
    if ((existing.availability_status ?? '') !== row.availability_status) {
      fields.availability_status = row.availability_status;
    }
    // Recategorization (approved 2026-08-26): when the supplier moved the
    // product to another leaf category, both the legacy default column and
    // the junction rows are replaced in the same batch update. The old
    // category is never left behind, never nulled out silently.
    const categorySync =
      refs.category_id !== null && (existing.category_id ?? null) !== refs.category_id
        ? {
            oldCategoryId: existing.category_id ?? null,
            newCategoryId: refs.category_id,
          }
        : undefined;
    if (categorySync) fields.category_id = refs.category_id;

    if (Object.keys(fields).length === 0 && !categorySync) continue;
    split.updates.push({
      id: existing.id,
      yugcontractId: row.yugcontract_id,
      fields,
      stockChanged: fields.stock_quantity !== undefined,
      oldStock,
      newStock,
      ...(categorySync ? { categorySync } : {}),
    });
  }

  return split;
}
