// Explicit .ts extension on value imports: required by node:test ESM
// resolution and allowed by allowImportingTsExtensions for the Next bundler.
import type { YcRawProduct } from './types';
import { asStringOrNull } from './normalize.ts';

/**
 * Pure normalization + statistics for the Yugcontract get-content-goods
 * feed. No I/O, no env access — fully unit-testable and side-effect free.
 * The CLI script owns transport, DB reads, sampling and printing.
 *
 * The provider response is treated as untrusted: every field passes
 * through runtime coercion, and a malformed record degrades to a counted
 * issue instead of aborting the whole run (identity = goods[].id).
 */

export interface YcContentParam {
  name: string;
  value: string;
}

export interface YcContentGood {
  externalId: string;
  categoryId: string | null;
  name: string | null;
  brand: string | null;
  ean: string | null;
  artikul: string | null;
  /** trimmed non-empty HTML/text; null = absent, empty or not a string */
  description: string | null;
  pictures: string[];
  params: YcContentParam[];
}

export interface ContentIssue {
  /** best-effort id for context; '(порожній id)' when id itself is broken */
  id: string;
  reason: string;
}

/** Extract the goods array from a parsed get-content-goods response body. */
export function extractContentGoods(parsed: unknown): {
  goods: YcRawProduct[];
} {
  const content = (parsed as { content?: unknown } | null)?.content;
  const direct = (content as { goods?: unknown } | null)?.goods;

  if (Array.isArray(direct)) {
    return { goods: direct as YcRawProduct[] };
  }

  const top = (parsed as { goods?: unknown } | null)?.goods;
  if (Array.isArray(top)) {
    return { goods: top as YcRawProduct[] };
  }

  const topKeys =
    typeof parsed === 'object' && parsed !== null
      ? Object.keys(parsed).join(', ')
      : typeof parsed;
  throw new TypeError(
    `Некоректна відповідь get-content-goods: масив content.goods не знайдено (верхньорівневі ключі: ${topKeys || 'немає'})`
  );
}

function coercePictures(
  raw: unknown,
  issues: ContentIssue[],
  id: string
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push({ id, reason: 'pictures не масив' });
    return [];
  }
  const out: string[] = [];
  let junk = 0;
  for (const entry of raw) {
    const s = asStringOrNull(entry);
    if (s === null) junk += 1;
    else out.push(s);
  }
  if (junk > 0) {
    issues.push({
      id,
      reason: `${junk} елементів pictures не є URL-рядком`,
    });
  }
  return out;
}

function coerceParams(
  raw: unknown,
  issues: ContentIssue[],
  id: string
): YcContentParam[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push({ id, reason: 'params не масив' });
    return [];
  }
  const out: YcContentParam[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push({ id, reason: 'param не є об’єктом' });
      continue;
    }
    const name = asStringOrNull((entry as Record<string, unknown>).name);
    const value = asStringOrNull((entry as Record<string, unknown>).value);
    if (name === null || value === null) {
      issues.push({ id, reason: 'param без name/value' });
      continue;
    }
    out.push({ name, value });
  }
  return out;
}

export function normalizeContentGood(raw: YcRawProduct): {
  good: YcContentGood | null;
  issues: ContentIssue[];
} {
  const issues: ContentIssue[] = [];
  const externalId = asStringOrNull(raw.id);
  if (externalId === null) {
    issues.push({ id: '(порожній id)', reason: 'id відсутній/порожній' });
    return { good: null, issues };
  }

  // A non-string description is an anomaly worth counting, not a fatal row error.
  if (
    raw.description !== undefined &&
    raw.description !== null &&
    typeof raw.description !== 'string'
  ) {
    issues.push({ id: externalId, reason: 'description не рядок' });
  }
  const rawDescription =
    typeof raw.description === 'string' ? raw.description.trim() : '';
  const description = rawDescription === '' ? null : rawDescription;

  return {
    good: {
      externalId,
      categoryId:
        asStringOrNull(raw.categoryId) ?? asStringOrNull(raw.category_id),
      name: asStringOrNull(raw.name),
      brand: asStringOrNull(raw.brand),
      ean: asStringOrNull(raw.EAN) ?? asStringOrNull(raw.ean),
      artikul: asStringOrNull(raw.artikul),
      description,
      pictures: coercePictures(raw.pictures, issues, externalId),
      params: coerceParams(raw.params, issues, externalId),
    },
    issues,
  };
}

export interface DedupeResult {
  /** unique valid goods, first occurrence wins */
  unique: YcContentGood[];
  duplicateIds: { externalId: string; count: number }[];
  duplicateRowCount: number;
}

export function dedupeContentGoods(goods: YcContentGood[]): DedupeResult {
  const byId = new Map<string, YcContentGood>();
  const counts = new Map<string, number>();
  for (const g of goods) {
    counts.set(g.externalId, (counts.get(g.externalId) ?? 0) + 1);
    if (!byId.has(g.externalId)) byId.set(g.externalId, g);
  }
  const duplicateIds = [...counts.entries()]
    .filter(([, c]) => c > 1)
    .map(([externalId, count]) => ({ externalId, count }))
    .sort((a, b) => b.count - a.count);
  return {
    unique: [...byId.values()],
    duplicateIds,
    duplicateRowCount: goods.length - byId.size,
  };
}

export interface OurProductRow {
  id: string;
  yugcontract_id: string | null;
  sku: string;
  name: string;
  description: string | null;
}

export interface MatchResult {
  matchedLocal: { product: OurProductRow; good: YcContentGood }[];
  /** our YC-linked products with no content record */
  unmatchedLocal: OurProductRow[];
  /** our products without any yugcontract_id (manual rows) */
  manualLocal: OurProductRow[];
  /** content ids not present in our assortment */
  ycUnusedIds: string[];
}

export function matchContentGoodsToProducts(
  goodsById: ReadonlyMap<string, YcContentGood>,
  ourProducts: readonly OurProductRow[]
): MatchResult {
  const matchedLocal: MatchResult['matchedLocal'] = [];
  const unmatchedLocal: OurProductRow[] = [];
  const manualLocal: OurProductRow[] = [];

  for (const p of ourProducts) {
    if (p.yugcontract_id === null) {
      manualLocal.push(p);
      continue;
    }
    const good = goodsById.get(p.yugcontract_id);
    if (good) matchedLocal.push({ product: p, good });
    else unmatchedLocal.push(p);
  }

  const ourYcIds = new Set(
    ourProducts.map((p) => p.yugcontract_id).filter((v): v is string => v !== null)
  );
  const ycUnusedIds = [...goodsById.keys()].filter((id) => !ourYcIds.has(id));

  return { matchedLocal, unmatchedLocal, manualLocal, ycUnusedIds };
}

// ---------------------------------------------------------------------------
// Description statistics + danger scan (string analysis only — never executed)
// ---------------------------------------------------------------------------

const HTML_TAG_RE = /<[a-z!][^>]*>/i;

export interface DescriptionStats {
  total: number;
  withDescription: number;
  emptyDescription: number;
  avgDescriptionLength: number | null;
  maxDescriptionLength: number | null;
  htmlCount: number;
  plainTextCount: number;
  danger: {
    scriptTag: number;
    iframeTag: number;
    eventHandlers: number;
    javascriptUrl: number;
    styleTagOrAttr: number;
    dataUrl: number;
  };
  /** up to `sampleLimit` examples — metadata only, never the HTML itself */
  samples: { externalId: string; length: number; containsHtml: boolean }[];
}

export function buildDescriptionStats(
  pairs: readonly { externalId: string; description: string | null }[],
  sampleLimit = 5
): DescriptionStats {
  let withDescription = 0;
  let lengthSum = 0;
  let maxLength: number | null = null;
  let htmlCount = 0;
  const danger = {
    scriptTag: 0,
    iframeTag: 0,
    eventHandlers: 0,
    javascriptUrl: 0,
    styleTagOrAttr: 0,
    dataUrl: 0,
  };
  const samples: DescriptionStats['samples'] = [];

  for (const { externalId, description } of pairs) {
    if (description === null) continue;
    withDescription += 1;
    lengthSum += description.length;
    maxLength = maxLength === null ? description.length : Math.max(maxLength, description.length);

    const hasHtml = HTML_TAG_RE.test(description);
    if (hasHtml) htmlCount += 1;

    if (/<script\b/i.test(description)) danger.scriptTag += 1;
    if (/<iframe\b/i.test(description)) danger.iframeTag += 1;
    if (/\bon[a-z]+\s*=/i.test(description)) danger.eventHandlers += 1;
    if (/javascript:/i.test(description)) danger.javascriptUrl += 1;
    if (/<style\b/i.test(description) || /\bstyle\s*=/i.test(description)) {
      danger.styleTagOrAttr += 1;
    }
    if (/data:/i.test(description)) danger.dataUrl += 1;

    if (samples.length < sampleLimit) {
      samples.push({ externalId, length: description.length, containsHtml: hasHtml });
    }
  }

  return {
    total: pairs.length,
    withDescription,
    emptyDescription: pairs.length - withDescription,
    avgDescriptionLength:
      withDescription > 0 ? Math.round(lengthSum / withDescription) : null,
    maxDescriptionLength: maxLength,
    htmlCount,
    plainTextCount: withDescription - htmlCount,
    danger,
    samples,
  };
}

// ---------------------------------------------------------------------------
// Params statistics
// ---------------------------------------------------------------------------

export interface ParamsStats {
  total: number;
  withParams: number;
  withoutParams: number;
  totalParams: number;
  avgParamsPerProduct: number | null;
  maxParamsPerProduct: number | null;
  uniqueParamNames: number;
  topNames: { name: string; count: number }[];
  /** goods having the SAME exact (name,value) pair more than once */
  goodsWithDuplicatePairs: number;
  /** goods where one name appears several times … */
  goodsWithNameRepeated: number;
  /** … specifically with DIFFERENT values (conflicting data) */
  goodsWithConflictingValues: number;
  distinctNamesPerGoodsAvg: number | null;
}

export function buildParamsStats(goods: readonly YcContentGood[], topLimit = 30): ParamsStats {
  let withParams = 0;
  let totalParams = 0;
  let maxPerProduct: number | null = null;
  let distinctSum = 0;
  let goodsWithDuplicatePairs = 0;
  let goodsWithNameRepeated = 0;
  let goodsWithConflictingValues = 0;
  const nameCounts = new Map<string, number>();

  for (const g of goods) {
    totalParams += g.params.length;
    if (g.params.length === 0) continue;
    withParams += 1;
    maxPerProduct =
      maxPerProduct === null ? g.params.length : Math.max(maxPerProduct, g.params.length);

    const perName = new Map<string, string[]>();
    const pairSeen = new Set<string>();
    let dupPair = false;
    let repeatedName = false;
    let conflicting = false;
    for (const p of g.params) {
      nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
      const key = `${p.name}\u0000${p.value}`;
      if (pairSeen.has(key)) dupPair = true;
      pairSeen.add(key);

      const values = perName.get(p.name);
      if (values) {
        repeatedName = true;
        if (!values.includes(p.value)) {
          values.push(p.value);
          conflicting = true;
        }
      } else {
        perName.set(p.name, [p.value]);
      }
    }
    distinctSum += perName.size;
    if (dupPair) goodsWithDuplicatePairs += 1;
    if (repeatedName) goodsWithNameRepeated += 1;
    if (conflicting) goodsWithConflictingValues += 1;
  }

  const topNames = [...nameCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topLimit);

  return {
    total: goods.length,
    withParams,
    withoutParams: goods.length - withParams,
    totalParams,
    avgParamsPerProduct:
      withParams > 0 ? Math.round((totalParams / goods.length) * 10) / 10 : null,
    maxParamsPerProduct: maxPerProduct,
    uniqueParamNames: nameCounts.size,
    topNames,
    goodsWithDuplicatePairs,
    goodsWithNameRepeated,
    goodsWithConflictingValues,
    distinctNamesPerGoodsAvg:
      withParams > 0 ? Math.round((distinctSum / goods.length) * 10) / 10 : null,
  };
}

// ---------------------------------------------------------------------------
// Picture statistics
// ---------------------------------------------------------------------------

export interface ImagesStats {
  total: number;
  productsWithPictures: number;
  productsWithoutPictures: number;
  totalPictureUrls: number;
  uniquePictureUrls: number;
  duplicateUrlRows: number;
  duplicateExamples: { url: string; count: number }[];
  hosts: { host: string; count: number }[];
  extensions: { ext: string; count: number }[];
  suspiciousUrls: { url: string; reason: string }[];
  maxPicturesPerProduct: number;
  avgPicturesPerProduct: number | null;
}

function parseUrlSafe(url: string): URL | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

export function buildImagesStats(goods: readonly YcContentGood[]): ImagesStats {
  let productsWithPictures = 0;
  let maxPicturesPerProduct = 0;
  const urlCounts = new Map<string, number>();
  const hosts = new Map<string, number>();
  const extensions = new Map<string, number>();
  const suspicious: { url: string; reason: string }[] = [];

  for (const g of goods) {
    if (g.pictures.length > 0) {
      productsWithPictures += 1;
      maxPicturesPerProduct = Math.max(maxPicturesPerProduct, g.pictures.length);
    }
    for (const url of g.pictures) {
      urlCounts.set(url, (urlCounts.get(url) ?? 0) + 1);
      const parsed = parseUrlSafe(url);
      if (parsed === null) {
        if (suspicious.length < 10) suspicious.push({ url, reason: 'не http(s)/URL' });
        continue;
      }
      hosts.set(parsed.host, (hosts.get(parsed.host) ?? 0) + 1);
      const file = parsed.pathname.split('/').pop() ?? '';
      const dot = file.lastIndexOf('.');
      const ext =
        dot > 0 && dot >= file.length - 6 ? file.slice(dot).toLowerCase() : '(без розширення)';
      extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
    }
  }

  const duplicateExamples = [...urlCounts.entries()]
    .filter(([, c]) => c > 1)
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const hostList = [...hosts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count);
  const extList = [...extensions.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count);

  const totalPictureUrls = [...urlCounts.values()].reduce((a, b) => a + b, 0);

  return {
    total: goods.length,
    productsWithPictures,
    productsWithoutPictures: goods.length - productsWithPictures,
    totalPictureUrls,
    uniquePictureUrls: urlCounts.size,
    duplicateUrlRows: totalPictureUrls - urlCounts.size,
    duplicateExamples,
    hosts: hostList,
    extensions: extList,
    suspiciousUrls: suspicious,
    maxPicturesPerProduct,
    avgPicturesPerProduct:
      goods.length > 0
        ? Math.round((totalPictureUrls / goods.length) * 100) / 100
        : null,
  };
}
