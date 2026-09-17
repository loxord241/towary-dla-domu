#!/usr/bin/env node
/**
 * Лінолеум IMPORT — CLI executor (линолеум, батч 2; план L3, 2026-09-17).
 * Структурное зеркало scripts/wallpaper-import.ts со своим staging-контрактом.
 *
 * Читает staging `linoleum_stock` (миграция 052: append-only, колонки
 * code/name/width_m/price_sqm/qty_m/export_date; свежайшая строка на
 * (code,width) выигрывает) и сводит его с товарным доменом ln-* через
 * pure-планировщик app/lib/linoleum/import-plan.ts.
 *
 * Режимы:
 *   node scripts/linoleum-import.ts --plan
 *       Read-only: печатает staging-сводку + creates/updates/missing/noops,
 *       exits 0. НОЛЬ записей.
 *   node scripts/linoleum-import.ts --run
 *       Исполняет план батчами ≤200:
 *         - корневая категория «Лінолеум» (slug linoleum): создаётся, если
 *           отсутствует; slug с другой названием → АБОРТ (импортер не
 *           переименовывает; подкатегории придут позже с данными 1С);
 *         - creates → INSERT products (is_active false, currency 'UAH',
 *           specifications [Ціна за м², Ширина], availability согласован,
 *           price = грн/погонный метр) + product_categories junction +
 *           legacy products.category_id;
 *         - updates → построчный UPDATE только diff-полей (price /
 *           specifications / stock_quantity);
 *         - missing → stock_quantity = 0 (OOS), никогда DELETE;
 *         - каждое изменение стока → product_stock_history
 *           (reason '1c-sync', source '1c-linoleum').
 *   node scripts/linoleum-import.ts --publish
 *       Фото-гейт (единственный писатель is_active), SQL-интент
 *         UPDATE products SET is_active = true  WHERE sku LIKE 'ln-%' AND EXISTS
 *           (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id);
 *         UPDATE products SET is_active = false WHERE sku LIKE 'ln-%' AND NOT EXISTS (...);
 *       разрешён постраничным JS semi-join; печатает «опубліковано X, приховано Y».
 *
 * Restock-хук: ПОСЛЕ успешного --run (никогда в --plan/--publish) —
 * переиспользование notifyRestockRequests из scripts/wallpaper-import.ts
 * (хук доменно-нейтрален: читает restock_requests + products по id; импорт
 * вместо копии — единственная реализация хука в репо). Хук никогда не
 * валит импорт: ошибки логируются, exit остаётся 0.
 *
 * Инварианты (pinned tests/linoleum-import-cli.test.ts):
 *   - availability_status НИКОГДА не пишется на UPDATE (триггер миграции 040
 *     выводит его из stock_quantity); на INSERT пишется значение плана;
 *   - is_active пишется ТОЛЬКО --publish (два diff-aware батч-flip'а);
 *     sync вставляет новые строки невидимыми и флаг существующих не трогает;
 *   - НЕТ DELETE/rpc/upsert; план идемпотентен — упавший батч лечится
 *     повторным --run;
 *   - постраничные чтения: окна PAGE_SIZE = 1000 с `.order('id')`;
 *     DISTINCT-семантика staging (свежайшая строка на (code,width)) — в JS
 *     (prepareRows), не в SQL;
 *   - любая ошибка батча печатает номер батча и текст и останавливает прогон.
 *
 * Service-role клиент (паттерн app/lib/payment/reconciliation-scan.ts);
 * креды из .env.local / shell env, никогда не логируются.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  planLinoleumImport,
  planRootCategory,
  LINOLEUM_ROOT_CATEGORY,
  type ExistingCategoryRow,
  type ExistingProduct,
  type LinoleumPlan,
  type LinoleumPlanRow,
  type SpecificationEntry,
} from '../app/lib/linoleum/import-plan.ts';
import { LINOLEUM_WIDTHS_M, type LinoleumRow, type LinoleumWidthM } from '../app/lib/linoleum/parse.ts';
import { LINOLEUM_SKU_LIKE } from '../app/lib/domains.ts';
import { notifyRestockRequests } from './wallpaper-import.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** PostgREST caps any single response at 1000 rows — read windows stay ≤1000. */
export const PAGE_SIZE = 1000;
/** Project write-batch invariant: ≤200 ids/rows per INSERT/UPDATE group. */
export const BATCH_SIZE = 200;
/** product_stock_history.reason for the linoleum daily sync (как у шпалер). */
export const HISTORY_REASON = '1c-sync';
/** product_stock_history.source — помечает каждую stock-запись линолеума. */
export const HISTORY_SOURCE = '1c-linoleum';

const USAGE = `Використання:
  node scripts/linoleum-import.ts --plan      dry-run: друк плану, 0 записів
  node scripts/linoleum-import.ts --run       виконання плану батчами ≤200
  node scripts/linoleum-import.ts --publish   вітрина: активні лише позиції з фото`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests/linoleum-import-cli.test.ts)
// ---------------------------------------------------------------------------

/** A raw `linoleum_stock` row as read from staging (values defensive-typed). */
export interface RawStagingRow {
  code: unknown;
  name: unknown;
  width_m: unknown;
  price_sqm: unknown;
  qty_m: unknown;
  export_date: unknown;
}

export interface PrepareRowsResult {
  rows: LinoleumRow[];
  /** Rows dropped by the defensive validation (DB CHECKs make this rare). */
  skipped: number;
  /**
   * (code,width)-ключи, чья СВЕЖАЯ строка старше max export_date: ключ покинул
   * текущую выгрузку 1С → его товары сводятся планом в 0 (is_active не
   * трогается — территория --publish).
   */
  olderOnlyKeys: number;
  /** Max export_date across the staging rows (null when staging is empty). */
  latestExportDate: string | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const WIDTH_WHITELIST: ReadonlySet<number> = new Set<number>(LINOLEUM_WIDTHS_M);

/**
 * Distinct-on-JS over the paged staging read, narrowed to the LATEST export:
 * the freshest row per (code, width_m) key (max export_date; tie → later
 * input row — staging is append-only and a later ingest supersedes an
 * earlier one), then only keys whose freshest row carries the max
 * export_date survive into `rows` (mirrors the wallpaper «feed = latest
 * export» rule). Output preserves the first-appearance order of each key,
 * which keeps the planner deterministic.
 */
export function prepareRows(raw: readonly RawStagingRow[]): PrepareRowsResult {
  // `|`-ключ коллизионно-свободен: суффиксы ширин (|1.5,|2,|2.5,|3,|3.5,|4) не
  // вложены друг в друга, так что code1|w1 === code2|w2 ⇒ коды и ширины равны.
  const byKey = new Map<string, { row: LinoleumRow; exportDate: string }>();
  let skipped = 0;

  for (const src of raw) {
    const code = typeof src.code === 'string' ? src.code.trim() : '';
    const name = typeof src.name === 'string' ? src.name.trim() : '';
    const exportDate = typeof src.export_date === 'string' ? src.export_date.trim() : '';
    const width = toFiniteNumber(src.width_m);
    const price = toFiniteNumber(src.price_sqm);
    const qty = toFiniteNumber(src.qty_m);

    const valid =
      code !== '' &&
      name !== '' &&
      exportDate !== '' &&
      width !== null &&
      WIDTH_WHITELIST.has(width) &&
      price !== null &&
      price >= 0 &&
      qty !== null &&
      qty >= 0 &&
      Number.isInteger(qty);
    if (!valid) {
      skipped += 1;
      continue;
    }

    const row: LinoleumRow = {
      code,
      name,
      widthM: width as LinoleumWidthM,
      priceSqm: price,
      qtyM: qty,
    };
    const key = `${code}|${width}`;
    const prev = byKey.get(key);
    if (prev === undefined || exportDate >= prev.exportDate) {
      byKey.set(key, { row, exportDate });
    }
  }

  let latestExportDate: string | null = null;
  for (const entry of byKey.values()) {
    if (latestExportDate === null || entry.exportDate > latestExportDate) {
      latestExportDate = entry.exportDate;
    }
  }
  const rows: LinoleumRow[] = [];
  let olderOnlyKeys = 0;
  if (latestExportDate !== null) {
    for (const entry of byKey.values()) {
      if (entry.exportDate === latestExportDate) rows.push(entry.row);
      else olderOnlyKeys += 1;
    }
  }

  return { rows, skipped, olderOnlyKeys, latestExportDate };
}

/** Exact batch windows of `size` (≤ BATCH_SIZE at every call site). */
export function chunkRows<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface LinoleumImportCliArgs {
  mode: 'plan' | 'run' | 'publish';
}

/** Exactly ONE action flag must be present; mixing (or none) → usage.
 * No options exist: any extra `--flag` (e.g. a wallpaper-style --category-map)
 * is rejected — linoleum categories are the single root for now. */
export function parseArgs(argv: readonly string[]): LinoleumImportCliArgs | null {
  const modes: LinoleumImportCliArgs['mode'][] = [];
  for (const arg of argv) {
    if (arg === '--plan') modes.push('plan');
    else if (arg === '--run') modes.push('run');
    else if (arg === '--publish') modes.push('publish');
    else return null; // unknown option → usage
  }
  if (modes.length !== 1) return null; // neither or mixed → usage
  const mode = modes[0];
  if (mode === undefined) return null;
  return { mode };
}

/** specifications jsonb → canonical entry list ([] on any shape deviation). */
function toSpecList(value: unknown): SpecificationEntry[] {
  if (!Array.isArray(value)) return [];
  const out: SpecificationEntry[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const name = (entry as { name?: unknown }).name;
    const val = (entry as { value?: unknown }).value;
    if (typeof name === 'string' && typeof val === 'string') out.push({ name, value: val });
  }
  return out;
}

// ---------------------------------------------------------------------------
// env + DB readers (SELECT-only, paged, fresh builder per page)
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

type PageResult<T> = { data: T[] | null; error: { message: string } | null };
type PageFetcher<T> = (from: number) => PromiseLike<PageResult<T>>;

/** Deterministic multi-page read: contiguous PAGE_SIZE windows, `.order('id')`
 * tiebreaker at every call site (project pagination invariant). */
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

async function readStagingRaw(client: SupabaseClient): Promise<RawStagingRow[]> {
  return readAllPages<RawStagingRow>(
    (from) =>
      client
        .from('linoleum_stock')
        .select('code,name,width_m,price_sqm,qty_m,export_date')
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<RawStagingRow[]>(),
    'linoleum_stock'
  );
}

interface ExistingProductDbRow {
  id: unknown;
  sku: unknown;
  name: unknown;
  price: unknown;
  stock_quantity: unknown;
  is_active: unknown;
  specifications: unknown;
}

/** The linoleum domain only: sku LIKE 'ln-%' (домен = префикс, domains.ts). */
async function readExistingLinoleumProducts(
  client: SupabaseClient
): Promise<Map<string, ExistingProduct>> {
  const rows = await readAllPages<ExistingProductDbRow>(
    (from) =>
      client
        .from('products')
        .select('id,sku,name,price,stock_quantity,is_active,specifications')
        .like('sku', LINOLEUM_SKU_LIKE)
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<ExistingProductDbRow[]>(),
    'products (ln-*)'
  );
  const existing = new Map<string, ExistingProduct>();
  for (const r of rows) {
    const sku = typeof r.sku === 'string' ? r.sku.trim() : '';
    const price = toFiniteNumber(r.price);
    const stock = toFiniteNumber(r.stock_quantity);
    if (sku === '' || price === null || stock === null || typeof r.id !== 'string') {
      throw new Error(`існуючий ln-* товар з некоректними даними (sku=${String(r.sku)})`);
    }
    existing.set(sku, {
      id: r.id,
      sku,
      name: typeof r.name === 'string' ? r.name : '',
      price,
      stockQuantity: stock,
      isActive: r.is_active === true,
      specifications: toSpecList(r.specifications),
    });
  }
  return existing;
}

async function readCategories(client: SupabaseClient): Promise<ExistingCategoryRow[]> {
  const rows = await readAllPages<{ id: unknown; slug: unknown; name: unknown }>(
    (from) =>
      client
        .from('categories')
        .select('id,slug,name')
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<{ id: unknown; slug: unknown; name: unknown }[]>(),
    'categories'
  );
  const out: ExistingCategoryRow[] = [];
  for (const r of rows) {
    if (typeof r.id !== 'string' || typeof r.slug !== 'string' || typeof r.name !== 'string') {
      continue;
    }
    out.push({ id: r.id, slug: r.slug, name: r.name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// --plan printing (read-only)
// ---------------------------------------------------------------------------

interface PlanStats {
  rawCount: number;
  skipped: number;
  freshCount: number;
  existingCount: number;
  olderOnlyKeys: number;
  latestExportDate: string | null;
}

function printPlan(plan: LinoleumPlan, stats: PlanStats): void {
  console.log(
    `staging: ${stats.rawCount} сирих рядків → ${stats.freshCount} свіжих на (код,ширина) (пропущено ${stats.skipped})`
  );
  console.log(
    `фід = остання вивантаження ${stats.latestExportDate ?? '—'}; лише зі старих вивантажень (→ OOS): ${stats.olderOnlyKeys}`
  );
  console.log(`існуючих ln-* товарів: ${stats.existingCount}`);
  console.log(`creates: ${plan.creates.length}`);
  for (const c of plan.creates.slice(0, 10)) {
    const sqm = c.specifications.find((s) => s.name === 'Ціна за м²')?.value ?? '—';
    const width = c.specifications.find((s) => s.name === 'Ширина')?.value ?? '—';
    console.log(
      `  + ${c.sku} "${c.name}" price=${c.price} грн/пог.м (за м² ${sqm}, ширина ${width}) qty=${c.stockQuantity} ${c.availability}`
    );
  }
  console.log(`updates: ${plan.updates.length}`);
  for (const u of plan.updates.slice(0, 10)) {
    const parts: string[] = [];
    if (u.fields.price !== undefined) parts.push(`price→${u.fields.price}`);
    if (u.fields.specifications !== undefined) parts.push('specifications (Ціна за м²)');
    if (u.fields.stock_quantity !== undefined) {
      parts.push(`stock_quantity→${u.fields.stock_quantity}`);
    }
    console.log(`  ~ id=${u.id} ${parts.join(', ')}`);
  }
  console.log(`missing (OOS, stock_quantity=0): ${plan.missing.length}`);
  for (const m of plan.missing.slice(0, 10)) console.log(`  ! id=${m.id}`);
  console.log(`noops: ${plan.noops.length}`);
  for (const s of plan.noops.slice(0, 10)) console.log(`  = ${s}`);
  console.log(`conflicts: ${plan.conflicts.length}`);
  console.log('\n--plan: жодних записів.');
}

// ---------------------------------------------------------------------------
// entry point — the plan branch returns BEFORE applyPlan is ever reachable
// ---------------------------------------------------------------------------

export async function runImportCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    console.error(USAGE);
    return 1;
  }
  loadEnvLocal();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (supabaseUrl === '' || serviceKey === '') {
    console.error('Немає SUPABASE env-змінних (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    return 1;
  }
  // reconciliation-scan.ts pattern: fresh service-role client, no session.
  const { createClient } = await import('@supabase/supabase-js');
  const client: SupabaseClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const t0 = Date.now();
  console.log(`== LINOLEUM IMPORT (${args.mode}, ${new Date().toISOString()}) ==`);

  if (args.mode === 'publish') {
    // Standalone photo-presence gate: no staging read, no planner, no
    // category logic — returns BEFORE any sync read/write is reachable.
    const totals = await publishLinoleum(client);
    const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `\n== Публікація (${elapsedS} с): опубліковано ${totals.published}, приховано ${totals.hidden} ` +
        `(з фото ${totals.withPhotos} з ${totals.total} ln-*) ==`
    );
    return 0;
  }

  const rawStaging = await readStagingRaw(client);
  const { rows, skipped, olderOnlyKeys, latestExportDate } = prepareRows(rawStaging);
  const existing = await readExistingLinoleumProducts(client);
  const plan = planLinoleumImport(existing, rows);

  if (args.mode === 'plan') {
    printPlan(plan, {
      rawCount: rawStaging.length,
      skipped,
      freshCount: rows.length,
      existingCount: existing.size,
      olderOnlyKeys,
      latestExportDate,
    });
    return 0;
  }

  const totals = await applyPlan(client, plan, existing);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n== Підсумок (${elapsedS} с): створено ${totals.created}, оновлено ${totals.updated}, ` +
      `зниклі→OOS ${totals.missingSet}, history ${totals.history}, no-op ${totals.noops} ==`
  );

  // Restock hook — ONLY here, after a successful --run (the --plan and
  // --publish branches have already returned above). Reused from the
  // wallpaper CLI (domain-neutral); it never throws: a hook failure is
  // logged and the run still exits 0.
  const restock = await notifyRestockRequests(client);
  if (restock.ok) {
    console.log(
      `Restock-запити: ${restock.pendingRequests} очікували, товарів зі стоком ${restock.matchedProducts}, ` +
        `telegram ${restock.telegramSent ? 'надіслано' : 'не надіслано'}, notified_at ${restock.markedNotified}`
    );
  } else {
    console.log('Restock-запити: пропущено (помилка — див. лог вище); імпорт не зачеплено.');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// --run executor (sync writer) + --publish executor (the ONLY is_active writer)
// ---------------------------------------------------------------------------

interface RunTotals {
  created: number;
  updated: number;
  missingSet: number;
  history: number;
  noops: number;
}

/** products INSERT payload for a planned create (consistent on arrival). */
export function productInsertRow(
  plan: LinoleumPlanRow,
  categoryId: string | null
): Record<string, unknown> {
  return {
    sku: plan.sku,
    slug: plan.slug,
    name: plan.name,
    price: plan.price,
    stock_quantity: plan.stockQuantity,
    availability_status: plan.availability,
    currency: 'UAH',
    is_active: false,
    specifications: plan.specifications,
    category_id: categoryId,
  };
}

export interface StockHistoryInsert {
  product_id: string;
  old_quantity: number;
  new_quantity: number;
  reason: string;
  source: string;
}

/** product_stock_history row for a single stock change. */
export function stockHistoryRow(
  productId: string,
  oldQuantity: number,
  newQuantity: number
): StockHistoryInsert {
  return {
    product_id: productId,
    old_quantity: oldQuantity,
    new_quantity: newQuantity,
    reason: HISTORY_REASON,
    source: HISTORY_SOURCE,
  };
}

async function applyPlan(
  client: SupabaseClient,
  plan: LinoleumPlan,
  existing: ReadonlyMap<string, ExistingProduct>
): Promise<RunTotals> {
  // ---- categories: only the «Лінолеум» root (create-or-reuse-or-abort) ----
  const catPlan = planRootCategory(await readCategories(client));
  if (catPlan.conflict) {
    throw new Error(
      `категорія ${LINOLEUM_ROOT_CATEGORY.slug} існує з іншою назвою (очікується «${LINOLEUM_ROOT_CATEGORY.name}») — не чіпаємо`
    );
  }
  let rootCategoryId = catPlan.existingId;
  let batchNo = 1;
  if (catPlan.create) {
    // is_active omitted: the categories table defaults it to TRUE.
    const { data, error } = await client
      .from('categories')
      .insert({
        name: LINOLEUM_ROOT_CATEGORY.name,
        slug: LINOLEUM_ROOT_CATEGORY.slug,
        parent_id: null,
        sort_order: 0,
      })
      .select('id')
      .returns<{ id: string }[]>();
    if (error || data === null || data.length === 0) {
      throw new Error(
        `батч #${batchNo} (categories insert ${LINOLEUM_ROOT_CATEGORY.slug}): ${error?.message ?? '0 rows'}`
      );
    }
    const inserted = data[0];
    rootCategoryId = inserted !== undefined ? String(inserted.id) : null;
    batchNo += 1;
  }
  if (rootCategoryId === null) {
    throw new Error(`кореневу категорію ${LINOLEUM_ROOT_CATEGORY.slug} не знайдено й не створено`);
  }

  // ---- creates: products inserts (≤200), ids collected via .select ----
  const productIdBySku = new Map<string, string>();
  let created = 0;
  for (const group of chunkRows(plan.creates, BATCH_SIZE)) {
    const payload = group.map((c) => productInsertRow(c, rootCategoryId));
    const { data, error } = await client
      .from('products')
      .insert(payload)
      .select('id,sku')
      .returns<{ id: string; sku: string }[]>();
    if (error || data === null || data.length !== payload.length) {
      throw new Error(
        `батч #${batchNo} (products insert): ${
          error?.message ?? `отримано ${data?.length ?? 0} з ${payload.length}`
        }`
      );
    }
    for (const r of data) productIdBySku.set(String(r.sku), String(r.id));
    created += data.length;
    batchNo += 1;
  }

  // ---- junction rows for the fresh products (root category only) ----
  const junction = plan.creates
    .map((c) => ({ product_id: productIdBySku.get(c.sku), category_id: rootCategoryId }))
    .filter(
      (r): r is { product_id: string; category_id: string } => r.product_id !== undefined
    );
  for (const group of chunkRows(junction, BATCH_SIZE)) {
    const { error } = await client.from('product_categories').insert(group);
    if (error) throw new Error(`батч #${batchNo} (product_categories insert): ${error.message}`);
    batchNo += 1;
  }

  // ---- updates + missing → OOS; every stock change writes history ----
  // availability_status is NEVER written here on update: the migration 040
  // trigger derives it from stock_quantity. is_active is never touched.
  const existingById = new Map<string, ExistingProduct>();
  for (const e of existing.values()) existingById.set(e.id, e);
  let updated = 0;
  let missingSet = 0;
  let historyCount = 0;

  for (const group of chunkRows(plan.updates, BATCH_SIZE)) {
    const history: StockHistoryInsert[] = [];
    for (const op of group) {
      const { data, error } = await client
        .from('products')
        .update(op.fields)
        .eq('id', op.id)
        .select('id')
        .returns<{ id: string }[]>();
      if (error || data === null || data.length === 0) {
        throw new Error(`батч #${batchNo} (products update ${op.id}): ${error?.message ?? '0 rows'}`);
      }
      updated += 1;
      if (op.fields.stock_quantity !== undefined) {
        history.push(
          stockHistoryRow(
            op.id,
            existingById.get(op.id)?.stockQuantity ?? 0,
            op.fields.stock_quantity
          )
        );
      }
    }
    if (history.length > 0) {
      const { error } = await client.from('product_stock_history').insert(history);
      if (error) {
        throw new Error(`батч #${batchNo} (product_stock_history insert): ${error.message}`);
      }
      historyCount += history.length;
    }
    batchNo += 1;
  }

  for (const group of chunkRows(plan.missing, BATCH_SIZE)) {
    const history: StockHistoryInsert[] = [];
    for (const m of group) {
      const { data, error } = await client
        .from('products')
        .update({ stock_quantity: 0 })
        .eq('id', m.id)
        .select('id')
        .returns<{ id: string }[]>();
      if (error || data === null || data.length === 0) {
        throw new Error(`батч #${batchNo} (products OOS ${m.id}): ${error?.message ?? '0 rows'}`);
      }
      missingSet += 1;
      history.push(stockHistoryRow(m.id, existingById.get(m.id)?.stockQuantity ?? 0, 0));
    }
    if (history.length > 0) {
      const { error } = await client.from('product_stock_history').insert(history);
      if (error) {
        throw new Error(`батч #${batchNo} (product_stock_history insert): ${error.message}`);
      }
      historyCount += history.length;
    }
    batchNo += 1;
  }

  return { created, updated, missingSet, history: historyCount, noops: plan.noops.length };
}

// ---------------------------------------------------------------------------
// --publish executor — photo-presence gate, the ONLY place this CLI writes
// is_active (pinned by tests/linoleum-import-cli.test.ts)
// ---------------------------------------------------------------------------

interface PhotoOwnerDbRow {
  product_id: unknown;
}

/**
 * product_ids (within the ln-* domain) that own ≥1 product_images row — the
 * EXISTS (SELECT 1 FROM product_images ...) half of the gate, resolved as a
 * paged JS semi-join: ≤200 ids per `.in` window (project invariant), each
 * window read in PAGE_SIZE pages with an `.order('product_id')` tiebreaker.
 */
async function readProductIdsWithImages(
  client: SupabaseClient,
  productIds: readonly string[]
): Promise<Set<string>> {
  const owners = new Set<string>();
  for (const group of chunkRows([...productIds], BATCH_SIZE)) {
    const rows = await readAllPages<PhotoOwnerDbRow>(
      (from) =>
        client
          .from('product_images')
          .select('product_id')
          .in('product_id', group)
          .order('product_id')
          .range(from, from + PAGE_SIZE - 1)
          .returns<PhotoOwnerDbRow[]>(),
      'product_images'
    );
    for (const r of rows) {
      if (typeof r.product_id === 'string' && r.product_id !== '') owners.add(r.product_id);
    }
  }
  return owners;
}

export interface PublishTotals {
  published: number;
  hidden: number;
  withPhotos: number;
  total: number;
}

/**
 * Publish ONLY ln-* products with ≥1 image; hide the rest of the linoleum
 * domain — the equivalent of
 *
 *   UPDATE products SET is_active = true  WHERE sku LIKE 'ln-%' AND EXISTS
 *     (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id);
 *   UPDATE products SET is_active = false WHERE sku LIKE 'ln-%' AND NOT EXISTS (...);
 *
 * scoped to the same domain the sync reads. EXISTS/NOT EXISTS resolve as the
 * paged JS semi-join above; both writes are diff-aware (only rows that
 * actually flip are sent, so a re-run is a no-op) and batched ≤200 ids per
 * UPDATE. Any batch failure throws with the batch number — re-running
 * --publish recovers (idempotent, no checkpoints needed).
 */
export async function publishLinoleum(client: SupabaseClient): Promise<PublishTotals> {
  const existing = await readExistingLinoleumProducts(client);
  const withPhotos = await readProductIdsWithImages(
    client,
    [...existing.values()].map((p) => p.id)
  );
  const toPublish = [...existing.values()].filter((p) => !p.isActive && withPhotos.has(p.id));
  const toHide = [...existing.values()].filter((p) => p.isActive && !withPhotos.has(p.id));

  let published = 0;
  let hidden = 0;
  let batchNo = 1;
  for (const group of chunkRows(toPublish, BATCH_SIZE)) {
    const { data, error } = await client
      .from('products')
      .update({ is_active: true })
      .in('id', group.map((p) => p.id))
      .select('id')
      .returns<{ id: string }[]>();
    if (error || data === null || data.length !== group.length) {
      throw new Error(
        `батч #${batchNo} (publish enable): ${
          error?.message ?? `отримано ${data?.length ?? 0} з ${group.length}`
        }`
      );
    }
    published += data.length;
    batchNo += 1;
  }

  for (const group of chunkRows(toHide, BATCH_SIZE)) {
    const { data, error } = await client
      .from('products')
      .update({ is_active: false })
      .in('id', group.map((p) => p.id))
      .select('id')
      .returns<{ id: string }[]>();
    if (error || data === null || data.length !== group.length) {
      throw new Error(
        `батч #${batchNo} (publish hide): ${
          error?.message ?? `отримано ${data?.length ?? 0} з ${group.length}`
        }`
      );
    }
    hidden += data.length;
    batchNo += 1;
  }

  return { published, hidden, withPhotos: withPhotos.size, total: existing.size };
}

// Direct execution guard: tests import this module without side effects.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runImportCli(process.argv.slice(2))
    .then((exitCode) => process.exit(exitCode))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
