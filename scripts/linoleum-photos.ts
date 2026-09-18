#!/usr/bin/env node
/**
 * Лінолеум PHOTO SEED — CLI (задача L8).
 *
 * Призначення: завантажити верифіковані оркестратором фото ДИЗАЙНІВ
 * (data/linoleum-photos.json — файл у gitignored data/, НЕ в гіті) у Storage
 * bucket product_images і прив'язати до ln-* товарів у product_images.
 * Фото ОДНЕ на дизайн — усі width-картки дизайну (name = `{design} {width} м`,
 * app/lib/linoleum/import-plan.ts:linoleumCardName) ділять спільну картинку.
 *
 * Режими:
 *   node scripts/linoleum-photos.ts --plan [--photos <photos.json>]
 *       Dry-run: прочитати та проваліднувати seed-JSON, надрукувати що БУДЕ
 *       зроблено (шлях у Storage, public URL, правило прив'язки). 0 записів,
 *       клієнт БД не створюється.
 *   node scripts/linoleum-photos.ts --run [--photos <photos.json>]
 *       Виконання (пише Storage + product_images — GO власника/оркестратора):
 *       для кожного дизайну (a) джерело фото — РІВНО ОДНЕ з:
 *         imageUrl (fetch, 30с таймаут, content-type image/*) або localPath
 *         (шлях від кореня репо, readFileSync; взаємовиключні — валідація в
 *         loadPhotosFile, ".." та абсолютні шляхи відкидаються);
 *       далі спільні гарди: ≤5 МБ, mime за magic bytes (localPath не має
 *       HTTP-заголовків — MIME лише за байтами); (b) залити в
 *       product_images як `linoleum/<slug>.<ext>` (slug через
 *       sanitizeUploadFileName з upload-filename — extension за whitelist
 *       MIME); (c) знайти всі ln-* товари (sku LIKE 'ln-%'), чиє name
 *       ПОЧИНАЄТЬСЯ з design-рядка, і для кожного INSERT product_images
 *       {product_id, image_url: <ВІДНОСНИЙ шлях>, is_main, sort_order: 0}.
 *       Ідемпотентність: наявна пара (product_id, image_url) пропускається
 *       (select перед insert + 23505 -> no-op); is_main=true лише якщо в
 *       товара ще немає main-рядка, інакше false; існуючі рядки НІКОЛИ не
 *       UPDATE-яться (main-прапор не перетирається — у скрипті немає
 *       жодного .update()). Storage 'already exists' (обʼєкт попереднього
 *       запуску) толерується — DB-пара нижче відновлює стан.
 *       Помилки мережі/CDN — per-design (інші дизайни продовжують), зведення
 *       в кінці; exit 1, якщо ≥1 дизайн провалився.
 *
 * У product_images пишеться ВІДНОСНИЙ шлях обʼєкта — патерн
 * scripts/wallpaper-photos.ts (copy-гілка) та admin-images route;
 * getPublicImageUrl використовується для логу/--plan, а НЕ для запису.
 *
 * Запуск --run ПРОТИ живої БД до імпорту ln-* товарів безглуздий (0 матчів)
 * і створює обʼєкти в прод-Storage — спершу імпорт товарів.
 *
 * Service-role клієнт будуйсться ліниво лише в --run з .env.local / shell env
 * (persistSession: false — патерн scripts/wallpaper-import.ts).
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { SupabaseClient } from '@supabase/supabase-js';

import { LINOLEUM_SKU_LIKE } from '../app/lib/domains.ts';
import { getPublicImageUrl } from '../app/lib/supabase-storage.ts';
import { detectImageMime } from '../app/lib/wallpapers/photo-sources.ts';
import { IMAGE_EXT_BY_MIME, sanitizeUploadFileName } from '../app/lib/upload-filename.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Seed-файл за замовчуванням (data/ — gitignored). */
export const DEFAULT_PHOTOS_PATH = path.join(root, 'data', 'linoleum-photos.json');

const FETCH_TIMEOUT_MS = 30_000;
/** Politeness delay between consecutive design downloads. */
export const THROTTLE_MS = 200;
/** PostgREST caps any single response at 1000 rows — read windows stay ≤1000. */
export const PAGE_SIZE = 1000;
/** Project invariant: ≤200 ids per `.in()` chunk (long GET URLs break PostgREST). */
export const PAIR_CHUNK_SIZE = 200;
/** Storage bucket limit (migration 025): larger images are rejected. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Public-read bucket; relative object paths are stored in product_images. */
export const STORAGE_BUCKET = 'product_images';
/** Object prefix for the linoleum domain inside the bucket. */
export const STORAGE_PREFIX = 'linoleum';

const USAGE = `Використання:
  node scripts/linoleum-photos.ts --plan [--photos <photos.json>]
  node scripts/linoleum-photos.ts --run [--photos <photos.json>]`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests/linoleum-photos.test.ts)
// ---------------------------------------------------------------------------

export interface DesignPhotoBase {
  design: string;
  sourcePage: string;
}

/** Джерело — http(s) URL (fetch). */
export interface UrlDesignPhoto extends DesignPhotoBase {
  imageUrl: string;
  localPath?: undefined;
}

/** Джерело — локальний файл (шлях від кореня репо, readFileSync). */
export interface LocalDesignPhoto extends DesignPhotoBase {
  imageUrl?: undefined;
  localPath: string;
}

/** Рівно одне джерело на запис: imageUrl XOR localPath (валідація в loadPhotosFile). */
export type DesignPhoto = UrlDesignPhoto | LocalDesignPhoto;

/**
 * Resolves a repo-root-relative `localPath` to an absolute path.
 * Rejects traversal (".." segments) and absolute paths — a seed record can
 * only point INSIDE the repository. Pure (no I/O); throws with a message
 * the caller may wrap with photos[i] context.
 */
export function resolveLocalPhotoPath(baseDir: string, localPath: string): string {
  if (path.isAbsolute(localPath)) {
    throw new Error(`"localPath" має бути відносним шляхом від кореня репо: ${localPath}`);
  }
  if (localPath.split(/[\\/]+/).includes('..')) {
    throw new Error(`"localPath" не може виходити за корінь репо (".."): ${localPath}`);
  }
  return path.join(baseDir, localPath);
}

/** Strict whitelist parse of the seed JSON ({photos:[{design,imageUrl|localPath,sourcePage}]}). */
export function loadPhotosFile(photosPath: string): DesignPhoto[] {
  let raw: string;
  try {
    raw = readFileSync(photosPath, 'utf8');
  } catch {
    throw new Error(`не вдалося прочитати --photos файл: ${photosPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--photos файл не JSON (${photosPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--photos файл має бути обʼєктом {photos:[...]}}: ${photosPath}`);
  }
  const photos = (parsed as Record<string, unknown>)['photos'];
  if (!Array.isArray(photos)) {
    throw new Error(`--photos файл без масиву "photos": ${photosPath}`);
  }
  const seen = new Set<string>();
  const out: DesignPhoto[] = [];
  for (const [i, entry] of photos.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`photos[${i}]: має бути обʼєктом {design,imageUrl|localPath,sourcePage}`);
    }
    const rec = entry as Record<string, unknown>;
    const design = rec['design'];
    const imageUrl = rec['imageUrl'];
    const localPath = rec['localPath'];
    const sourcePage = rec['sourcePage'];
    if (typeof design !== 'string' || design.trim() === '') {
      throw new Error(`photos[${i}]: "design" має бути непорожнім рядком`);
    }
    if ((imageUrl === undefined) === (localPath === undefined)) {
      throw new Error(
        `photos[${i}] (${design}): має бути задано РІВНО ОДНЕ з "imageUrl" (http-URL) або "localPath"`,
      );
    }
    if (imageUrl !== undefined) {
      if (typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) {
        throw new Error(`photos[${i}] (${design}): "imageUrl" має бути http(s)-URL`);
      }
      if (typeof sourcePage !== 'string') {
        throw new Error(`photos[${i}] (${design}): "sourcePage" має бути рядком`);
      }
      out.push({ design, imageUrl, sourcePage });
    } else {
      if (typeof localPath !== 'string' || localPath.trim() === '') {
        throw new Error(`photos[${i}] (${design}): "localPath" має бути непорожнім рядком`);
      }
      try {
        resolveLocalPhotoPath(root, localPath);
      } catch (err) {
        throw new Error(
          `photos[${i}] (${design}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (typeof sourcePage !== 'string') {
        throw new Error(`photos[${i}] (${design}): "sourcePage" має бути рядком`);
      }
      out.push({ design, localPath, sourcePage });
    }
    if (seen.has(design)) {
      throw new Error(`photos[${i}]: дублікат дизайну "${design}"`);
    }
    seen.add(design);
  }
  return out;
}

/**
 * Sanitized object-name BASE for a design string (кирилиця відпадає, latin
 * лишається; extension додається окремо — за magic bytes). Reuse of the
 * admin-upload sanitizer: '.jpg' here is only a placeholder to extract the
 * safe base (IMAGE_EXT_BY_MIME['image/jpeg'] '.jpg').
 */
export function designSlug(design: string): string {
  const name = sanitizeUploadFileName(design, 'image/jpeg');
  return name === null ? 'image' : name.slice(0, -IMAGE_EXT_BY_MIME['image/jpeg']!.length);
}

/**
 * Relative Storage object path for a design photo:
 * `linoleum/<sanitized-slug>.<ext>`. Extension comes from the magic-byte
 * MIME (never from the source URL). Unknown MIME -> null (caller rejects).
 */
export function storagePathForDesign(design: string, mime: string): string | null {
  const ext = IMAGE_EXT_BY_MIME[mime];
  if (ext === undefined) return null;
  return `${STORAGE_PREFIX}/${designSlug(design)}${ext}`;
}

/**
 * Prefix matcher: ln-* products whose name starts with the design string
 * (card name = `{design} {width} м` — exact case prefix, ширини списка
 * не потрібні). Порядок вводу зберігається.
 */
export function matchDesignProducts(
  design: string,
  products: readonly { id: string; name: string }[],
): { id: string; name: string }[] {
  return products.filter((p) => p.name.startsWith(design));
}

export interface ImageInsertRow {
  product_id: string;
  image_url: string;
  is_main: boolean;
}

export interface DesignAttachPlan {
  rows: ImageInsertRow[];
  /** Products whose (product_id, image_url) pair already exists — skipped. */
  skipped: number;
}

/**
 * Idempotent attach plan for one design:
 *   - existing (product_id, image_url) pair -> skipped (no row);
 *   - is_main=true only if the product has NO main row yet, else false —
 *     existing rows are never UPDATEd (the script contains no .update()).
 */
export function planDesignRows(
  imageUrl: string,
  products: readonly { id: string; name: string }[],
  design: string,
  pairs: ReadonlyMap<string, Set<string>>,
  mains: ReadonlySet<string>,
): DesignAttachPlan {
  const matched = matchDesignProducts(design, products);
  const rows: ImageInsertRow[] = [];
  let skipped = 0;
  for (const p of matched) {
    if (pairs.get(p.id)?.has(imageUrl) === true) {
      skipped += 1;
      continue;
    }
    rows.push({ product_id: p.id, image_url: imageUrl, is_main: !mains.has(p.id) });
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface LinoleumPhotosArgs {
  mode: 'plan' | 'run';
  photos?: string;
}

export function parseArgs(argv: readonly string[]): LinoleumPhotosArgs {
  let mode: LinoleumPhotosArgs['mode'] | null = null;
  let photos: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    switch (arg) {
      case '--plan':
      case '--run':
        if (mode !== null) {
          throw new Error(`лише один режим дозволений, є і --plan, і --run\n${USAGE}`);
        }
        mode = arg === '--plan' ? 'plan' : 'run';
        break;
      case '--photos': {
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error(`--photos потребує шляху до файлу\n${USAGE}`);
        }
        photos = value;
        i += 1;
        break;
      }
      default:
        throw new Error(`невідомий аргумент "${arg}"\n${USAGE}`);
    }
  }
  if (mode === null) throw new Error(`потрібен --plan або --run\n${USAGE}`);
  return photos === undefined ? { mode } : { mode, photos };
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
  name: unknown;
}

/** The linoleum domain only: sku LIKE 'ln-%' (LINOLEUM_SKU_LIKE). */
async function readLinoleumProducts(
  client: SupabaseClient,
): Promise<{ id: string; sku: string; name: string }[]> {
  const rows = await readAllPages<ProductDbRow>(
    (from) =>
      client
        .from('products')
        .select('id,sku,name')
        .like('sku', LINOLEUM_SKU_LIKE)
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<ProductDbRow[]>(),
    'products (ln-*)',
  );
  const out: { id: string; sku: string; name: string }[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string') continue;
    if (typeof row.name !== 'string' || row.name === '') continue;
    out.push({ id: row.id, sku: typeof row.sku === 'string' ? row.sku : '', name: row.name });
  }
  return out;
}

interface ImageRowDbRow {
  product_id: unknown;
  image_url: unknown;
  is_main: unknown;
}

/** Existing product_images rows for the ln-* domain: `.in` chunks ≤200 ids,
 * each chunk read in PAGE_SIZE pages with `.order('product_id')`. */
async function readExistingImages(
  client: SupabaseClient,
  productIds: readonly string[],
): Promise<{ pairs: Map<string, Set<string>>; mains: Set<string> }> {
  const pairs = new Map<string, Set<string>>();
  const mains = new Set<string>();
  for (let i = 0; i < productIds.length; i += PAIR_CHUNK_SIZE) {
    const group = productIds.slice(i, i + PAIR_CHUNK_SIZE);
    const rows = await readAllPages<ImageRowDbRow>(
      (from) =>
        client
          .from('product_images')
          .select('product_id,image_url,is_main')
          .in('product_id', group)
          .order('product_id')
          .range(from, from + PAGE_SIZE - 1)
          .returns<ImageRowDbRow[]>(),
      'product_images',
    );
    for (const row of rows) {
      if (typeof row.product_id !== 'string' || typeof row.image_url !== 'string') continue;
      const set = pairs.get(row.product_id);
      if (set === undefined) pairs.set(row.product_id, new Set([row.image_url]));
      else set.add(row.image_url);
      if (row.is_main === true) mains.add(row.product_id);
    }
  }
  return { pairs, mains };
}

function isUniqueViolation(error: { code?: string; message: string }): boolean {
  return error.code === '23505' || /duplicate key|unique constraint/i.test(error.message);
}

/** Single-row INSERT so a 23505 (unique pair race) stays a per-row no-op.
 * Any other DB error throws — a re-run is the recovery path (diff-aware ->
 * only missing rows are written). */
async function insertImageRow(
  client: SupabaseClient,
  row: ImageInsertRow & { sort_order: number },
): Promise<'inserted' | 'duplicate'> {
  const { error } = await client.from('product_images').insert(row);
  if (error === null) return 'inserted';
  if (isUniqueViolation(error)) return 'duplicate';
  throw new Error(
    `product_images insert (product_id=${row.product_id}, url=${row.image_url}): ${error.message}`,
  );
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
// --plan (read-only: 0 записів, клієнт БД не створюється)
// ---------------------------------------------------------------------------

export function planPhotos(photosPath: string, log: (line: string) => void): void {
  loadEnvLocal();
  const photos = loadPhotosFile(photosPath);
  log(`[plan] designs=${photos.length} (0 записів — plan)`);
  for (const [i, photo] of photos.entries()) {
    const slugPath = storagePathForDesign(photo.design, 'image/jpeg') ?? STORAGE_PREFIX;
    const publicUrl = getPublicImageUrl(slugPath);
    log(`[plan] ${i + 1}/${photos.length} ${photo.design}`);
    if (photo.localPath !== undefined) {
      // Валідація --plan: локальний файл має існувати ще ДО --run.
      const abs = resolveLocalPhotoPath(root, photo.localPath);
      let stat: { isFile: () => boolean; size: number };
      try {
        stat = statSync(abs);
      } catch {
        throw new Error(`--plan: локальний файл не знайдено: ${photo.localPath} (${abs})`);
      }
      if (!stat.isFile()) {
        throw new Error(`--plan: localPath не є файлом: ${photo.localPath} (${abs})`);
      }
      log(`[plan]   localPath: ${photo.localPath} (${stat.size} байт, існує)`);
    } else {
      log(`[plan]   imageUrl: ${photo.imageUrl}`);
    }
    log(`[plan]   sourcePage: ${photo.sourcePage}`);
    log(
      `[plan]   Storage: ${STORAGE_BUCKET}/${slugPath} ` +
        '(розширення — за magic bytes: .jpg/.png/.webp)',
    );
    log(
      `[plan]   public URL: ${publicUrl ?? '(NEXT_PUBLIC_SUPABASE_URL не задано — нерозрішено)'}`,
    );
    log(
      `[plan]   прив'язка: products WHERE sku LIKE '${LINOLEUM_SKU_LIKE}' AND name STARTS WITH ` +
        `"${photo.design}" -> product_images (is_main лише якщо main ще немає)`,
    );
  }
  log('[plan] total: записів 0 (plan). Для виконання: --run (GO оркестратора).');
}

// ---------------------------------------------------------------------------
// --run executor (GO оркестратора)
// ---------------------------------------------------------------------------

export interface DesignRunStat {
  design: string;
  matchedProducts: number;
  /** product_images rows written (idempotent re-run: 0). */
  attached: number;
  /** Existing (product_id, image_url) pairs skipped. */
  skipped: number;
}

export interface DesignFailure {
  design: string;
  reason: string;
}

export interface RunTotals {
  designs: DesignRunStat[];
  failed: DesignFailure[];
}

export interface FetchedImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface CliDeps {
  /** Image download seam (tests inject a stub; default = real fetch). */
  fetchImage?: (url: string) => Promise<FetchedImage>;
  /** Supabase seam (tests inject a fake; default = service-role from env). */
  client?: SupabaseClient;
  /** Politeness gap override (tests pass 0; default THROTTLE_MS). */
  throttleMs?: number;
  log?: (line: string) => void;
}

export const USER_AGENT =
  'Mozilla/5.0 (compatible; MyShopLinoleumPhotos/1.0; photo-seed bot; +https://towary-dla-domu.com)';

/** Image download: UA header, 30s hard timeout, non-2xx -> Error. */
export async function fetchImageWithContentType(url: string): Promise<FetchedImage> {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8,*/*;q=0.5',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? '',
  };
}

/**
 * Local-file read for `localPath` seed records (задача L10). No HTTP
 * headers here — the MIME comes from magic bytes only (detectImageMime),
 * extension from the MIME whitelist.
 */
export function readLocalImage(absPath: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absPath);
  } catch (err) {
    throw new Error(
      `не вдалося прочитати локальний файл ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Photo seed. Idempotent: existing (product_id, image_url) pairs are
 * skipped, existing rows never UPDATEd — a full re-run writes nothing new.
 * Per-design failures (network/CDN/guards) are collected in totals.failed;
 * other designs continue.
 */
export async function runPhotos(
  options: { photosPath: string },
  deps: CliDeps = {},
): Promise<RunTotals> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const fetchImage = deps.fetchImage ?? fetchImageWithContentType;
  const throttleGap = deps.throttleMs ?? THROTTLE_MS;

  const photos = loadPhotosFile(options.photosPath);
  const client = deps.client ?? (await createServiceClient());

  const products = await readLinoleumProducts(client);
  const { pairs, mains } = await readExistingImages(
    client,
    products.map((p) => p.id),
  );

  log(
    `[run] designs=${photos.length} products(ln-*)=${products.length} ` +
      `${products.length === 0 ? '— ln-* товарів немає: спершу імпорт товарів (записів не буде)' : ''}`,
  );

  const designs: DesignRunStat[] = [];
  const failed: DesignFailure[] = [];
  let lastNetworkAt = 0;
  const throttle = async (): Promise<void> => {
    if (throttleGap <= 0) return;
    const nowMs = Date.now();
    if (lastNetworkAt + throttleGap > nowMs) {
      await sleep(lastNetworkAt + throttleGap - nowMs);
    }
    lastNetworkAt = Date.now();
  };

  for (const photo of photos) {
    const stat: DesignRunStat = {
      design: photo.design,
      matchedProducts: 0,
      attached: 0,
      skipped: 0,
    };
    try {
      const matched = matchDesignProducts(photo.design, products);
      stat.matchedProducts = matched.length;

      let bytes: Uint8Array;
      let source: string;
      if (photo.localPath !== undefined) {
        // Локальний файл: без мережі (throttle не потрібен), HTTP-заголовків
        // немає — MIME визначиться нижче лише за magic bytes.
        bytes = readLocalImage(resolveLocalPhotoPath(root, photo.localPath));
        source = photo.localPath;
      } else {
        await throttle();
        const fetched = await fetchImage(photo.imageUrl);
        if (!fetched.contentType.startsWith('image/')) {
          throw new Error(
            `content-type "${fetched.contentType}" не image/* — ${photo.imageUrl}`,
          );
        }
        bytes = fetched.bytes;
        source = photo.imageUrl;
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(
          `файл ${bytes.byteLength} байт перевищує ліміт ${MAX_IMAGE_BYTES} (5 МБ) — ${source}`,
        );
      }
      const mime = detectImageMime(bytes);
      if (mime === null) {
        throw new Error(`не jpeg/png/webp за magic bytes — ${source}`);
      }
      const storagePath = storagePathForDesign(photo.design, mime);
      if (storagePath === null) {
        // Defensive: mime comes from detectImageMime, always whitelisted.
        throw new Error(`неочікуваний MIME ${mime}`);
      }

      if (matched.length > 0) {
        const uploadResult = await uploadViaStorage(client, storagePath, bytes, mime);
        if (uploadResult.error !== null && !/already exists/i.test(uploadResult.error.message)) {
          throw new Error(`збій завантаження в Storage ${storagePath}: ${uploadResult.error.message}`);
        }
        log(`[run] Storage: ${STORAGE_BUCKET}/${storagePath} (${mime})`);
        log(`[run] public URL: ${getPublicImageUrl(storagePath) ?? '(нерозрішено)'}`);

        const plan = planDesignRows(storagePath, products, photo.design, pairs, mains);
        stat.skipped = plan.skipped;
        for (const row of plan.rows) {
          const outcome = await insertImageRow(client, { ...row, sort_order: 0 });
          if (outcome === 'duplicate') {
            stat.skipped += 1;
            continue;
          }
          const set = pairs.get(row.product_id);
          if (set === undefined) pairs.set(row.product_id, new Set([row.image_url]));
          else set.add(row.image_url);
          if (row.is_main) mains.add(row.product_id);
          stat.attached += 1;
        }
      } else {
        log(`[run] ${photo.design}: матчів серед ln-* немає — пропущено (0 записів)`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ design: photo.design, reason });
      log(`[run] ПОМИЛКА дизайну "${photo.design}": ${reason}`);
    }
    designs.push(stat);
  }

  log('[run] зведення:');
  for (const stat of designs) {
    log(
      `[run]   ${stat.design}: matched=${stat.matchedProducts} attached=${stat.attached} skipped=${stat.skipped}`,
    );
  }
  if (failed.length > 0) {
    log(`[run] провалено дизайнів: ${failed.length}:`);
    for (const f of failed) log(`[run]   ${f.design}: ${f.reason}`);
  }
  log(`[run] attached=${designs.reduce((s, d) => s + d.attached, 0)}, failed=${failed.length}`);

  return { designs, failed };
}

/** Entry point; returns a process exit code. Errors propagate to the caller. */
export async function runLinoleumPhotosCli(
  argv: readonly string[],
  deps: CliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const args = parseArgs(argv);
  const photosPath = args.photos ?? DEFAULT_PHOTOS_PATH;
  if (args.mode === 'plan') {
    planPhotos(photosPath, log);
    return 0;
  }
  const totals = await runPhotos({ photosPath }, deps);
  // Report IS the product, but a failed design means NO photo at all:
  // surface it in the exit code (loudly) for the orchestrating shell.
  return totals.failed.length === 0 ? 0 : 1;
}

// Direct execution guard: tests import this module without side effects.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runLinoleumPhotosCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
