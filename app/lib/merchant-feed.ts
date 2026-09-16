/**
 * Google Merchant Center product feed builder (free listings) — PURE and
 * dependency-free at runtime: every import below is either a pure helper or
 * carries type-only imports only, so node:test loads this module without
 * Supabase or Next.
 *
 * Feed eligibility mirrors the storefront/sitemap contract (spec C invariant
 * «indexable set = sitemap set»):
 *   - `is_active = true` + ≥1 photo (`product_images!inner`) is enforced by
 *     the DATA layer (app/feeds/google-merchant.xml/route.ts) using the same
 *     join as app/sitemap.ts;
 *   - `_du` alias slugs that 301-redirect (DU_REDIRECT_SLUGS) are dropped
 *     HERE, in the pure builder, so the exclusion is unit-testable and can
 *     never drift from the redirect list;
 *   - a product without ANY description text uses the factual name-based
 *     fallback «Купити {name} в інтернет-магазині Товари для дому.» — the
 *     same phrase the PDP meta falls back to (audit R10 2026-09-15: the
 *     former skip silently dropped ~199 products from merchant coverage);
 *   - a product whose image URL cannot be resolved to an absolute http(s)
 *     URL is skipped (g:image_link must be absolute https);
 *   - a product without a positive finite price is skipped (same honesty
 *     rule as buildProductJsonLd: no invented offers).
 *
 * Availability is reported HONESTLY: `in_stock` → "in stock", everything
 * else → "out of stock" (g:availability has no "limited" enum value and the
 * conservative mapping can never oversell; OOS items STAY in the feed —
 * Google requires availability to match the landing page, which shows OOS
 * too). Note: an older comment here claimed «~96% OOS after the supplier
 * incident» — stale as of 2026-09-15, when OOS was 13% and stock status is
 * consistent with stock_quantity (verified in the audit).
 *
 * Google file limits — DECISION (single file, no pagination):
 *   Feeds fetched by URL (scheduled fetch in Merchant Center) accept up to
 *   50 000 items per XML file (1 GB). Manual upload is where the much
 *   smaller limits apply; this feed is served at a public URL for scheduled
 *   fetch only, so ONE file is correct. The builder still hard-caps output
 *   at GOOGLE_FEED_MAX_ITEMS (deterministic id order from the data layer):
 *   if the catalog ever outgrows the cap the excess rows are dropped and
 *   the route notes it in an XML comment rather than emitting a broken or
 *   oversized file.
 *
 * Field alignment with the product page (Google cross-checks feed against
 * landing page, buildProductJsonLd in app/lib/schema-org.ts):
 *   g:id            → products.id (same id the storefront uses)
 *   g:title         → products.name (trimmed, ≤150 chars per Google spec)
 *   g:description   → stripHtmlToText(description || short_description),
 *                     truncated to GOOGLE_DESCRIPTION_MAX_LENGTH chars at a
 *                     word boundary + "…" (full supplier descriptions blow the
 *                     feed up to ~11.7 MB; Google's own limit is 5000)
 *   g:link          → {SITE_URL}/product/{slug} (same URL as the page)
 *   g:image_link    → absolute public URL (getPublicImageUrl, hotlinks pass
 *                     through) — the SAME main image the card renders
 *   g:additional_image_link → up to 10 more gallery images (every non-main
 *                     photo in gallery order, getPublicImageUrl; filtered to
 *                     absolute http(s) and capped HERE so the rule stays
 *                     unit-testable, same split as g:image_link)
 *   g:availability  → in stock / out of stock (availability_status column)
 *   g:price         → "1234.00 UAH" (toIsoCurrency, DB stores UAH)
 *   g:brand         → brands.name via join
 *   g:condition     → "new" (constant: the shop sells new goods only)
 *   g:identifier_exists → "no" (supplier items carry no GTIN/MPN)
 *   g:product_type  → category path "Корень / Подкатегория" (names only,
 *                     deterministic pick + path, see pickCategoryPath)
 */
import { stripHtmlToText, toIsoCurrency } from './schema-org.ts';
import { DU_REDIRECT_SLUGS } from './du-redirects.ts';
import { compareCategories } from './category-tree.ts';

/** Scheduled-fetch XML feed cap (see module docstring decision). */
export const GOOGLE_FEED_MAX_ITEMS = 50_000;

/**
 * Google accepts up to 10 g:additional_image_link elements per item —
 * repeated elements emitted right after g:image_link.
 */
export const GOOGLE_FEED_MAX_ADDITIONAL_IMAGES = 10;

/** Google g:title limit, characters. */
export const GOOGLE_TITLE_MAX_LENGTH = 150;

/**
 * Soft cap for g:description, characters (including the trailing "…").
 * Google accepts up to 5000, but full supplier HTML-stripped descriptions
 * inflate the XML to ~11.7 MB; 1000 chars keeps the feed compact while
 * staying well inside the hard limit.
 */
export const GOOGLE_DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Truncates a description to maxLength characters total (the ellipsis
 * counts toward the cap), cutting at the LAST word boundary inside the
 * budget and appending "…". Text at or under the limit is returned
 * unchanged; a single word longer than the budget is hard-cut.
 */
export function truncateDescription(
  text: string,
  maxLength: number = GOOGLE_DESCRIPTION_MAX_LENGTH
): string {
  if (text.length <= maxLength) return text;
  const head = text.slice(0, maxLength - 1);
  // Last whitespace that still separates two words within the budget.
  const boundary = /\s(?=\S*$)/.exec(head);
  const cut = boundary ? head.slice(0, boundary.index).trimEnd() : head;
  return `${cut}…`;
}

/** One fetched product row, already projected by the route (checked shape). */
export interface MerchantFeedProductRow {
  id: string;
  slug: string;
  name: string;
  price: number;
  currency?: string | null;
  availability_status: string;
  description?: string | null;
  short_description?: string | null;
  brand_name?: string | null;
  /** Absolute http(s) image URL resolved by the data layer, or null. */
  image_url?: string | null;
  /**
   * Gallery images EXCLUDING the picked main one, absolutized by the data
   * layer (getPublicImageUrl) in gallery order. The builder owns the
   * http(s) filter and the 10-element cap (honest rules, unit-testable).
   */
  additional_image_urls?: string[] | null;
  /** "Корень / Подкатегория" path built by the data layer, or null. */
  category_path?: string | null;
}

export interface MerchantFeedItem {
  id: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  /** Up to GOOGLE_FEED_MAX_ADDITIONAL_IMAGES values for g:additional_image_link. */
  additionalImageLinks?: string[];
  availability: 'in stock' | 'out of stock';
  price: string;
  brand?: string;
  condition: 'new';
  identifierExists: 'no';
  productType?: string;
}

/** XML special-character escaping — mandatory: names contain & " ' and more. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Maps a DB availability_status to the Google g:availability enum.
 * `in_stock` is the ONLY value that maps to "in stock"; anything unknown
 * maps conservatively to "out of stock" (never oversell — see docstring).
 */
export function mapAvailability(status: string): 'in stock' | 'out of stock' {
  return status === 'in_stock' ? 'in stock' : 'out of stock';
}

/**
 * Builds feed items from checked product rows. Rows are skipped (not
 * broken) when: _du redirect alias, no resolvable image, or no positive
 * finite price. A row with no description TEXT uses the factual name-based
 * fallback (audit R10 2026-09-15) instead of being skipped, so the feed set
 * matches the sitemap set. baseUrl is the trimmed site origin; trailing
 * slashes are tolerated.
 */
export function buildMerchantItems(
  rows: ReadonlyArray<MerchantFeedProductRow>,
  baseUrl: string
): MerchantFeedItem[] {
  const base = baseUrl.replace(/\/+$/, '');
  const items: MerchantFeedItem[] = [];
  for (const row of rows) {
    // _du aliases with 301 redirects are not indexable pages — the feed set
    // must equal the sitemap set, so they are excluded here (not in the
    // data layer) where the invariant is unit-testable.
    if (DU_REDIRECT_SLUGS.has(row.slug)) continue;

    const name = (row.name ?? '').trim();
    if (!name || !row.id || !row.slug) continue;

    const description =
      stripHtmlToText(row.description) ||
      stripHtmlToText(row.short_description) ||
      // Audit R10: the PDP meta falls back to exactly this phrase, so the
      // feed stays consistent with the landing page Google cross-checks.
      `Купити ${name} в інтернет-магазині Товари для дому.`;

    const imageUrl = row.image_url ?? '';
    if (!/^https?:\/\//i.test(imageUrl)) continue;

    // Same honest rule as g:image_link: only absolute http(s) URLs survive;
    // capped at Google's 10-element limit, gallery order preserved. Empty
    // result → the field is not set at all.
    const additionalImageLinks = (row.additional_image_urls ?? [])
      .filter((url) => /^https?:\/\//i.test(url))
      .slice(0, GOOGLE_FEED_MAX_ADDITIONAL_IMAGES);

    if (!Number.isFinite(row.price) || row.price <= 0) continue;

    items.push({
      id: row.id,
      title: name.slice(0, GOOGLE_TITLE_MAX_LENGTH),
      description: truncateDescription(description),
      link: `${base}/product/${encodeURIComponent(row.slug)}`,
      imageLink: imageUrl,
      ...(additionalImageLinks.length > 0 ? { additionalImageLinks } : {}),
      availability: mapAvailability(row.availability_status),
      price: `${row.price.toFixed(2)} ${toIsoCurrency(row.currency)}`,
      ...(row.brand_name ? { brand: row.brand_name } : {}),
      condition: 'new',
      identifierExists: 'no',
      ...(row.category_path ? { productType: row.category_path } : {}),
    });
  }
  return items.slice(0, GOOGLE_FEED_MAX_ITEMS);
}

/**
 * Serializes items into a Google Merchant RSS 2.0 XML document (g: namespace
 * http://base.google.com/ns/1.0). All dynamic values pass through
 * escapeXml. opts.comment (e.g. a degraded-mode note) is emitted as an XML
 * comment right after the root element — it MUST NOT contain '--'.
 */
export function buildMerchantFeedXml(
  items: ReadonlyArray<MerchantFeedItem>,
  opts: { channelTitle?: string; comment?: string | null } = {}
): string {
  const esc = escapeXml;
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
  if (opts.comment) {
    const safe = opts.comment.replace(/--+/g, '-');
    parts.push(`<!-- ${safe} -->`);
  }
  parts.push('<channel>');
  parts.push(`  <title>${esc(opts.channelTitle ?? 'Product feed')}</title>`);
  for (const item of items) {
    const lines = [
      `    <g:id>${esc(item.id)}</g:id>`,
      `    <g:title>${esc(item.title)}</g:title>`,
      `    <g:description>${esc(item.description)}</g:description>`,
      `    <g:link>${esc(item.link)}</g:link>`,
      `    <g:image_link>${esc(item.imageLink)}</g:image_link>`,
      ...(item.additionalImageLinks ?? []).map(
        (url) => `    <g:additional_image_link>${esc(url)}</g:additional_image_link>`
      ),
      `    <g:availability>${esc(item.availability)}</g:availability>`,
      `    <g:price>${esc(item.price)}</g:price>`,
      item.brand ? `    <g:brand>${esc(item.brand)}</g:brand>` : null,
      `    <g:condition>${esc(item.condition)}</g:condition>`,
      `    <g:identifier_exists>${esc(item.identifierExists)}</g:identifier_exists>`,
      item.productType
        ? `    <g:product_type>${esc(item.productType)}</g:product_type>`
        : null,
    ].filter((line): line is string => line !== null);
    parts.push(`  <item>\n${lines.join('\n')}\n  </item>`);
  }
  parts.push('</channel>');
  parts.push('</rss>');
  return parts.join('\n');
}

/**
 * Category-like subset the path builder needs (Category from catalog.ts
 * satisfies it structurally). Pure so node:test exercises it without DB.
 */
export interface FeedCategoryLike {
  id: string;
  name: string;
  parent_id?: string | null;
  sort_order: number;
}

/**
 * Builds the g:product_type path «Корень / Подкатегория» for a product
 * assigned to `assignedCategoryIds`. The represented category is picked
 * deterministically from the assignments by the SAME commercial ordering
 * the storefront uses (compareCategories: sort_order, uk name, id); the
 * path walks parent_id links up to the root. Unknown assigned ids are
 * ignored; a cycle-safe visited set stops pathological parent loops.
 * Returns null when the product has no known category (field is optional).
 */
export function pickCategoryPath(
  assignedCategoryIds: ReadonlyArray<string>,
  categories: ReadonlyArray<FeedCategoryLike>
): string | null {
  if (assignedCategoryIds.length === 0) return null;
  const known = new Map(categories.map((c) => [c.id, c]));
  const assigned = assignedCategoryIds
    .map((id) => known.get(id))
    .filter((c): c is FeedCategoryLike => c !== undefined);
  if (assigned.length === 0) return null;
  assigned.sort(compareCategories);

  const parentOf = new Map<string, string>();
  for (const category of categories) {
    if (category.parent_id && known.has(category.parent_id)) {
      parentOf.set(category.id, category.parent_id);
    }
  }

  const path: string[] = [];
  const visited = new Set<string>();
  let cursor: FeedCategoryLike | undefined = assigned[0];
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    path.push(cursor.name);
    const parentId = parentOf.get(cursor.id);
    cursor = parentId ? known.get(parentId) : undefined;
  }
  path.reverse();
  return path.join(' / ');
}
