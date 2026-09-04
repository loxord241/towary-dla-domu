import type {
  FieldTypeHistogram,
  FieldTypeName,
  YcCategoryNode,
  YcCategoryStats,
  YcCategoryTreeNode,
  YcCategorySample,
  YcBrandSample,
  YcCrossAnalysis,
  YcDetectedFields,
  YcDuplicateId,
  YcPreviewStats,
  YcProduct,
  YcRawProduct,
  YcRawCategoryRow,
} from './types';

/**
 * Pure normalization + statistics for the Yugcontract get-price feed.
 * No I/O, no env access — fully unit-testable and side-effect free.
 *
 * The provider response is treated as untrusted: every field passes
 * through runtime coercion, so a change in the real API types degrades
 * to null values instead of corrupting downstream processing.
 */

/** Coerce an unknown value into a non-empty trimmed string (numbers allowed). */
export function asStringOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/** Coerce an unknown value into a finite number ("6417" counts). */
export function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Extract the product array from a parsed get-price response body.
 * Documented path: content.data.rests.product[]. Throws on any deviation
 * so callers never process a partially understood envelope.
 */
export function extractRawProducts(parsed: unknown): YcRawProduct[] {
  const content = (parsed as { content?: unknown } | null)?.content;
  const data = (content as { data?: unknown } | null)?.data;
  const rests = (data as { rests?: unknown } | null)?.rests;
  const product = (rests as { product?: unknown } | null)?.product;

  if (!Array.isArray(product)) {
    throw new TypeError(
      'Некоректна відповідь Yugcontract: очікується масив content.data.rests.product'
    );
  }
  // Rows must be plain objects; anything else is a malformed feed.
  if (product.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
    throw new TypeError(
      'Некоректна відповідь Yugcontract: елемент content.data.rests.product не є об’єктом'
    );
  }
  return product as YcRawProduct[];
}

export function normalizeYcProduct(raw: YcRawProduct): YcProduct {
  return {
    externalId: asStringOrNull(raw.id) ?? '',
    nameUkr: asStringOrNull(raw.name_ukr) ?? '',
    brand: asStringOrNull(raw.brand),
    catTop: asStringOrNull(raw.cat_top),
    cat2l: asStringOrNull(raw.cat_2l),
    cat: asStringOrNull(raw.cat),
    catId: asStringOrNull(raw.cat_id),
    catTopId: asStringOrNull(raw.cat_top_id),
    price: asNumberOrNull(raw.price),
    priceScu: asNumberOrNull(raw.price_scu),
    rrp: asNumberOrNull(raw.rrp),
    rrpControl: asNumberOrNull(raw.rrp_control),
    statusMain: asNumberOrNull(raw.status_main),
    qtyMain: asNumberOrNull(raw.qty_main),
  };
}

const HISTOGRAM_FIELDS = [
  'id',
  'price',
  'rrp',
  'qty_main',
  'status_main',
] as const;

function classify(value: unknown): FieldTypeName {
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'undefined':
      return 'undefined';
    default:
      return value === null ? 'null' : 'other';
  }
}

/** Count the REAL observed types of key fields across all raw rows. */
export function buildFieldTypeHistogram(rows: YcRawProduct[]): FieldTypeHistogram {
  const histogram: FieldTypeHistogram = {};
  for (const field of HISTOGRAM_FIELDS) {
    histogram[field] = {
      string: 0,
      number: 0,
      boolean: 0,
      null: 0,
      undefined: 0,
      other: 0,
    };
  }
  for (const row of rows) {
    for (const field of HISTOGRAM_FIELDS) {
      const entry = histogram[field];
      if (!entry) continue;
      entry[classify(row[field])] += 1;
    }
  }
  return histogram;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildPreviewStats(products: YcProduct[]): YcPreviewStats {
  let inStockCount = 0;
  let outOfStockCount = 0;
  let unknownQtyCount = 0;
  let noBrandCount = 0;
  let noCategoryCount = 0;

  let minPrice: number | null = null;
  let maxPrice: number | null = null;

  const brandCounts = new Map<string, number>();
  const categoryCounts = new Map<string, YcCategorySample>();
  const idCounts = new Map<string, number>();

  for (const p of products) {
    if (p.qtyMain === null) unknownQtyCount += 1;
    else if (p.qtyMain > 0) inStockCount += 1;
    else outOfStockCount += 1;

    if (p.brand === null) noBrandCount += 1;
    else brandCounts.set(p.brand, (brandCounts.get(p.brand) ?? 0) + 1);

    // "Без категории" = нет ни одного уровня иерархии.
    if (
      p.catTop === null &&
      p.cat2l === null &&
      p.cat === null &&
      p.catId === null
    ) {
      noCategoryCount += 1;
    }

    if (p.price !== null) {
      minPrice = minPrice === null ? p.price : Math.min(minPrice, p.price);
      maxPrice = maxPrice === null ? p.price : Math.max(maxPrice, p.price);
    }

    idCounts.set(p.externalId, (idCounts.get(p.externalId) ?? 0) + 1);

    const hasCategoryIdentity =
      p.catTop !== null ||
      p.cat2l !== null ||
      p.cat !== null ||
      p.catId !== null ||
      p.catTopId !== null;
    if (!hasCategoryIdentity) continue;

    const catKey = `${p.catTopId ?? ''}|${p.catId ?? ''}|${p.cat ?? ''}`;
    const existingCat = categoryCounts.get(catKey);
    if (existingCat) {
      existingCat.productCount += 1;
    } else {
      categoryCounts.set(catKey, {
        catTopId: p.catTopId,
        catTop: p.catTop,
        catId: p.catId,
        cat2l: p.cat2l,
        cat: p.cat,
        productCount: 1,
      });
    }
  }

  const duplicateIds: YcDuplicateId[] = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([externalId, count]) => ({ externalId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const brandSamples: YcBrandSample[] = [...brandCounts.entries()]
    .map(([name, productCount]) => ({ name, productCount }))
    .sort((a, b) => b.productCount - a.productCount)
    .slice(0, 15);

  const categorySamples: YcCategorySample[] = [...categoryCounts.values()]
    .sort((a, b) => b.productCount - a.productCount)
    .slice(0, 15);

  return {
    totalProducts: products.length,
    uniqueBrands: brandCounts.size,
    uniqueCategories: categoryCounts.size,
    inStockCount,
    outOfStockCount,
    unknownQtyCount,
    minPrice,
    maxPrice,
    noBrandCount,
    noCategoryCount,
    duplicateIds,
    productSamples: products.slice(0, 5),
    categorySamples,
    brandSamples,
  };
}

export interface OurCatalogRow {
  sku: string;
  name: string;
}

export interface OurBrandRow {
  name: string;
}

export interface OurCategoryRow {
  name: string;
}

/**
 * Read-only comparison of the feed against our existing catalog.
 * Matching is diagnostic-only; the future importer must rely on the
 * Yugcontract id as the sole external identity — never name/brand/price.
 */
export function buildCrossAnalysis(
  ycProducts: YcProduct[],
  ourProducts: OurCatalogRow[],
  ourBrands: OurBrandRow[],
  ourCategories: OurCategoryRow[]
): YcCrossAnalysis {
  const ourSkuIndex = new Map(ourProducts.map((p) => [normalizeName(p.sku), p]));
  const ourNameIndex = new Map(ourProducts.map((p) => [normalizeName(p.name), p]));

  const skuMatches: YcCrossAnalysis['skuMatches']['examples'] = [];
  const nameMatchExamples: YcCrossAnalysis['nameMatches']['examples'] = [];
  let skuMatchCount = 0;
  let nameMatchCount = 0;

  for (const p of ycProducts) {
    for (const candidate of [p.externalId, `YC-${p.externalId}`]) {
      const hit = ourSkuIndex.get(normalizeName(candidate));
      if (hit) {
        skuMatchCount += 1;
        if (skuMatches.length < 5) {
          skuMatches.push({ sku: hit.sku, name: hit.name });
        }
        break;
      }
    }

    const ourHit = ourNameIndex.get(normalizeName(p.nameUkr));
    if (ourHit) {
      nameMatchCount += 1;
      if (nameMatchExamples.length < 5) {
        nameMatchExamples.push({ ycName: p.nameUkr, ourName: ourHit.name });
      }
    }
  }

  const ourBrandNames = new Set(ourBrands.map((b) => normalizeName(b.name)));
  const brandOverlapSet = new Set<string>();
  for (const brand of brandKeys(ycProducts)) {
    if (ourBrandNames.has(normalizeName(brand))) brandOverlapSet.add(brand);
  }

  const ourCategoryNames = new Set(
    ourCategories.map((c) => normalizeName(c.name))
  );
  const categoryOverlapSet = new Set<string>();
  for (const p of ycProducts) {
    for (const level of [p.cat2l, p.cat]) {
      if (level !== null && ourCategoryNames.has(normalizeName(level))) {
        categoryOverlapSet.add(level);
      }
    }
  }

  return {
    ourTotalProducts: ourProducts.length,
    skuMatches: {
      count: skuMatchCount,
      examples: skuMatches,
    },
    nameMatches: {
      count: nameMatchCount,
      examples: nameMatchExamples,
    },
    brandOverlap: {
      count: brandOverlapSet.size,
      examples: [...brandOverlapSet]
        .slice(0, 10)
        .map((ycBrand) => ({
          ycBrand,
          ourBrand:
            ourBrands.find((b) => normalizeName(b.name) === normalizeName(ycBrand))
              ?.name ?? '',
        })),
    },
    categoryOverlap: {
      count: categoryOverlapSet.size,
      examples: [...categoryOverlapSet].slice(0, 10).map((ycCategory) => ({
        ycCategory,
        ourCategory: ycCategory,
      })),
    },
  };
}

function brandKeys(products: YcProduct[]): string[] {
  const seen = new Set<string>();
  for (const p of products) if (p.brand !== null) seen.add(p.brand);
  return [...seen];
}

// ---------------------------------------------------------------------------
// get-categories: shape probing, normalization, tree, search
// ---------------------------------------------------------------------------

const CATEGORY_ID_KEYS = ['id', 'cat_id', 'categoryId', 'category_id', 'ID'];
const CATEGORY_NAME_KEYS = [
  'name_ukr',
  'name',
  'cat_name',
  'category_name',
  'title',
];
const CATEGORY_PARENT_KEYS = [
  'parent_id',
  'parentId',
  'parent',
  'parentID',
  'top_cat_id',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeCategoryRow(row: Record<string, unknown>): boolean {
  const hasId = CATEGORY_ID_KEYS.some((k) => row[k] !== undefined);
  const hasName = CATEGORY_NAME_KEYS.some(
    (k) => typeof row[k] === 'string' || typeof row[k] === 'number'
  );
  return hasId && hasName;
}

/** Depth-first scan for the first plausible non-empty category array. */
function deepScanForCategoryArray(value: unknown, path: string): {
  rows: YcRawCategoryRow[];
  path: string;
} | null {
  if (Array.isArray(value)) {
    const objects = value.filter(isPlainObject);
    if (
      value.length > 0 &&
      objects.length === value.length &&
      objects.some(looksLikeCategoryRow)
    ) {
      return { rows: value as YcRawCategoryRow[], path };
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const hit = deepScanForCategoryArray(child, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

export interface YcCategoriesExtraction {
  rows: YcRawCategoryRow[];
  /** JSON path where the array was found, e.g. "content.data.categories" */
  arrayPath: string | null;
}

/**
 * Extract the category array from a parsed get-categories response.
 * The provider docs do not fix an exact JSON schema, so known paths are
 * probed first and a conservative deep scan is used as fallback. When
 * nothing plausible is found a TypeError with observed top-level keys is
 * thrown — diagnostics without guessing.
 */
export function extractCategoryRows(parsed: unknown): YcCategoriesExtraction {
  const knownPaths: string[][] = [
    ['content', 'data', 'categories'],
    ['content', 'data', 'category'],
    ['content', 'data', 'cats'],
    ['content', 'categories'],
    ['content', 'category'],
    ['categories'],
    ['data', 'categories'],
  ];
  for (const path of knownPaths) {
    let node: unknown = parsed;
    for (const key of path) {
      node = isPlainObject(node) ? node[key] : undefined;
    }
    if (Array.isArray(node) && node.length > 0 && node.every(isPlainObject)) {
      return { rows: node as YcRawCategoryRow[], arrayPath: path.join('.') };
    }
  }

  const scanned = deepScanForCategoryArray(parsed, '$');
  if (scanned) {
    return { rows: scanned.rows, arrayPath: scanned.path.slice(2) };
  }

  const topKeys = isPlainObject(parsed)
    ? Object.keys(parsed).join(', ')
    : typeof parsed;
  throw new TypeError(
    `Некоректна відповідь get-categories: масив категорій не знайдено (верхньорівневі ключі: ${topKeys || 'немає'})`
  );
}

/**
 * Detect which raw keys hold id/name/parent. First matching key wins for
 * every role; detection result is reported to the admin UI so a real run
 * documents itself.
 */
export function detectCategoryFields(rows: YcRawCategoryRow[]): YcDetectedFields {
  const probe = rows.find(isPlainObject);
  if (!probe) return { id: null, name: null, parent: null };
  const firstKey = (keys: string[]) =>
    keys.find((k) => probe[k] !== undefined && probe[k] !== null) ?? null;
  return {
    id: firstKey(CATEGORY_ID_KEYS),
    name: firstKey(CATEGORY_NAME_KEYS),
    parent: firstKey(CATEGORY_PARENT_KEYS),
  };
}

export function normalizeCategoryNode(
  row: YcRawCategoryRow,
  detected: YcDetectedFields
): YcCategoryNode {
  const idValue =
    detected.id !== null ? row[detected.id] : row[CATEGORY_ID_KEYS[0]!];
  const nameValue =
    detected.name !== null ? row[detected.name] : row[CATEGORY_NAME_KEYS[0]!];
  const parentValue =
    detected.parent !== null ? row[detected.parent] : undefined;

  // Explicit "no parent" markers common in supplier feeds.
  const parentStr = asStringOrNull(parentValue);
  const parentId =
    parentStr === null || parentStr === '0' ? null : parentStr;

  return {
    externalId: asStringOrNull(idValue) ?? '',
    parentId,
    name: asStringOrNull(nameValue) ?? '',
    levelHint: asNumberOrNull(row['level'] ?? row['depth']),
  };
}

/** Build tree + stats. Orphans (unknown parents) are promoted to roots. */
export function buildCategoryTree(nodes: YcCategoryNode[]): {
  roots: YcCategoryTreeNode[];
  stats: YcCategoryStats;
} {
  const byId = new Map<string, YcCategoryTreeNode>();
  for (const node of nodes) {
    byId.set(node.externalId, { ...node, children: [], depth: 0 });
  }

  const roots: YcCategoryTreeNode[] = [];
  let orphanCount = 0;

  for (const node of byId.values()) {
    const parent =
      node.parentId !== null ? byId.get(node.parentId) : undefined;
    if (node.parentId === null || parent === undefined) {
      if (node.parentId !== null) orphanCount += 1;
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  // Siblings stay in feed order; depth computed top-down.
  let maxDepth = 0;
  const levelCounts: Record<string, number> = {};
  const walk = (nodes: YcCategoryTreeNode[], depth: number) => {
    for (const node of nodes) {
      node.depth = depth;
      maxDepth = Math.max(maxDepth, depth);
      const key = String(depth);
      levelCounts[key] = (levelCounts[key] ?? 0) + 1;
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);

  return {
    roots,
    stats: {
      totalNodes: nodes.length,
      rootCount: roots.length,
      maxDepth,
      orphanCount,
      levelCounts,
    },
  };
}

/**
 * Substring search over the tree (case-insensitive). Matching nodes are
 * kept together with their full ancestor chain so the hierarchy context
 * remains visible; non-matching branches collapse away.
 */
export function filterCategoryTree(
  roots: YcCategoryTreeNode[],
  query: string
): YcCategoryTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return roots;

  const matches = (node: YcCategoryTreeNode) =>
    node.name.toLowerCase().includes(needle) ||
    node.externalId.toLowerCase().includes(needle);

  const filterNode = (
    node: YcCategoryTreeNode
  ): YcCategoryTreeNode | null => {
    const keptChildren = node.children
      .map(filterNode)
      .filter((c): c is YcCategoryTreeNode => c !== null);
    if (matches(node) || keptChildren.length > 0) {
      return { ...node, children: keptChildren };
    }
    return null;
  };

  return roots
    .map(filterNode)
    .filter((n): n is YcCategoryTreeNode => n !== null);
}
