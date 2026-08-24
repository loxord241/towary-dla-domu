// Explicit .ts extension on value imports: required by node:test ESM
// resolution and allowed by allowImportingTsExtensions for the Next bundler.
import type { YcContentGood, YcContentParam } from './content-dry-run.ts';
import type { YcRawProduct } from './types';
import { asStringOrNull } from './normalize.ts';
import { sanitizeYcDescription } from './content-sanitize.ts';

/**
 * Pure building blocks for the get-content-goods staging pipeline:
 * fetch (CLI) normalizes the feed with content-dry-run.ts, then reduces
 * every good to a staging row here. No I/O — fully unit-testable.
 *
 * Invariants (decisions 2026-08):
 *  - duplicate upstream ids resolve deterministically FIRST-WINS (the
 *    same rule the dry-run reported on; never last-write-wins);
 *  - descriptions are SANITIZED here, so raw supplier HTML is never
 *    persisted anywhere;
 *  - pictures keep only URLs that pass the external-image validation
 *    (http(s), Yugcontract host, image extension) — PDFs and junk that
 *    the dry-run found inside pictures[] cannot reach product_images.
 */

/** The ONLY host hotlinked images may come from (dry-run: single host). */
export const YC_IMAGES_HOST = 'b2b.yugcontract.ua';

/**
 * Extension allowlist for hotlinked images. The dry-run found .pdf files
 * inside pictures[]; anything not listed here is rejected. Extension is a
 * necessary filter, not a MIME guarantee (hotlink mode does not download
 * the file) — the fixed supplier host keeps this risk bounded.
 */
const ALLOWED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

export type ImageUrlCheck =
  | { ok: true }
  | { ok: false; reason: string };

export function isImportableExternalImageUrl(url: string): ImageUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'не валідний URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `заборонена схема ${parsed.protocol}` };
  }
  if (parsed.host !== YC_IMAGES_HOST) {
    return { ok: false, reason: `чужий host ${parsed.host}` };
  }
  const file = parsed.pathname.split('/').pop() ?? '';
  const dot = file.lastIndexOf('.');
  if (dot <= 0 || dot < file.length - 6) {
    return { ok: false, reason: 'без розширення' };
  }
  const ext = file.slice(dot + 1).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `розширення .${ext} не дозволене` };
  }
  return { ok: true };
}

/**
 * specifications JSONB value: ARRAY of {name,value} pairs in supplier
 * order. An object was explicitly rejected (decision 2026-08): the feed
 * contains goods where one name carries several different values.
 */
export function buildSpecificationJson(
  params: readonly YcContentParam[]
): { name: string; value: string }[] {
  return params.map((p) => ({ name: p.name, value: p.value }));
}

/** Row shape of table yc_content_goods (see migration 011). */
export interface StagedContentRow {
  yugcontract_id: string;
  category_id: string | null;
  name: string | null;
  /** sanitized HTML or null when empty after sanitization */
  description: string | null;
  pictures: string[];
  params: { name: string; value: string }[];
}

export interface StageReductionResult {
  rows: StagedContentRow[];
  /** URLs dropped by the image validation, grouped by reason */
  rejectedPictures: { reason: string; count: number; exampleUrl: string }[];
  /** descriptions that were HTML and got rewritten by the sanitizer */
  sanitizedDescriptions: number;
}

export function reduceGoodsToStagedRows(
  goods: readonly YcContentGood[]
): StageReductionResult {
  const rows: StagedContentRow[] = [];
  const rejected = new Map<string, { count: number; exampleUrl: string }>();
  let sanitizedDescriptions = 0;

  for (const g of goods) {
    const pictures: string[] = [];
    for (const url of g.pictures) {
      const check = isImportableExternalImageUrl(url);
      if (check.ok) {
        pictures.push(url);
      } else {
        const entry = rejected.get(check.reason) ?? { count: 0, exampleUrl: url };
        entry.count += 1;
        rejected.set(check.reason, entry);
      }
    }

    let description: string | null = null;
    if (g.description !== null) {
      const clean = sanitizeYcDescription(g.description);
      if (clean !== '') {
        description = clean;
        if (clean !== g.description.trim()) sanitizedDescriptions += 1;
      }
    }

    rows.push({
      yugcontract_id: g.externalId,
      category_id: g.categoryId,
      name: g.name,
      description,
      pictures,
      params: buildSpecificationJson(g.params),
    });
  }

  return {
    rows,
    rejectedPictures: [...rejected.entries()]
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.count - a.count),
    sanitizedDescriptions,
  };
}

/**
 * Coerce a raw staging DB row back into typed shape (defense against
 * schema drift; mirrors normalize.ts philosophy).
 */
export function coerceStagedRow(raw: YcRawProduct): StagedContentRow | null {
  const id = asStringOrNull(raw.yugcontract_id);
  if (id === null) return null;
  const pictures: string[] = Array.isArray(raw.pictures)
    ? raw.pictures.filter((v): v is string => typeof v === 'string')
    : [];
  const params = (Array.isArray(raw.params) ? raw.params : []).flatMap(
    (entry): { name: string; value: string }[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const name = asStringOrNull((entry as Record<string, unknown>).name);
      const value = asStringOrNull((entry as Record<string, unknown>).value);
      return name !== null && value !== null ? [{ name, value }] : [];
    }
  );
  return {
    yugcontract_id: id,
    category_id: asStringOrNull(raw.category_id),
    name: asStringOrNull(raw.name),
    description: asStringOrNull(raw.description),
    pictures,
    params,
  };
}
