/**
 * Pure photo-source matchers for the wallpapers photo pipeline (plan Task 8,
 * spec §4: docs/superpowers/specs/2026-09-10-wallpapers-import-design.md).
 *
 * Responsibility: STRICT article-token matching against photo-source URLs
 * (sitemaps indexed by scripts/wallpaper-photos.ts), source priority order,
 * main-image/texture selection and --plan coverage reporting.
 *
 * A token matches a URL only when it is bounded by NON-DIGITS on both sides
 * (regex `(?<!\d)token(?![0-9])` on the lowercased URL): `531` must never
 * match inside `5310-01`, while `6647-04` legitimately matches
 * `v277-6647-04/` and `5190-01` matches `...-svezhest-5190-01-01f4bd`
 * (hash-suffixed slugs of extra sources). Letters/dashes around the token
 * are allowed on purpose — slugs glue articles to words (`oboi-bravo-86000br90`).
 *
 * NO Next.js / DB / Storage / network imports: this module is unit-tested
 * with node:test and consumes only plain data. The tokenizer
 * (parseArticleTokens) is injected by callers (CLI), keeping this module
 * decoupled from app/lib/wallpapers/parse.ts.
 */

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const SOURCE_PRIORITY = ['slav', 'epicentr', 'shpalery-ua', 'styleo', 'shpaleru'] as const;

export type PhotoSource = (typeof SOURCE_PRIORITY)[number];

/**
 * Sitemap entry points per source (research 2026-09-10, all public).
 * Semantics of multiple entries (enforced by the CLI):
 *  - epicentr: `first-success` fallback — 404 on products_main_ua.xml
 *    -> retry products_main_ua_000.xml;
 *  - shpalery-ua / styleo: `concat` — index -01 AND -02 (02 optional).
 */
export const SOURCE_SITEMAPS: Record<PhotoSource, string[]> = {
  slav: ['https://oboi-slav-oboi.com/sitemaps/sitemap-product-ua.xml'],
  epicentr: [
    'https://epicentrk.ua/upload/sitemap/new/products_ep/products_main_ua.xml',
    'https://epicentrk.ua/upload/sitemap/new/products_ep/products_main_ua_000.xml',
  ],
  'shpalery-ua': [
    'https://shpalery-ua.com/content/export/shpalery-ua.com/catalog-sitemap-01.xml',
    'https://shpalery-ua.com/content/export/shpalery-ua.com/catalog-sitemap-02.xml',
  ],
  styleo: [
    'https://styleo.com.ua/catalog-sitemap-01.xml',
    'https://styleo.com.ua/catalog-sitemap-02.xml',
  ],
  shpaleru: ['https://shpaleru.com.ua/sitemap_products-0.xml'],
};

export function isPhotoSource(value: string): value is PhotoSource {
  return (SOURCE_PRIORITY as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Token matching
// ---------------------------------------------------------------------------

function escapeRegExp(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trim + lowercase; null when nothing left (never match an empty token). */
export function normalizeArticleToken(raw: string): string | null {
  const token = raw.trim().toLowerCase();
  return token === '' ? null : token;
}

function compileTokenMatchers(articleTokens: string[]): RegExp[] {
  const matchers: RegExp[] = [];
  for (const raw of articleTokens) {
    const token = normalizeArticleToken(raw);
    if (token === null) continue;
    matchers.push(new RegExp(`(?<!\\d)${escapeRegExp(token)}(?![0-9])`));
  }
  return matchers;
}

/** Strict match: token bounded by non-digits on both sides in the lowercased URL. */
export function matchSourceUrl(url: string, articleTokens: string[]): boolean {
  const matchers = compileTokenMatchers(articleTokens);
  if (matchers.length === 0) return false;
  const lower = url.toLowerCase();
  return matchers.some((re) => re.test(lower));
}

/** First URL (in array order — callers pass sources by priority) that matches. */
export function matchSourceByUrl(urls: string[], articleTokens: string[]): string | null {
  const matchers = compileTokenMatchers(articleTokens);
  if (matchers.length === 0) return null;
  for (const url of urls) {
    const lower = url.toLowerCase();
    if (matchers.some((re) => re.test(lower))) return url;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sitemap XML helpers
// ---------------------------------------------------------------------------

const LOC_RE = /<(?:[a-z0-9]+:)?loc>([^<]+)<\/(?:[a-z0-9]+:)?loc>/gi;

function decodeBasicXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Extract absolute http(s) `<loc>` URLs from a sitemap/sitemap-index document. */
export function extractSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(LOC_RE)) {
    const raw = decodeBasicXmlEntities((m[1] ?? '').trim());
    if (!/^https?:\/\//i.test(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(raw);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Main image / textures
// ---------------------------------------------------------------------------

/** Product page carries the main photo + up to this many texture crops. */
export const MAX_TEXTURES = 12;

/** Host used to absolutize root-relative <img src> values on slav pages. */
const SLAV_ORIGIN = 'https://oboi-slav-oboi.com';

/** `src`/`href` carrying the product-asset path (img thumbs + fancybox <a> links).
 *  Lookbehind rejects `data-src` (hyphen/word char before the key). */
const PAGE_ASSET_ATTR_RE =
  /(?<![\w-])(?:src|href)\s*=\s*(?:"([^"]*assets\/products\/[^"]*)"|'([^']*assets\/products\/[^']*)')/gi;

/**
 * slav product-page image extraction (hotlink branch of --run): <img src>
 * thumbs AND fancybox <a href> full-size links, bare-relative included.
 * Keeps only URLs carrying the product-asset pattern `/assets/products/`,
 * absolutizes protocol-relative (`//…`) and root-relative (`/…`) values and
 * dedupes case-insensitively (first occurrence wins, document order kept).
 * The main/texture split (cap MAX_TEXTURES) is pickMainAndTextures' job.
 */
export function extractPageImages(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const attrMatch of html.matchAll(PAGE_ASSET_ATTR_RE)) {
    const raw = (attrMatch[1] ?? attrMatch[2] ?? '').trim();
    if (raw === '') continue;
    let url = decodeBasicXmlEntities(raw);
    if (/^https?:\/\//i.test(url)) {
      // уже абсолютный
    } else if (url.startsWith('//')) url = `https:${url}`;
    else if (url.startsWith('/')) url = `${SLAV_ORIGIN}${url}`;
    else url = `${SLAV_ORIGIN}/${url}`; // bare-relative (fancybox href)
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

/** MIME types accepted by the product_images bucket (JPEG/PNG/WebP only). */
export type DetectedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * Magic-byte sniffing for downloaded image copies (never trust the source's
 * content-type or file extension). SVG/HTML/GIF are deliberately absent —
 * same allow-list as the admin upload endpoint.
 */
export function detectImageMime(bytes: Uint8Array): DetectedImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }
  return null;
}

/** Sku prefix that marks a product as owned by the wallpapers feed. */
const WALLPAPER_SKU_PREFIX = 'wc-';

/**
 * EXACT copy of the importer sku rule (app/lib/wallpapers/import-plan.ts:
 * normalizeArticleKey + wallpaperSkuFor): article → `wc-<article lowercased,
 * whitespace stripped>`; article null/blank → `wc-x<code>`. Duplicated here
 * (import-plan keeps it private) so the photo pipeline maps items to the very
 * same product identity; equivalence is pinned by tests.
 */
export function wallpaperSkuForItem(item: PhotoItem): string {
  if (item.article !== null && item.article !== undefined) {
    const key = item.article.trim().toLowerCase().replace(/\s+/g, '');
    if (key !== '') return `${WALLPAPER_SKU_PREFIX}${key}`;
  }
  return `${WALLPAPER_SKU_PREFIX}x${item.code.trim()}`;
}

export interface MainAndTextures {
  main: string;
  textures: string[];
}

/**
 * main = first URL; textures = the remaining unique URLs, up to MAX_TEXTURES.
 * Deduplication is global (a repeat of `main` never re-enters textures).
 * Returns null when no usable URL remains.
 *
 * NOTE (решение владельца 2026-09-10 «1 фото = 1 карточка»): --run writes
 * ONLY `main` to product_images — textures are characteristics of OTHER
 * colourways of the same series, not of this product card. The pure split
 * stays intact so `main` selection keeps its tested semantics.
 */
export function pickMainAndTextures(imageUrls: string[]): MainAndTextures | null {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of imageUrls) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (url === '' || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  const main = unique[0];
  if (main === undefined) return null;
  return { main, textures: unique.slice(1, 1 + MAX_TEXTURES) };
}

// ---------------------------------------------------------------------------
// slav product-page characteristics (--specs)
// ---------------------------------------------------------------------------

/** Characteristic row of the slav spec table:
 * `<div class="table-item--caption">Довжина</div>…<div class="table-item--text">10.05 м</div>`.
 * The lazy gap between caption and text must not cross into the NEXT caption
 * (tempered pattern) — a caption without a text sibling is never paired. */
const SLAV_SPEC_PAIR_RE =
  /class="table-item--caption"[^>]*>([^<]*)<\/div>(?:(?!table-item--caption)[\s\S])*?class="table-item--text"[^>]*>([^<]*)</g;

/** Any anchor carrying the room filter (`/f/tip-pomeshheniya=…` + `item-filter`);
 * the visible room name is the anchor's leading text. */
const SLAV_ROOM_ANCHOR_RE = /<a\b([^>]*)>([^<]*)</g;

/** Name of the synthesized characteristic holding the comma-joined rooms. */
export const SLAV_ROOMS_SPEC_NAME = 'Приміщення';

/**
 * Characteristics of a slav product page (pure; consumed by --specs):
 *  - caption/text pairs of the spec table, trimmed, basic-decoded (`&amp;` …),
 *    deduped by name (FIRST value wins — same-name duplicates on the page are
 *    render variants, unlike the YC feed where duplicates are meaningful);
 *  - plus one synthesized `{name: 'Приміщення', value: 'Вітальня, Спальня'}`
 *    (join ', ') when the page lists ≥1 room filter chip.
 * Empty names/values and icon-first anchors yield nothing; `''` → `[]`.
 */
export function parseSlavCharacteristics(html: string): Array<{ name: string; value: string }> {
  const specs: Array<{ name: string; value: string }> = [];
  const seenNames = new Set<string>();
  for (const m of html.matchAll(SLAV_SPEC_PAIR_RE)) {
    const name = decodeBasicXmlEntities((m[1] ?? '').trim());
    const value = decodeBasicXmlEntities((m[2] ?? '').trim());
    if (name === '' || value === '') continue;
    if (seenNames.has(name)) continue; // дедуп по name — первое значение побеждает
    seenNames.add(name);
    specs.push({ name, value });
  }
  const rooms: string[] = [];
  const seenRooms = new Set<string>();
  for (const m of html.matchAll(SLAV_ROOM_ANCHOR_RE)) {
    const attrs = (m[1] ?? '').toLowerCase();
    if (!attrs.includes('tip-pomeshheniya=') || !attrs.includes('item-filter')) continue;
    const room = decodeBasicXmlEntities((m[2] ?? '').trim());
    if (room === '' || seenRooms.has(room)) continue;
    seenRooms.add(room);
    rooms.push(room);
  }
  if (rooms.length > 0) specs.push({ name: SLAV_ROOMS_SPEC_NAME, value: rooms.join(', ') });
  return specs;
}

// ---------------------------------------------------------------------------
// --plan coverage
// ---------------------------------------------------------------------------

export interface PhotoItem {
  code: string;
  name: string;
  article?: string | null;
}

export interface SourceCoverage {
  source: PhotoSource;
  /** URL count found in the cached index (0 = no cache / empty index). */
  indexUrls: number;
  matchedItems: number;
  /** Distinct source URLs matched by at least one item. */
  matchedUrls: number;
  /** All matched item codes, in item order. */
  matchedCodes: string[];
  /** First matches for eyeballing (default cap 5, see planPhotoCoverage). */
  samples: { code: string; url: string }[];
}

export interface CoverageOptions {
  sampleSize?: number;
}

/**
 * Per-source coverage report for `--plan`. Sources without a cache are still
 * reported (indexUrls = 0) so the operator sees what has not been indexed yet.
 * `tokensOf` is injected (CLI uses the article column first, then
 * parseArticleTokens(name)).
 */
export function planPhotoCoverage(
  items: PhotoItem[],
  indexUrlsBySource: Partial<Record<PhotoSource, string[]>>,
  tokensOf: (item: PhotoItem) => string[],
  options: CoverageOptions = {},
): SourceCoverage[] {
  const sampleSize = options.sampleSize ?? 5;
  return SOURCE_PRIORITY.map((source) => {
    const urls = indexUrlsBySource[source] ?? [];
    const matchedUrlSet = new Set<string>();
    const matchedCodes: string[] = [];
    const samples: { code: string; url: string }[] = [];
    for (const item of items) {
      const matchers = compileTokenMatchers(tokensOf(item));
      if (matchers.length === 0) continue;
      let matchedUrl: string | null = null;
      for (const url of urls) {
        const lower = url.toLowerCase();
        if (matchers.some((re) => re.test(lower))) {
          matchedUrl = url;
          break;
        }
      }
      if (matchedUrl === null) continue;
      matchedCodes.push(item.code);
      matchedUrlSet.add(matchedUrl);
      if (samples.length < sampleSize) samples.push({ code: item.code, url: matchedUrl });
    }
    return {
      source,
      indexUrls: urls.length,
      matchedItems: matchedCodes.length,
      matchedUrls: matchedUrlSet.size,
      matchedCodes,
      samples,
    };
  });
}

/** Union of matched item codes across sources (order of first appearance). */
export function unionCoveredCodes(covs: SourceCoverage[]): Set<string> {
  const covered = new Set<string>();
  for (const cov of covs) {
    for (const code of cov.matchedCodes) covered.add(code);
  }
  return covered;
}
