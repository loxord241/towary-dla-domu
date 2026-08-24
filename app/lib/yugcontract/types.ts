/**
 * Types for the Yugcontract B2B catalog feed (get-price).
 *
 * The provider documents field types loosely; the actual response is
 * verified at runtime by the normalizer (see normalize.ts) and the
 * preview endpoint reports observed type histograms. Never trust the
 * documented shape blindly — everything passes through coercion.
 */

/** Raw product row exactly as delivered (all fields unknown). */
export interface YcRawProduct {
  [key: string]: unknown;
}

/**
 * Normalized product derived from a raw feed row.
 * Only main-stock fields are mapped for now — regional warehouses
 * are intentionally out of scope until the import stage is designed.
 */
export interface YcProduct {
  /** Yugcontract external id, normalized to string */
  externalId: string;
  nameUkr: string;
  brand: string | null;
  /** category hierarchy: top level / 2nd level / leaf */
  catTop: string | null;
  cat2l: string | null;
  cat: string | null;
  /** supplier category ids, normalized to string */
  catId: string | null;
  catTopId: string | null;
  price: number | null;
  priceScu: number | null;
  /** RRP / recommended price (candidate for products.old_price) */
  rrp: number | null;
  rrpControl: number | null;
  statusMain: number | null;
  qtyMain: number | null;
}

/** Observed runtime types of a raw field, counted per product. */
export type FieldTypeName =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'other';

export type FieldTypeHistogram = Record<string, Record<FieldTypeName, number>>;

export interface YcCategorySample {
  catTopId: string | null;
  catTop: string | null;
  catId: string | null;
  cat2l: string | null;
  cat: string | null;
  productCount: number;
}

export interface YcBrandSample {
  name: string;
  productCount: number;
}

export interface YcDuplicateId {
  externalId: string;
  count: number;
}

export interface YcPreviewStats {
  totalProducts: number;
  uniqueBrands: number;
  uniqueCategories: number;
  inStockCount: number;
  outOfStockCount: number;
  unknownQtyCount: number;
  minPrice: number | null;
  maxPrice: number | null;
  noBrandCount: number;
  noCategoryCount: number;
  duplicateIds: YcDuplicateId[];
  productSamples: YcProduct[];
  categorySamples: YcCategorySample[];
  brandSamples: YcBrandSample[];
}

/** Result of comparing the feed against our existing catalog. */
export interface YcCrossAnalysis {
  ourTotalProducts: number;
  /** existing rows whose sku equals a feed id or `YC-<id>` */
  skuMatches: { count: number; examples: { sku: string; name: string }[] };
  /** exact normalized-name matches between feed and products.name */
  nameMatches: { count: number; examples: { ycName: string; ourName: string }[] };
  /** normalized brand-name overlap */
  brandOverlap: { count: number; examples: { ycBrand: string; ourBrand: string }[] };
  /** normalized category-name overlap (leaf/2nd level vs categories.name) */
  categoryOverlap: { count: number; examples: { ycCategory: string; ourCategory: string }[] };
}

// ---------------------------------------------------------------------------
// get-categories (category tree)
// ---------------------------------------------------------------------------

/** Raw category row exactly as delivered (all fields unknown). */
export interface YcRawCategoryRow {
  [key: string]: unknown;
}

/**
 * Normalized category node. The provider docs do not pin down the exact
 * JSON field names, so the extractor auto-detects id/name/parent keys and
 * reports which ones matched (`detected`), while every value still goes
 * through runtime coercion.
 */
export interface YcCategoryNode {
  externalId: string;
  parentId: string | null;
  name: string;
  /** explicit level/depth field if the feed provides one */
  levelHint: number | null;
}

export interface YcDetectedFields {
  /** key used as node id, e.g. "id" | "cat_id" | "categoryId" */
  id: string | null;
  name: string | null;
  parent: string | null;
}

export interface YcCategoryStats {
  totalNodes: number;
  rootCount: number;
  maxDepth: number;
  /** nodes whose parentId points to an unknown id */
  orphanCount: number;
  /** nodes per depth level: {0: 5, 1: 42, ...} */
  levelCounts: Record<string, number>;
}

export interface YcCategoryTreeNode extends YcCategoryNode {
  children: YcCategoryTreeNode[];
  depth: number;
}
