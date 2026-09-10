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

export interface MainAndTextures {
  main: string;
  textures: string[];
}

/**
 * main = first URL; textures = the remaining unique URLs, up to MAX_TEXTURES.
 * Deduplication is global (a repeat of `main` never re-enters textures).
 * Returns null when no usable URL remains.
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
