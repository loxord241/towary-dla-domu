#!/usr/bin/env node
/**
 * Wallpapers PHOTO PIPELINE — CLI (plan Task 8, spec §4).
 *
 * Responsibilities of THIS task: sitemap INDEXING of photo sources,
 * article-token MATCHING and --plan coverage reports.
 *
 * Writing to DB/Storage (--run) is intentionally NOT implemented here —
 * it is wired by the orchestrator as a separate GO (see run()).
 *
 * Modes:
 *   node scripts/wallpaper-photos.ts --index <slav|epicentr|shpalery-ua|styleo|shpaleru>
 *       Download the source sitemap (fetch, 30s timeout, UA header, 200ms
 *       throttle) and cache the URL list to data/photo-cache/<source>.json.
 *   node scripts/wallpaper-photos.ts --plan --items <items.json> [--source <s>]
 *       Read cached indexes + a JSON file of stock positions
 *       (array of {code,name,article}) and print how many positions each
 *       source covers (strict token match, priority order). Read-only.
 *   node scripts/wallpaper-photos.ts --run [--source <s>]
 *       NOT IMPLEMENTED YET: throws NOT_IMPLEMENTED_WAITING_ORCHESTRATOR
 *       (slav -> hotlink URLs; others -> download -> Storage upload).
 *
 * NO DB / NO Storage access in this script at this stage (statically pinned
 * by tests/wallpaper-photo-sources.test.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseArticleTokens } from '../app/lib/wallpapers/parse.ts';
import {
  SOURCE_PRIORITY,
  SOURCE_SITEMAPS,
  extractSitemapUrls,
  isPhotoSource,
  normalizeArticleToken,
  planPhotoCoverage,
  unionCoveredCodes,
  type PhotoItem,
  type PhotoSource,
} from '../app/lib/wallpapers/photo-sources.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Default cache location (/data is gitignored). */
export const DEFAULT_CACHE_DIR = path.join(root, 'data', 'photo-cache');

const FETCH_TIMEOUT_MS = 30_000;
/** Politeness delay between consecutive sitemap fetches. */
export const THROTTLE_MS = 200;
/** Defensive cap on sitemap-index nesting expansion. */
const NESTED_SITEMAP_CAP = 20;

export const USER_AGENT =
  'Mozilla/5.0 (compatible; MyShopWallpaperPhotos/1.0; photo-index bot; +https://towary-dla-domu.com)';

const USAGE = `Usage:
  node scripts/wallpaper-photos.ts --index <slav|epicentr|shpalery-ua|styleo|shpaleru> [--cache-dir DIR]
  node scripts/wallpaper-photos.ts --plan --items <items.json> [--source <s>] [--cache-dir DIR]
  node scripts/wallpaper-photos.ts --run [--source <s>]   # NOT IMPLEMENTED (orchestrator GO)`;

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
  action: 'index' | 'plan' | 'run';
  source?: PhotoSource;
  items?: string;
  cacheDir: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const actions: string[] = [];
  let indexSource: string | null = null;
  let sourceFlag: string | null = null;
  let items: string | null = null;
  let cacheDir: string | null = null;

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
      case '--source': {
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error('--source requires a value\n' + USAGE);
        }
        sourceFlag = value;
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
      case '--cache-dir': {
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error('--cache-dir requires a directory path\n' + USAGE);
        }
        cacheDir = value;
        i += 1;
        break;
      }
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
    if (indexSource === null || !isPhotoSource(indexSource)) {
      throw new Error(
        `unknown source "${indexSource ?? ''}" (valid: ${SOURCE_PRIORITY.join('|')})`,
      );
    }
    return { action: 'index', source: indexSource, cacheDir: cacheDir ?? DEFAULT_CACHE_DIR };
  }

  let source: PhotoSource | undefined;
  if (sourceFlag !== null) {
    if (!isPhotoSource(sourceFlag)) {
      throw new Error(`unknown source "${sourceFlag}" (valid: ${SOURCE_PRIORITY.join('|')})`);
    }
    source = sourceFlag;
  }

  if (actions[0] === 'plan') {
    if (items === null) throw new Error('--plan requires --items <items.json>\n' + USAGE);
    return { action: 'plan', source, items, cacheDir: cacheDir ?? DEFAULT_CACHE_DIR };
  }

  return { action: 'run', source, cacheDir: cacheDir ?? DEFAULT_CACHE_DIR };
}

/**
 * The DB/Storage write phase. Deliberately a stub in this task: the
 * orchestrator wires it as a separate GO (hotlink for slav, download+upload
 * for the rest — plan Task 8 `--run` semantics).
 */
export async function run(): Promise<never> {
  throw new Error('NOT_IMPLEMENTED_WAITING_ORCHESTRATOR');
}

export interface CliDeps {
  /** Network seam (tests inject a stub; default = real fetch). */
  fetchText?: (url: string) => Promise<string>;
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
    case 'run':
      await run();
      return 1;
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
