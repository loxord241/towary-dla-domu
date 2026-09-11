#!/usr/bin/env node
/**
 * Wallpapers PHOTO PIPELINE — CLI (plan Task 8, spec §4).
 *
 * Responsibilities of THIS task: sitemap INDEXING of photo sources,
 * article-token MATCHING, --plan coverage reports and the --run acquisition
 * phase (orchestrator GO only).
 *
 * Modes:
 *   node scripts/wallpaper-photos.ts --index <slav|epicentr|shpalery-ua|styleo|shpaleru>
 *       Download the source sitemap (fetch, 30s timeout, UA header, 200ms
 *       throttle) and cache the URL list to data/photo-cache/<source>.json.
 *   node scripts/wallpaper-photos.ts --plan --items <items.json> [--source <s>]
 *       Read cached indexes + a JSON file of stock positions
 *       (array of {code,name,article}) and print how many positions each
 *       source covers (strict token match, priority order). Read-only.
 *   node scripts/wallpaper-photos.ts --run --items <items.json>
 *        [--source <s> | --sources <a,b,c>] [--dry]
 *       Photo acquisition (writes DB/Storage — orchestrator GO only):
 *       maps items onto wc-* products with the importer sku rule, walks the
 *       sources in priority order (first hit closes a position; positions
 *       that already own any product_images row are skipped):
 *         - slav   -> fetch the product page (30s timeout, 200ms throttle),
 *                     parse <img> (/assets/products/), write ONE hotlink URL
 *                     (main, is_main=true, sort_order=0). РЕШЕНИЕ владельца
 *                     2026-09-10 «1 фото = 1 карточка»: текстуры со страницы
 *                     — это ДРУГИЕ колеровки той же серии, в карточку товара
 *                     они больше НЕ пишутся (2852 чужих не-main фото уже
 *                     удалены из БД оркестратором);
 *         - others -> the matched sitemap/url-map URL is a PRODUCT PAGE:
 *                     fetch it as TEXT (30s timeout, 200ms throttle), take the
 *                     first og:image meta (relative values resolve against the
 *                     page URL; no og:image = soft-404 → «сбой скачивания»)
 *                     and download THAT image (≤5 MB, jpeg/png/webp by magic
 *                     bytes), upload to Storage bucket product_images under
 *                     `<sku>/<sanitized>.<ext>` (upload-filename hardening)
 *                     and write the RELATIVE path to product_images;
 *       product_images INSERT is diff-aware: existing (product_id,image_url)
 *       pairs are pre-read (`.in` chunks ≤200, windows ≤1000 + .order),
 *       duplicates (23505) are skipped as no-ops, other DB errors stop the
 *       run (a re-run is the recovery path). Download failures are never
 *       fatal — the position lands in the «сбой скачивания» / «без фото»
 *       reports. --dry performs everything except DB/Storage writes.
 *   node scripts/wallpaper-photos.ts --specs --items <items.json>
 *        [--url-map map.json] [--dry]
 *       Characteristics import from slav product pages (writes DB —
 *       orchestrator GO only): for wc-* products whose codes match the slav
 *       index cache (data/photo-cache/slav.json, --url-map overrides per
 *       code) fetch the page (30s timeout, 200ms throttle), parse the spec
 *       table + room chips (parseSlavCharacteristics) and, when non-empty,
 *       UPDATE products.specifications (jsonb array [{name,value}...]).
 *       Products whose page parses to NO characteristics are NOT touched.
 *       РЕШЕНИЕ владельца 2026-09-10: для wc-* товаров specifications
 *       ПЕРЕЗАПИСЫВАЕТСЯ slav-версией без diff — wc-* импортированы этим
 *       пайплайном и собственных specifications из другой системы не имеют;
 *       товары вне wc-* домена недостижимы по построению (выборка
 *       `yugcontract_id IS NULL AND sku LIKE 'wc-%'`). DB update errors stop
 *       the run (a re-run is the recovery path); --dry performs everything
 *       except the UPDATE.
 *
 * --index/--plan/--specs stay read-only unless --specs is given --dry=false;
 * DB writes happen only in --run/--specs (service-role client built lazily
 * from .env.local / shell env, persistSession: false — pattern
 * scripts/wallpaper-import.ts; statically pinned by
 * tests/wallpaper-photo-sources.test.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { SupabaseClient } from '@supabase/supabase-js';

import { parseArticleTokens } from '../app/lib/wallpapers/parse.ts';
import {
  SOURCE_PRIORITY,
  SOURCE_SITEMAPS,
  detectImageMime,
  extractOgImage,
  extractPageImages,
  extractSitemapUrls,
  isPhotoSource,
  matchSourceByUrl,
  normalizeArticleToken,
  parseSlavCharacteristics,
  pickMainAndTextures,
  planPhotoCoverage,
  unionCoveredCodes,
  wallpaperSkuForItem,
  type PhotoItem,
  type PhotoSource,
} from '../app/lib/wallpapers/photo-sources.ts';
import { sanitizeUploadFileName } from '../app/lib/upload-filename.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Default cache location (/data is gitignored). */
export const DEFAULT_CACHE_DIR = path.join(root, 'data', 'photo-cache');

const FETCH_TIMEOUT_MS = 30_000;
/** Politeness delay between consecutive sitemap fetches. */
export const THROTTLE_MS = 200;
/** Defensive cap on sitemap-index nesting expansion. */
const NESTED_SITEMAP_CAP = 20;

/** PostgREST caps any single response at 1000 rows — read windows stay ≤1000. */
export const PAGE_SIZE = 1000;
/** Project invariant: ≤200 ids per `.in()` chunk (long GET URLs break PostgREST). */
export const PAIR_CHUNK_SIZE = 200;
/** Storage bucket limit (migration 025): larger images are rejected. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Public-read bucket; relative object paths are stored in product_images. */
export const STORAGE_BUCKET = 'product_images';

export const USER_AGENT =
  'Mozilla/5.0 (compatible; MyShopWallpaperPhotos/1.0; photo-index bot; +https://towary-dla-domu.com)';

const USAGE = `Usage:
  node scripts/wallpaper-photos.ts --index <slav|epicentr|shpalery-ua|styleo|shpaleru> [--cache-dir DIR]
  node scripts/wallpaper-photos.ts --plan --items <items.json> [--source <s>] [--cache-dir DIR]
  node scripts/wallpaper-photos.ts --run --items <items.json> [--source <s> | --sources <a,b,c>] [--dry] [--cache-dir DIR]
  node scripts/wallpaper-photos.ts --specs --items <items.json> [--url-map map.json] [--dry] [--cache-dir DIR]`;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export class HttpFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpFetchError';
    this.status = status;
  }
}

/** curl-like fetch: UA header, 30s hard timeout, non-2xx -> HttpFetchError. */
export async function fetchSitemapText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/xml,text/xml,application/rss+xml,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new HttpFetchError(res.status, `HTTP ${res.status} for ${url}`);
  return await res.text();
}

/** Image download: UA header, 30s hard timeout, non-2xx -> HttpFetchError. */
export async function fetchImageBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8,*/*;q=0.5',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new HttpFetchError(res.status, `HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Product-page download for the non-slav copy branch: UA header, HTML accept,
 * 30s hard timeout, non-2xx -> HttpFetchError (separate from fetchSitemapText/
 * fetchImageBytes because the accept header differs and the response is text,
 * never bytes). */
export async function fetchPageText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new HttpFetchError(res.status, `HTTP ${res.status} for ${url}`);
  return await res.text();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * - epicentr: first-success (products_main_ua.xml 404 -> _000 fallback);
 * - shpalery-ua / styleo: concat (-01 required, -02 optional);
 * - slav / shpaleru: single sitemap.
 */
const SITEMAP_MODE: Record<PhotoSource, 'first-success' | 'concat'> = {
  slav: 'first-success',
  epicentr: 'first-success',
  'shpalery-ua': 'concat',
  styleo: 'concat',
  shpaleru: 'first-success',
};

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

async function fetchSourceIndex(
  source: PhotoSource,
  fetchText: (url: string) => Promise<string>,
  log: (line: string) => void,
): Promise<{ urls: string[]; sitemapUrls: string[] }> {
  const entries = SOURCE_SITEMAPS[source];
  const mode = SITEMAP_MODE[source];
  const collected: string[] = [];
  const sitemapUrls: string[] = [];
  let fetchCount = 0;
  let firstError: unknown = null;

  const doFetch = async (url: string): Promise<string> => {
    if (fetchCount > 0) await sleep(THROTTLE_MS);
    fetchCount += 1;
    return fetchText(url);
  };

  for (const [i, entry] of entries.entries()) {
    let xml: string;
    try {
      xml = await doFetch(entry);
    } catch (err) {
      if (mode === 'first-success') {
        if (err instanceof HttpFetchError && err.status === 404) {
          firstError ??= err; // try the next (fallback) entry point
          continue;
        }
        throw err;
      }
      if (i === 0) throw err; // concat: the primary sitemap is required
      log(`[index] ${source}: optional sitemap failed (${err instanceof Error ? err.message : String(err)}), continuing`);
      continue;
    }

    sitemapUrls.push(entry);
    const locs = extractSitemapUrls(xml);
    for (const loc of locs) {
      if (!loc.toLowerCase().endsWith('.xml')) collected.push(loc);
    }

    // Defensive: one level of sitemap-index nesting, capped.
    let nestedFetched = 0;
    for (const loc of locs) {
      if (!loc.toLowerCase().endsWith('.xml')) continue;
      if (nestedFetched >= NESTED_SITEMAP_CAP) break;
      nestedFetched += 1;
      try {
        const nestedXml = await doFetch(loc);
        sitemapUrls.push(loc);
        for (const nested of extractSitemapUrls(nestedXml)) {
          if (!nested.toLowerCase().endsWith('.xml')) collected.push(nested);
        }
      } catch (err) {
        log(`[index] ${source}: nested sitemap failed (${err instanceof Error ? err.message : String(err)}), continuing`);
      }
    }

    if (mode === 'first-success') return { urls: collected, sitemapUrls };
  }

  if (mode === 'first-success') {
    throw firstError instanceof Error
      ? firstError
      : new Error(`no sitemap succeeded for ${source}`);
  }
  return { urls: collected, sitemapUrls };
}

/** Shared pre-flight for --run/--specs: read data/photo-cache/<source>.json
 * (fail-closed BEFORE any read/write; a corrupt cache is never silently []).
 * logPrefix keeps the per-action error tags ("[run]"/"[specs]"). */
function readIndexCache(cacheDir: string, source: PhotoSource, logPrefix: string): string[] {
  const cachePath = path.join(cacheDir, `${source}.json`);
  if (!existsSync(cachePath)) {
    throw new Error(
      `${logPrefix} ${source}: нет кэша индекса (${cachePath}) — сначала выполните: ` +
        `node scripts/wallpaper-photos.ts --index ${source}`,
    );
  }
  let parsed: { urls?: unknown };
  try {
    parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { urls?: unknown };
  } catch (err) {
    throw new Error(
      `${logPrefix} ${source}: кэш индекса повреждён (${cachePath}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return Array.isArray(parsed.urls)
    ? parsed.urls.filter((u): u is string => typeof u === 'string')
    : [];
}

// ---------------------------------------------------------------------------
// --plan helpers
// ---------------------------------------------------------------------------

/** Article column first (most precise), parseArticleTokens(name) as fallback. */
export function articleTokensForItem(item: PhotoItem): string[] {
  const direct = normalizeArticleToken(item.article ?? '');
  if (direct !== null) return [direct];
  return parseArticleTokens(item.name);
}

function loadItems(itemsPath: string): PhotoItem[] {
  let raw: string;
  try {
    raw = readFileSync(itemsPath, 'utf8');
  } catch {
    throw new Error(`cannot read --items file: ${itemsPath}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('--items file must contain a JSON array of {code,name,article}');
  }
  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`items[${i}]: must be an object {code,name,article}`);
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec['code'] !== 'string') throw new Error(`items[${i}]: "code" must be a string`);
    if (typeof rec['name'] !== 'string') throw new Error(`items[${i}]: "name" must be a string`);
    const article = rec['article'];
    if (article !== undefined && article !== null && typeof article !== 'string') {
      throw new Error(`items[${i}]: "article" must be a string or null`);
    }
    return { code: rec['code'], name: rec['name'], article: article ?? null };
  });
}

// ---------------------------------------------------------------------------
// CLI actions
// ---------------------------------------------------------------------------

export interface CliArgs {
  action: 'index' | 'plan' | 'run' | 'specs';
  source?: PhotoSource;
  /** --run only: resolved source list, priority order (see resolveRunSources). */
  sources?: PhotoSource[];
  items?: string;
  cacheDir: string;
  /** --run only: full simulation, ZERO DB/Storage writes. */
  dry: boolean;
  /** --run/--specs: research-agent maps {1C code -> page/image URL}. */
  urlMapFiles?: string[];
}

/**
 * --run source list resolution: `--source` (single), `--sources` (comma-
 * separated, deduped and reordered to SOURCE_PRIORITY) or all sources.
 */
export function resolveRunSources(
  source: PhotoSource | undefined,
  sourcesRaw: string | null,
): PhotoSource[] {
  if (source !== undefined) return [source];
  if (sourcesRaw !== null) {
    const requested = sourcesRaw.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (requested.length === 0) {
      throw new Error(
        `--sources requires at least one source (valid: ${SOURCE_PRIORITY.join('|')})\n` + USAGE,
      );
    }
    for (const s of requested) {
      if (!isPhotoSource(s)) {
        throw new Error(`unknown source "${s}" (valid: ${SOURCE_PRIORITY.join('|')})\n` + USAGE);
      }
    }
    const unique = new Set(requested);
    return SOURCE_PRIORITY.filter((s) => unique.has(s));
  }
  return [...SOURCE_PRIORITY];
}

export function parseArgs(argv: string[]): CliArgs {
  const actions: string[] = [];
  let indexSource: string | null = null;
  let sourceFlag: string | null = null;
  let sourcesRaw: string | null = null;
  let items: string | null = null;
  const urlMapFiles: string[] = [];
  let cacheDir: string | null = null;
  let dry = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    switch (arg) {
      case '--index': {
        actions.push('index');
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error('--index requires a source argument\n' + USAGE);
        }
        indexSource = value;
        i += 1;
        break;
      }
      case '--plan':
        actions.push('plan');
        break;
      case '--run':
        actions.push('run');
        break;
      case '--specs':
        actions.push('specs');
        break;
      case '--source': {
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error('--source requires a value\n' + USAGE);
        }
        sourceFlag = value;
        i += 1;
        break;
      }
      case '--sources': {
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error('--sources requires a comma-separated list\n' + USAGE);
        }
        sourcesRaw = value;
        i += 1;
        break;
      }
      case '--items': {
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error('--items requires a file path\n' + USAGE);
        }
        items = value;
        i += 1;
        break;
      }
      case '--url-map': {
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error('--url-map requires a file path\n' + USAGE);
        }
        urlMapFiles.push(value);
        i += 1;
        break;
      }
      case '--cache-dir': {
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error('--cache-dir requires a directory path\n' + USAGE);
        }
        cacheDir = value;
        i += 1;
        break;
      }
      case '--dry':
        dry = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}"\n${USAGE}`);
    }
  }

  if (actions.length === 0) {
    throw new Error('no action given.\n' + USAGE);
  }
  if (actions.length > 1) {
    throw new Error(`exactly one action is required, got: ${actions.join(', ')}\n` + USAGE);
  }

  if (actions[0] === 'index') {
    if (sourceFlag !== null) {
      throw new Error('--source is not used with --index (the source is the --index argument)');
    }
    if (sourcesRaw !== null || dry) {
      throw new Error('--sources/--dry are only valid with --run\n' + USAGE);
    }
    if (indexSource === null || !isPhotoSource(indexSource)) {
      throw new Error(
        `unknown source "${indexSource ?? ''}" (valid: ${SOURCE_PRIORITY.join('|')})`,
      );
    }
    return { action: 'index', source: indexSource, cacheDir: cacheDir ?? DEFAULT_CACHE_DIR, dry: false };
  }

  let source: PhotoSource | undefined;
  if (sourceFlag !== null) {
    if (!isPhotoSource(sourceFlag)) {
      throw new Error(`unknown source "${sourceFlag}" (valid: ${SOURCE_PRIORITY.join('|')})`);
    }
    source = sourceFlag;
  }

  if (actions[0] === 'plan') {
    if (sourcesRaw !== null || dry) {
      throw new Error('--sources/--dry are only valid with --run\n' + USAGE);
    }
    if (items === null) throw new Error('--plan requires --items <items.json>\n' + USAGE);
    return { action: 'plan', source, items, cacheDir: cacheDir ?? DEFAULT_CACHE_DIR, dry: false };
  }

  // --specs: characteristics import from slav pages (single source by design).
  if (actions[0] === 'specs') {
    if (sourceFlag !== null || sourcesRaw !== null) {
      throw new Error(
        '--source/--sources are not applicable to --specs (slav is the only characteristics source)\n' +
          USAGE,
      );
    }
    if (items === null) throw new Error('--specs requires --items <items.json>\n' + USAGE);
    return {
      action: 'specs',
      items,
      cacheDir: cacheDir ?? DEFAULT_CACHE_DIR,
      dry,
      urlMapFiles: urlMapFiles.length > 0 ? urlMapFiles : undefined,
    };
  }

  // --run: positions file is mandatory, sources resolve to a priority list.
  if (items === null) throw new Error('--run requires --items <items.json>\n' + USAGE);
  if (source !== undefined && sourcesRaw !== null) {
    throw new Error('use either --source <s> or --sources <a,b,c>, not both\n' + USAGE);
  }
  return {
    action: 'run',
    source,
    sources: resolveRunSources(source, sourcesRaw),
    items,
    cacheDir: cacheDir ?? DEFAULT_CACHE_DIR,
    dry,
    urlMapFiles: urlMapFiles.length > 0 ? urlMapFiles : undefined,
  };
}

// ---------------------------------------------------------------------------
// --run: Supabase access (service role, pattern: scripts/wallpaper-import.ts)
// ---------------------------------------------------------------------------

/** .env.local loader (same contract as scripts/wallpaper-import.ts). */
function loadEnvLocal(): void {
  try {
    for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (
        match &&
        match[1] !== undefined &&
        match[2] !== undefined &&
        process.env[match[1]] === undefined
      ) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // env vars can come from the shell too
  }
}

/** Service-role client, built lazily ONLY inside --run (persistSession: false). */
async function createServiceClient(): Promise<SupabaseClient> {
  loadEnvLocal();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (supabaseUrl === '' || serviceKey === '') {
    throw new Error(
      'Немає SUPABASE env-змінних (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  }
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

type PageResult<T> = { data: T[] | null; error: { message: string } | null };
type PageFetcher<T> = (from: number) => PromiseLike<PageResult<T>>;

/** Deterministic multi-page read: contiguous PAGE_SIZE windows with an
 * `.order()` tiebreaker at every call site (project pagination invariant). */
async function readAllPages<T>(fetchPage: PageFetcher<T>, what: string): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await fetchPage(from);
    if (error) throw new Error(`помилка читання ${what}: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    from += PAGE_SIZE;
  }
}

interface ProductDbRow {
  id: unknown;
  sku: unknown;
}

/** The wallpaper domain only: yugcontract_id IS NULL AND sku LIKE 'wc-%'. */
async function readWallpaperProducts(
  client: SupabaseClient,
): Promise<Map<string, { id: string; sku: string }>> {
  const rows = await readAllPages<ProductDbRow>(
    (from) =>
      client
        .from('products')
        .select('id,sku')
        .is('yugcontract_id', null)
        .like('sku', 'wc-%')
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<ProductDbRow[]>(),
    'products (wc-*)',
  );
  const bySku = new Map<string, { id: string; sku: string }>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.sku !== 'string') continue;
    const sku = row.sku.trim();
    if (sku === '') continue;
    bySku.set(sku, { id: row.id, sku });
  }
  return bySku;
}

interface ImagePairDbRow {
  product_id: unknown;
  image_url: unknown;
}

/**
 * Existing (product_id, image_url) pairs for the whole wc-* domain:
 * `.in` chunks of ≤200 ids, each chunk read in PAGE_SIZE pages with an
 * `.order('product_id')` tiebreaker — the content-images/publish pattern
 * (project pagination invariants). Keyed product_id → set of image_url.
 */
async function readExistingImagePairs(
  client: SupabaseClient,
  productIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const pairs = new Map<string, Set<string>>();
  for (let i = 0; i < productIds.length; i += PAIR_CHUNK_SIZE) {
    const group = productIds.slice(i, i + PAIR_CHUNK_SIZE);
    const rows = await readAllPages<ImagePairDbRow>(
      (from) =>
        client
          .from('product_images')
          .select('product_id,image_url')
          .in('product_id', group)
          .order('product_id')
          .range(from, from + PAGE_SIZE - 1)
          .returns<ImagePairDbRow[]>(),
      'product_images',
    );
    for (const row of rows) {
      if (typeof row.product_id !== 'string' || typeof row.image_url !== 'string') continue;
      rememberPair(pairs, row.product_id, row.image_url);
    }
  }
  return pairs;
}

function pairExists(
  pairs: ReadonlyMap<string, Set<string>>,
  productId: string,
  imageUrl: string,
): boolean {
  return pairs.get(productId)?.has(imageUrl) === true;
}

function rememberPair(pairs: Map<string, Set<string>>, productId: string, imageUrl: string): void {
  const set = pairs.get(productId);
  if (set === undefined) pairs.set(productId, new Set([imageUrl]));
  else set.add(imageUrl);
}

interface ProductImageInsert {
  product_id: string;
  image_url: string;
  is_main: boolean;
  sort_order: number;
}

type InsertOutcome = 'inserted' | 'duplicate';

function isUniqueViolation(error: { code?: string; message: string }): boolean {
  return error.code === '23505' || /duplicate key|unique constraint/i.test(error.message);
}

/** Single-row INSERT so a 23505 (unique pair / main-per-product race) stays a
 * per-row no-op instead of failing a whole batch. Any other DB error throws —
 * a re-run is the recovery path (diff-aware → only missing rows are written). */
async function insertImageRow(
  client: SupabaseClient,
  row: ProductImageInsert,
): Promise<InsertOutcome> {
  const { error } = await client.from('product_images').insert(row);
  if (error === null) return 'inserted';
  if (isUniqueViolation(error)) return 'duplicate';
  throw new Error(
    `product_images insert (product_id=${row.product_id}, url=${row.image_url}): ${error.message}`,
  );
}

/** Basename of a URL path (query/hash stripped), never empty. */
function urlBasename(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const name = clean.substring(clean.lastIndexOf('/') + 1);
  return name === '' ? 'image' : name;
}

/** Default Storage upload: bucket product_images, MIME from magic bytes,
 * never upsert (a duplicate path must surface, not silently overwrite). */
async function uploadViaStorage(
  client: SupabaseClient,
  storagePath: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ error: { message: string } | null }> {
  const { error } = await client.storage.from(STORAGE_BUCKET).upload(storagePath, bytes, {
    contentType,
    upsert: false,
  });
  return { error: error === null ? null : { message: error.message } };
}

// ---------------------------------------------------------------------------
// --run: the acquisition phase (orchestrator GO only)
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** JSON file of stock positions (array of {code,name,article}), as --plan. */
  itemsPath: string;
  /** Requested sources; ALWAYS walked in SOURCE_PRIORITY order. */
  sources: readonly PhotoSource[];
  cacheDir: string;
  /** Everything except DB/Storage writes (orchestrator pre-flight). */
  dry: boolean;
  /** Research-agent maps {1C code -> page/image URL}; overrides token matching. */
  urlMapFiles?: string[];
}

export interface SourceRunStats {
  matched: number;
  /** Non-slav copies downloaded + uploaded to Storage (1 per position). */
  downloaded: number;
  /** slav hotlink URL rows written to product_images. */
  hotlinked: number;
  /** Download/upload failures for this source (never fatal). */
  failed: number;
  /** INSERTs rejected as 23505 → skipped as no-ops. */
  noop23505: number;
}

export interface RunTotals {
  items: number;
  /** Items mapped onto a wc-* product and eligible this run. */
  matchedProducts: number;
  /** Items whose derived sku has no wc-* product row (skipped). */
  noProduct: number;
  /** Positions that already own ≥1 image (diff-aware skip, never re-written). */
  alreadyHadPhotos: number;
  /** Total rows written (dry: would-be rows). */
  insertedRows: number;
  /** Codes with a download failure that still ended the run WITHOUT photos. */
  downloadFailedCodes: string[];
  /** Codes with no photo after every requested source (съёмка checklist). */
  noPhotoCodes: string[];
  bySource: Partial<Record<PhotoSource, SourceRunStats>>;
}

/**
 * Photo acquisition. Diff-aware and idempotent: positions already owning any
 * product_images row are skipped, first matching source closes a position,
 * duplicate pairs (23505) degrade to logged no-ops — a full re-run inserts
 * nothing. Download/upload failures are per-position and non-fatal.
 */
/** Research-agent URL maps: origin decides which pipeline branch handles them. */
function sourceFromUrl(url: string): PhotoSource | null {
  if (url.includes('oboi-slav-oboi.com')) return 'slav';
  if (url.includes('epicentrk.ua') || url.includes('cdn.27.ua')) return 'epicentr';
  if (url.includes('shpalery-ua.com')) return 'shpalery-ua';
  if (url.includes('shpaleru.com.ua') || url.includes('images.prom.ua')) return 'shpaleru';
  if (url.includes('styleo.com.ua')) return 'styleo';
  return null;
}

export async function run(options: RunOptions, deps: CliDeps = {}): Promise<RunTotals> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const fetchText = deps.fetchText ?? fetchSitemapText;
  const fetchPage = deps.fetchPageText ?? fetchPageText;
  const fetchImage = deps.fetchImage ?? fetchImageBytes;
  const throttleGap = deps.throttleMs ?? THROTTLE_MS;

  // Priority order wins regardless of how the caller listed the sources.
  const sources = SOURCE_PRIORITY.filter((s) => options.sources.includes(s));

  // ---- items (same loader/validation as --plan) ----
  const items = loadItems(options.itemsPath);

  // ---- explicit URL maps (research agents): code -> page/image URL ----
  const explicitBySource: Partial<Record<PhotoSource, Map<string, string>>> = {};
  for (const mapFile of options.urlMapFiles ?? []) {
    const map = JSON.parse(readFileSync(mapFile, 'utf8')) as Record<string, string>;
    for (const [code, url] of Object.entries(map)) {
      const src = sourceFromUrl(url);
      if (src === null) {
        throw new Error(`[run] ${mapFile}: неопознанный источник у ${code}: ${url}`);
      }
      (explicitBySource[src] ??= new Map()).set(code, url);
    }
  }

  // ---- pre-flight: EVERY requested source must have an index cache ----
  // Fail before any read/write so a missing later source cannot strand
  // half-processed positions behind a crash.
  const indexBySource: Partial<Record<PhotoSource, string[]>> = {};
  for (const source of sources) {
    indexBySource[source] = readIndexCache(options.cacheDir, source, '[run]');
  }

  // ---- DB: wc-* products + existing (product_id, image_url) pairs ----
  const client = deps.client ?? (await createServiceClient());
  const productsBySku = await readWallpaperProducts(client);
  const existingPairs = await readExistingImagePairs(
    client,
    [...productsBySku.values()].map((p) => p.id),
  );

  // ---- item -> product positioning (diff-aware closure) ----
  interface Position {
    item: PhotoItem;
    product: { id: string; sku: string };
    open: boolean;
  }
  const positions: Position[] = [];
  let noProduct = 0;
  const noProductCodes: string[] = [];
  let alreadyHadPhotos = 0;
  for (const item of items) {
    const product = productsBySku.get(wallpaperSkuForItem(item));
    if (product === undefined) {
      noProduct += 1;
      noProductCodes.push(item.code);
      continue;
    }
    // A position with any image (previous run or manual upload) is closed:
    // extra sources stay «альтернативы» and are never written (spec §4.2).
    if ((existingPairs.get(product.id)?.size ?? 0) > 0) {
      alreadyHadPhotos += 1;
      continue;
    }
    positions.push({ item, product, open: true });
  }

  const stats: Partial<Record<PhotoSource, SourceRunStats>> = {};
  for (const source of sources) {
    stats[source] = { matched: 0, downloaded: 0, hotlinked: 0, failed: 0, noop23505: 0 };
  }
  const failedCodes = new Set<string>();
  let lastNetworkAt = 0;
  const throttle = async (): Promise<void> => {
    if (throttleGap <= 0) return;
    const nowMs = Date.now();
    if (lastNetworkAt + throttleGap > nowMs) {
      await sleep(lastNetworkAt + throttleGap - nowMs);
    }
    lastNetworkAt = Date.now();
  };

  log(
    `[run] ${options.dry ? 'DRY (без записів)' : 'WRITE'} items=${items.length} ` +
      `sources=${sources.join(',')} products(wc-*)=${productsBySku.size}`,
  );

  for (const source of sources) {
    const sStats = stats[source] as SourceRunStats;
    const urls = indexBySource[source] ?? [];
    for (const pos of positions) {
      if (!pos.open) continue;
      const explicit = explicitBySource[source]?.get(pos.item.code);
      const url = explicit ?? matchSourceByUrl(urls, articleTokensForItem(pos.item));
      if (url === null) continue;
      sStats.matched += 1;

      if (source === 'slav') {
        // ---- hotlink branch: fetch page, parse <img>, write absolute URLs ----
        await throttle();
        let html: string;
        try {
          html = await fetchText(url);
        } catch (err) {
          sStats.failed += 1;
          failedCodes.add(pos.item.code);
          log(
            `[run] slav: ${pos.item.code} сбой скачивания страницы ${url}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const picked = pickMainAndTextures(extractPageImages(html));
        if (picked === null) {
          sStats.failed += 1;
          failedCodes.add(pos.item.code);
          log(`[run] slav: ${pos.item.code} на странице нет фото /assets/products/ — ${url}`);
          continue;
        }
        // 1 фото = 1 карточка (решение владельца 2026-09-10): текстуры страницы
        // — другие колеровки серии, в карточку НЕ пишутся. picked остаётся
        // источником main (его семантика закреплена pure-тестами).
        const rows: ProductImageInsert[] = [
          { product_id: pos.product.id, image_url: picked.main, is_main: true, sort_order: 0 },
        ];
        let written = 0;
        for (const row of rows) {
          if (pairExists(existingPairs, row.product_id, row.image_url)) continue;
          if (options.dry) {
            written += 1;
            continue;
          }
          const outcome = await insertImageRow(client, row);
          if (outcome === 'duplicate') {
            sStats.noop23505 += 1;
            log(`[run] slav: ${pos.item.code} дубликат product_images — no-op (${row.image_url})`);
            continue;
          }
          rememberPair(existingPairs, row.product_id, row.image_url);
          written += 1;
        }
        sStats.hotlinked += written;
        pos.open = false;
      } else {
        // ---- copy branch: page -> og:image -> download -> validate -> Storage ----
        // The sitemaps of epicentr/shpalery-ua/styleo/shpaleru index PRODUCT
        // PAGES, not images (live run 2026-09-11: 64+2+4 «сбой скачивания» —
        // HTML failed the magic-bytes guard). Fetch the page as text, take the
        // first og:image and go on with the REAL image URL through the
        // existing guards (≤5 МБ, magic bytes, Storage upload, product_images).
        await throttle();
        // Research url-maps may carry DIRECT image URLs (cdn.27.ua,
        // images.prom.ua) — image-extension URLs skip the page step.
        let imageUrl: string | null = /\.(jpe?g|png|webp)(?:[?#]|$)/i.test(url) ? url : null;
        if (imageUrl === null) {
          let html: string;
          try {
            html = await fetchPage(url);
          } catch (err) {
            sStats.failed += 1;
            failedCodes.add(pos.item.code);
            log(
              `[run] ${source}: ${pos.item.code} сбой скачивания страницы ${url}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          imageUrl = extractOgImage(html, url);
        }
        if (imageUrl === null) {
          sStats.failed += 1;
          failedCodes.add(pos.item.code);
          log(`[run] ${source}: ${pos.item.code} og:image не найден на странице (софт-404?) — ${url}`);
          continue;
        }
        if (!/^https?:\/\//i.test(imageUrl)) {
          sStats.failed += 1;
          failedCodes.add(pos.item.code);
          log(
            `[run] ${source}: ${pos.item.code} og:image не http(s), скачивание отменено ` +
              `(${imageUrl.slice(0, 80)}) — ${url}`,
          );
          continue;
        }
        await throttle();
        let bytes: Uint8Array;
        try {
          bytes = await fetchImage(imageUrl);
        } catch (err) {
          sStats.failed += 1;
          failedCodes.add(pos.item.code);
          log(
            `[run] ${source}: ${pos.item.code} сбой скачивания картинки ${imageUrl}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          sStats.failed += 1;
          failedCodes.add(pos.item.code);
          log(
            `[run] ${source}: ${pos.item.code} файл ${bytes.byteLength} байт превышает лимит ` +
              `${MAX_IMAGE_BYTES} (5 МБ) — ${imageUrl}`,
          );
          continue;
        }
        const mime = detectImageMime(bytes);
        if (mime === null) {
          sStats.failed += 1;
          failedCodes.add(pos.item.code);
          log(`[run] ${source}: ${pos.item.code} не jpeg/png/webp по magic bytes — ${imageUrl}`);
          continue;
        }
        const safeName = sanitizeUploadFileName(urlBasename(imageUrl), mime);
        if (safeName === null) {
          // Defensive: mime is always whitelisted here, so this is unreachable.
          sStats.failed += 1;
          failedCodes.add(pos.item.code);
          continue;
        }
        const storagePath = `${pos.product.sku}/${safeName}`;
        if (pairExists(existingPairs, pos.product.id, storagePath)) {
          pos.open = false; // partial previous run: DB row exists, nothing to do
          continue;
        }
        if (!options.dry) {
          const uploadResult =
            deps.uploadObject !== undefined
              ? await deps.uploadObject(storagePath, bytes, mime)
              : await uploadViaStorage(client, storagePath, bytes, mime);
          if (uploadResult.error !== null && !/already exists/i.test(uploadResult.error.message)) {
            sStats.failed += 1;
            failedCodes.add(pos.item.code);
            log(
              `[run] ${source}: ${pos.item.code} сбой загрузки в Storage ${storagePath}: ` +
                `${uploadResult.error.message}`,
            );
            continue;
          }
          // "already exists" in Storage (orphan object of a crashed run):
          // the DB pair is missing, so the insert below reconciles the state.
        }
        const row: ProductImageInsert = {
          product_id: pos.product.id,
          image_url: storagePath,
          is_main: true,
          sort_order: 0,
        };
        if (options.dry) {
          sStats.downloaded += 1;
        } else {
          const outcome = await insertImageRow(client, row);
          if (outcome === 'duplicate') {
            sStats.noop23505 += 1;
            log(`[run] ${source}: ${pos.item.code} дубликат product_images — no-op (${storagePath})`);
          } else {
            rememberPair(existingPairs, row.product_id, row.image_url);
            sStats.downloaded += 1;
          }
        }
        pos.open = false;
      }
    }
  }

  // ---- report ----
  const noPhotoCodes = positions.filter((p) => p.open).map((p) => p.item.code);
  const downloadFailedCodes = [...failedCodes].filter(
    (code) => !positions.some((p) => p.item.code === code && !p.open),
  );

  log(
    `[run] items=${items.length}, products(wc-*)=${productsBySku.size}, ` +
      `уже с фото=${alreadyHadPhotos}, без товара=${noProduct}`,
  );
  for (const source of sources) {
    const s = stats[source] as SourceRunStats;
    log(
      `[run] ${source}: matched=${s.matched} downloaded=${s.downloaded} hotlinked=${s.hotlinked} ` +
        `failed=${s.failed} noop23505=${s.noop23505}`,
    );
  }
  if (downloadFailedCodes.length > 0) {
    log(
      `[run] сбой скачивания: ${downloadFailedCodes.length} ` +
        `(первые 20: ${downloadFailedCodes.slice(0, 20).join(', ')})`,
    );
  }
  log(`[run] без фото (для съёмки): ${noPhotoCodes.length}`);
  if (noPhotoCodes.length > 0) {
    log(`[run]   первые 20: ${noPhotoCodes.slice(0, 20).join(', ')}`);
  }
  if (noProductCodes.length > 0) {
    log(
      `[run] без товара wc-* (пропущено): ${noProductCodes.length} ` +
        `(первые 20: ${noProductCodes.slice(0, 20).join(', ')})`,
    );
  }
  if (options.dry) log('[run] dry-run: записей в БД/Storage нет.');

  const insertedRows = sources.reduce((sum, s) => {
    const sStats = stats[s] as SourceRunStats;
    return sum + sStats.downloaded + sStats.hotlinked;
  }, 0);

  return {
    items: items.length,
    matchedProducts: positions.length,
    noProduct,
    alreadyHadPhotos,
    insertedRows,
    downloadFailedCodes,
    noPhotoCodes,
    bySource: stats,
  };
}

// ---------------------------------------------------------------------------
// --specs: characteristics import from slav product pages (orchestrator GO)
// ---------------------------------------------------------------------------

export interface SpecsOptions {
  /** JSON file of stock positions (array of {code,name,article}), as --run. */
  itemsPath: string;
  cacheDir: string;
  /** Everything except the products.specifications UPDATE (pre-flight). */
  dry: boolean;
  /** Research-agent maps {1C code -> page URL}; overrides the index match.
   * Same origin validation as --run; only slav entries participate. */
  urlMapFiles?: string[];
}

export interface SpecsRunTotals {
  items: number;
  /** wc-* products in the DB domain (yugcontract_id IS NULL, sku LIKE 'wc-%'). */
  productsWc: number;
  /** Items positioned onto a wc-* product with a slav page URL. */
  matched: number;
  /** Page fetch failures (per-position, never fatal). */
  failed: number;
  /** Pages with ZERO parsed characteristics — product deliberately NOT touched. */
  emptySpecs: number;
  /** products.specifications UPDATEs (dry: would-write counter). */
  updated: number;
  /** Items whose derived sku has no wc-* product row (skipped). */
  noProduct: number;
  /** Items with no slav match in the index cache / url-map (skipped). */
  noMatch: number;
}

/**
 * Characteristics import (--specs): for wc-* products whose codes match the
 * slav index (data/photo-cache/slav.json; --url-map overrides per code),
 * fetch the slav page (30s timeout, 200ms throttle — shared fetchText seam),
 * parse the spec table + room chips (parseSlavCharacteristics) and write
 * products.specifications (jsonb — the JS array is passed as the column
 * value; Postgres stores it as a jsonb array of {name,value}).
 *
 * РЕШЕНИЕ владельца (2026-09-10): specifications у wc-* товаров
 * ПЕРЕЗАПИСЫВАЕТСЯ slav-версией без diff — wc-* импортированы этим
 * пайплайном и specifications из другой системы не имеют; товары вне домена
 * недостижимы по построению (readWallpaperProducts: yugcontract_id IS NULL
 * AND sku LIKE 'wc-%'). Товар без распарсенных характеристик не трогается.
 *
 * Fetch failures are per-position and non-fatal; a DB UPDATE error stops the
 * run (a re-run is the recovery path: writes are keyed by product id and
 * idempotent — the same slav payload is rewritten).
 */
export async function runSpecs(options: SpecsOptions, deps: CliDeps = {}): Promise<SpecsRunTotals> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const fetchText = deps.fetchText ?? fetchSitemapText;
  const throttleGap = deps.throttleMs ?? THROTTLE_MS;

  // ---- items (same loader/validation as --plan/--run) ----
  const items = loadItems(options.itemsPath);

  // ---- explicit URL maps: same origin validation as --run ----
  const slavExplicit = new Map<string, string>();
  for (const mapFile of options.urlMapFiles ?? []) {
    const map = JSON.parse(readFileSync(mapFile, 'utf8')) as Record<string, string>;
    for (const [code, url] of Object.entries(map)) {
      const src = sourceFromUrl(url);
      if (src === null) {
        throw new Error(`[specs] ${mapFile}: неопознанный источник у ${code}: ${url}`);
      }
      if (src === 'slav') slavExplicit.set(code, url);
    }
  }

  // ---- slav index cache (fail-closed pre-flight, shared with --run) ----
  const slavUrls = readIndexCache(options.cacheDir, 'slav', '[specs]');

  // ---- DB: wc-* products (read-only domain scope) ----
  const client = deps.client ?? (await createServiceClient());
  const productsBySku = await readWallpaperProducts(client);

  const totals: SpecsRunTotals = {
    items: items.length,
    productsWc: productsBySku.size,
    matched: 0,
    failed: 0,
    emptySpecs: 0,
    updated: 0,
    noProduct: 0,
    noMatch: 0,
  };

  let lastNetworkAt = 0;
  const throttle = async (): Promise<void> => {
    if (throttleGap <= 0) return;
    const nowMs = Date.now();
    if (lastNetworkAt + throttleGap > nowMs) {
      await sleep(lastNetworkAt + throttleGap - nowMs);
    }
    lastNetworkAt = Date.now();
  };

  log(
    `[specs] ${options.dry ? 'DRY (без записей)' : 'WRITE'} items=${items.length} ` +
      `products(wc-*)=${productsBySku.size}`,
  );

  const processedProducts = new Set<string>();
  for (const item of items) {
    const product = productsBySku.get(wallpaperSkuForItem(item));
    if (product === undefined) {
      totals.noProduct += 1;
      continue;
    }
    if (processedProducts.has(product.id)) continue; // дубликат артикула в items
    processedProducts.add(product.id);
    const url = slavExplicit.get(item.code) ?? matchSourceByUrl(slavUrls, articleTokensForItem(item));
    if (url === null) {
      totals.noMatch += 1;
      continue;
    }
    totals.matched += 1;

    await throttle();
    let html: string;
    try {
      html = await fetchText(url);
    } catch (err) {
      totals.failed += 1;
      log(
        `[specs] ${item.code} сбой скачивания страницы ${url}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const specs = parseSlavCharacteristics(html);
    if (specs.length === 0) {
      totals.emptySpecs += 1;
      log(`[specs] ${item.code}: характеристик на странице нет — товар не тронут (${url})`);
      continue;
    }
    if (options.dry) {
      totals.updated += 1; // would-write counter
      continue;
    }
    const { error } = await client
      .from('products')
      .update({ specifications: specs })
      .eq('id', product.id);
    if (error !== null) {
      throw new Error(
        `products.specifications update (id=${product.id}, sku=${product.sku}): ${error.message}`,
      );
    }
    totals.updated += 1;
  }

  log(
    `[specs] matched=${totals.matched}, failed=${totals.failed}, ` +
      `без характеристик=${totals.emptySpecs}, updated=${totals.updated}, ` +
      `без товара=${totals.noProduct}, без матча=${totals.noMatch}` +
      (options.dry ? ' (dry-run: записей нет)' : ''),
  );
  return totals;
}

export interface CliDeps {
  /** Network seam (tests inject a stub; default = real fetch). */
  fetchText?: (url: string) => Promise<string>;
  /** Product-page download seam of the non-slav copy branch (tests inject a
   * stub; default = real fetch with the HTML accept header). */
  fetchPageText?: (url: string) => Promise<string>;
  /** Image download seam (tests inject a stub; default = real fetch). */
  fetchImage?: (url: string) => Promise<Uint8Array>;
  /** Supabase seam (tests inject a fake; default = service-role from env). */
  client?: SupabaseClient;
  /** Storage upload seam (tests inject a stub; default = client.storage). */
  uploadObject?: (
    storagePath: string,
    bytes: Uint8Array,
    contentType: string,
  ) => Promise<{ error: { message: string } | null }>;
  /** Politeness gap override (tests pass 0; default THROTTLE_MS). */
  throttleMs?: number;
  cacheDir?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

async function indexAction(
  source: PhotoSource,
  cacheDir: string,
  deps: CliDeps,
  log: (line: string) => void,
): Promise<void> {
  const fetchText = deps.fetchText ?? fetchSitemapText;
  const now = deps.now ?? (() => new Date());
  log(`[index] ${source}: fetching ${SOURCE_SITEMAPS[source].length} sitemap entry point(s)...`);
  const { urls: rawUrls, sitemapUrls } = await fetchSourceIndex(source, fetchText, log);
  const urls = dedupe(rawUrls);
  const payload = {
    source,
    indexedAt: now().toISOString(),
    sitemapUrls,
    urlCount: urls.length,
    urls,
  };
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${source}.json`);
  writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`);
  log(`[index] ${source}: ${urls.length} urls -> ${cachePath} (from ${sitemapUrls.length} sitemap doc(s))`);
}

function planAction(
  args: CliArgs & { action: 'plan'; items: string },
  cacheDir: string,
  log: (line: string) => void,
): void {
  const items = loadItems(args.items);
  const sources: PhotoSource[] = args.source ? [args.source] : [...SOURCE_PRIORITY];
  log(`[plan] items=${items.length} sources=${sources.join(',')}`);

  const caches: Partial<Record<PhotoSource, string[]>> = {};
  for (const source of sources) {
    const cachePath = path.join(cacheDir, `${source}.json`);
    if (!existsSync(cachePath)) {
      log(`[plan] ${source}: no cache (${cachePath}) — run --index ${source} first`);
      continue;
    }
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { urls?: unknown };
    const urls = Array.isArray(parsed.urls)
      ? parsed.urls.filter((u): u is string => typeof u === 'string')
      : [];
    caches[source] = urls;
  }

  const covs = planPhotoCoverage(items, caches, articleTokensForItem).filter((cov) =>
    sources.includes(cov.source),
  );
  for (const cov of covs) {
    log(
      `[plan] ${cov.source}: index=${cov.indexUrls} urls, covered=${cov.matchedItems}/${items.length}, matchedUrls=${cov.matchedUrls}`,
    );
    for (const sample of cov.samples) {
      log(`[plan]   sample ${sample.code} -> ${sample.url}`);
    }
  }

  const covered = unionCoveredCodes(covs);
  const uncovered = items.filter((item) => !covered.has(item.code));
  log(`[plan] total: covered-by-any=${covered.size}/${items.length}, uncovered=${uncovered.length}`);
  if (uncovered.length > 0) {
    const codes = uncovered.slice(0, 20).map((item) => item.code).join(', ');
    log(`[plan] uncovered codes (first 20): ${codes}`);
  }
}

/** Entry point; returns a process exit code. Errors propagate to the caller. */
export async function runPhotosCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const args = parseArgs(argv);
  const cacheDir = deps.cacheDir ?? args.cacheDir;

  switch (args.action) {
    case 'index':
      await indexAction(args.source as PhotoSource, cacheDir, deps, log);
      return 0;
    case 'plan':
      planAction(args as CliArgs & { action: 'plan'; items: string }, cacheDir, log);
      return 0;
    case 'run': {
      await run(
        {
          itemsPath: args.items as string,
          sources: args.sources ?? [...SOURCE_PRIORITY],
          cacheDir,
          dry: args.dry,
          urlMapFiles: args.urlMapFiles,
        },
        deps,
      );
      // The report IS the product (same contract as --plan): exit 0 even when
      // some positions lack photos — the owner reads the checklist.
      return 0;
    }
    case 'specs': {
      await runSpecs(
        {
          itemsPath: args.items as string,
          cacheDir,
          dry: args.dry,
          urlMapFiles: args.urlMapFiles,
        },
        deps,
      );
      // Same reporting contract: exit 0 unless the run threw (per-position
      // fetch failures land in the totals, not the exit code).
      return 0;
    }
  }
}

// Direct execution guard: tests import this module without side effects.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runPhotosCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
