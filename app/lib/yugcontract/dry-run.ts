import type { YcProduct, YcRawProduct } from './types';
import { normalizeYcProduct } from './normalize.ts';

/**
 * Pure aggregation for the category-filtered dry-run.
 *
 * No I/O and no env access: batches of raw feed rows go in, a fully
 * typed report comes out. The CLI script owns transport + printing;
 * this module stays unit-testable and side-effect free.
 *
 * Identity rule (project invariant): products are deduplicated by the
 * Yugcontract external id only. Name/brand/price are never identity.
 */

export interface DryRunDbSnapshot {
  /** our products.sku values (proxy until yugcontract_id migration lands) */
  skus: string[];
  brandNames: string[];
  categoryNames: string[];
  /** true when products.yugcontract_id exists in the live database */
  hasYugcontractIdColumn: boolean;
}

export interface DryRunBatchMeta {
  /** category ids requested in this batch */
  catsCount: number;
  rows: number;
  byteLength: number;
  durationMs: number;
}

/** Accumulator for merged, de-duplicated feed products. */
export class YcProductMerger {
  private readonly byId = new Map<string, YcProduct>();

  /** Rows seen in total (including duplicates across/within batches). */
  totalRows = 0;

  addRawBatch(rawRows: YcRawProduct[]): void {
    for (const raw of rawRows) {
      this.totalRows += 1;
      const product = normalizeYcProduct(raw);
      if (product.externalId === '') continue;
      // First occurrence wins; later duplicates are counted but ignored.
      if (!this.byId.has(product.externalId)) {
        this.byId.set(product.externalId, product);
      }
    }
  }

  get uniqueCount(): number {
    return this.byId.size;
  }

  get duplicateRowCount(): number {
    return this.totalRows - this.byId.size;
  }

  values(): YcProduct[] {
    return [...this.byId.values()];
  }

  snapshot(): Map<string, YcProduct> {
    return new Map(this.byId);
  }
}

/**
 * Keep only products whose supplier category belongs to the approved
 * selection subtree. Safety net for the case where the API ignores or
 * partially applies the `cats` filter: nothing outside the selection
 * can reach the report even then.
 */
export function makeCategoryFilter(
  expandedIds: ReadonlySet<string>
): (p: YcProduct) => boolean {
  return (p) =>
    (p.catId !== null && expandedIds.has(p.catId)) ||
    (p.catTopId !== null && expandedIds.has(p.catTopId));
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface DryRunReport {
  /** unique merged products (deduplicated by external id) */
  uniqueProducts: number;
  /** raw rows received across all batches before merging */
  totalRows: number;
  duplicateRows: number;
  newProducts: number;
  existingInDbBySku: number;
  existingMatchExamples: { sku: string; name: string }[];
  uniqueBrands: number;
  observedCategories: number;
  selectedCategoriesPresent: number;
  withPrice: number;
  withoutPrice: number;
  qtyPositive: number;
  qtyZero: number;
  qtyUnknown: number;
  noBrand: number;
  noCategory: number;
  minPrice: number | null;
  maxPrice: number | null;
  avgPrice: number | null;
  filteredOutByCats: number;
  samples: YcProduct[];
  dbTotalProducts: number;
  ourBrandCount: number;
  ourCategoryCount: number;
}

export function computeDryRunReport(
  products: readonly YcProduct[],
  counters: { totalRows: number; duplicateRows: number; filteredOutByCats: number },
  selectionIds: readonly string[],
  db: DryRunDbSnapshot
): DryRunReport {
  let withPrice = 0;
  let withoutPrice = 0;
  let qtyPositive = 0;
  let qtyZero = 0;
  let qtyUnknown = 0;
  let noBrand = 0;
  let noCategory = 0;
  let priceSum = 0;
  let minPrice: number | null = null;
  let maxPrice: number | null = null;

  const brands = new Set<string>();
  const catIds = new Set<string>();
  const dbSkuIndex = new Set(db.skus.map(normalizeKey));

  let existingBySku = 0;
  const existingExamples: { sku: string; name: string }[] = [];

  for (const p of products) {
    if (p.price !== null) {
      withPrice += 1;
      priceSum += p.price;
      if (minPrice === null || p.price < minPrice) minPrice = p.price;
      if (maxPrice === null || p.price > maxPrice) maxPrice = p.price;
    } else {
      withoutPrice += 1;
    }

    if (p.qtyMain === null) qtyUnknown += 1;
    else if (p.qtyMain > 0) qtyPositive += 1;
    else qtyZero += 1;

    if (p.brand === null) noBrand += 1;
    else brands.add(p.brand);

    const categorized =
      p.catTop !== null ||
      p.cat2l !== null ||
      p.cat !== null ||
      p.catId !== null ||
      p.catTopId !== null;
    if (!categorized) noCategory += 1;
    if (p.catId !== null) catIds.add(p.catId);

    const skuHit =
      dbSkuIndex.has(normalizeKey(p.externalId)) ||
      dbSkuIndex.has(normalizeKey(`YC-${p.externalId}`));
    if (skuHit) {
      existingBySku += 1;
      if (existingExamples.length < 5) {
        existingExamples.push({
          sku: `YC-${p.externalId}`,
          name: p.nameUkr,
        });
      }
    }
  }

  const observedSelection = new Set<string>();
  for (const p of products) if (p.catId !== null) observedSelection.add(p.catId);
  const selectedSet = new Set(selectionIds);
  let present = 0;
  for (const id of observedSelection) if (selectedSet.has(id)) present += 1;

  return {
    uniqueProducts: products.length,
    totalRows: counters.totalRows,
    duplicateRows: counters.duplicateRows,
    newProducts: products.length - existingBySku,
    existingInDbBySku: existingBySku,
    existingMatchExamples: existingExamples,
    uniqueBrands: brands.size,
    observedCategories: catIds.size,
    selectedCategoriesPresent: present,
    withPrice,
    withoutPrice,
    qtyPositive,
    qtyZero,
    qtyUnknown,
    noBrand,
    noCategory,
    minPrice,
    maxPrice,
    avgPrice:
      withPrice > 0 ? Math.round((priceSum / withPrice) * 100) / 100 : null,
    filteredOutByCats: counters.filteredOutByCats,
    samples: products.slice(0, 5),
    dbTotalProducts: db.skus.length,
    ourBrandCount: db.brandNames.length,
    ourCategoryCount: db.categoryNames.length,
  };
}
