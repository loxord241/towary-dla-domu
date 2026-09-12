#!/usr/bin/env node
/**
 * Wallpapers IMPORT — CLI executor (plan Task 7, spec §3:
 * docs/superpowers/specs/2026-09-10-wallpapers-import-design.md).
 *
 * Reads the 1C 7.7 wallpaper stock staging (`wallpaper_stock`, migration 041)
 * and reconciles it with the wallpaper product domain (`yugcontract_id IS NULL
 * AND sku LIKE 'wc-%'`) through the pure planner
 * app/lib/wallpapers/import-plan.ts (Task 6).
 *
 * Modes:
 *   node scripts/wallpaper-import.ts --plan [--category-map FILE]
 *       Read-only: prints creates/updates/missing/noops counts + first 10 of
 *       each bucket, exits 0. ZERO writes.
 *   node scripts/wallpaper-import.ts --run [--category-map FILE]
 *       Executes the plan in batches of ≤200:
 *         - creates  → INSERT products (consistent availability, is_active
 *           false, currency 'UAH' — same value the Yugcontract importer writes)
 *           + product_categories junction + legacy products.category_id;
 *         - updates  → per-row UPDATE restricted to the diff fields
 *           (price / stock_quantity);
 *         - missing  → stock_quantity = 0 (OOS), never a DELETE;
 *         - every stock change → product_stock_history
 *           (reason '1c-sync', source '1c-wallpaper').
 *   node scripts/wallpaper-import.ts --publish
 *       Photo-presence gate (spec §4.4, plan Task 9, orchestrator-only by GO):
 *       the SQL intent
 *         UPDATE products SET is_active = true  WHERE sku LIKE 'wc-%' AND EXISTS
 *           (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id);
 *         UPDATE products SET is_active = false WHERE sku LIKE 'wc-%' AND NOT EXISTS (...);
 *       resolved as a paged JS semi-join; prints «опубліковано X, приховано Y».
 *
 * Restock hook (v1, «Повідомити про наявність»): AFTER a successful --run
 * (never in --plan/--publish) the CLI checks `restock_requests`
 * (migration 042) for requests whose product NOW has stock
 * (stock_quantity > 0 AND is_active) and hands the owner a Telegram
 * digest «Надійшли товари (N): sku — назва (запитів: X, emails: …)»
 * (emails included — the owner contacts the customers; private owner chat,
 * sendTelegramText reuse). notified_at is stamped ONLY after a confirmed
 * send, so a Telegram failure retries on the next run. The hook NEVER
 * fails the import: every error path is caught and logged, the run summary
 * stays the source of truth (customer auto-email is v2, once SMTP exists).
 *
 * Invariants (pinned by tests/wallpaper-import-cli.test.ts and
 * tests/wallpaper-publish.test.ts):
 *   - availability_status is NEVER set on UPDATE: the migration 040 trigger
 *     derives it from stock_quantity; on INSERT the plan value is written so
 *     the row starts consistent;
 *   - is_active is UPDATEd ONLY by the --publish executor (two batched
 *     diff-aware flips inside publishWallpapers); the regular sync
 *     (--plan/--run) inserts new rows invisible (is_active false) and never
 *     touches the flag of existing rows — the storefront is owned
 *     exclusively by --publish;
 *   - no DELETE, no rpc, no upsert, no name cascade on existing products —
 *     the plan is idempotent, so a failed batch is recovered by re-running
 *     --run (no checkpoints in v1);
 *   - paged reads: windows of PAGE_SIZE = 1000 with `.order('id')` (project
 *     pagination invariant); the fresh-row-per-code Distinct handling of the
 *     append-only staging happens in JS (prepareRows), not in SQL;
 *   - any batch failure prints the batch number and the error and stops.
 *
 * Categories for creates: optional `--category-map FILE` with JSON
 * {code: categorySlug}; creates whose 1С code is mapped are linked to that
 * category (junction + legacy column), all others fall back to the wallpaper
 * root (WALLPAPER_ROOT, slug 'shpaleri'). Categories missing from the DB are
 * created through the planCategoryUpsert-compatible path (Task 4 module).
 *
 * Service-role client only (pattern:
 * app/lib/payment/reconciliation-scan.ts:126 — createClient,
 * persistSession: false); credentials come from .env.local / shell env and
 * are never logged.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  planWallpaperImport,
  type ExistingProduct,
  type WallpaperPlan,
  type WallpaperPlanRow,
} from '../app/lib/wallpapers/import-plan.ts';
import { parseRollSize, type WallpaperRow } from '../app/lib/wallpapers/parse.ts';
import {
  planCategoryUpsert,
  WALLPAPER_ROOT,
  type ExistingWallpaperCategory,
} from '../app/lib/wallpapers/categories.ts';
import {
  sendTelegramText,
  type TelegramSendResult,
} from '../app/lib/notifications/telegram.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** PostgREST caps any single response at 1000 rows — read windows stay ≤1000. */
export const PAGE_SIZE = 1000;
/** Project write-batch invariant: ≤200 ids/rows per INSERT/UPDATE group. */
export const BATCH_SIZE = 200;
/** product_stock_history.reason for the wallpapers daily sync. */
export const HISTORY_REASON = '1c-sync';
/** product_stock_history.source — marks every wallpapers stock write. */
export const HISTORY_SOURCE = '1c-wallpaper';

const USAGE = `Використання:
  node scripts/wallpaper-import.ts --plan [--category-map FILE]   dry-run: друк плану, 0 записів
  node scripts/wallpaper-import.ts --run  [--category-map FILE]   виконання плану батчами ≤200
  node scripts/wallpaper-import.ts --publish                      вітрина: активні лише позиції з фото`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests/wallpaper-import-cli.test.ts)
// ---------------------------------------------------------------------------

/** A raw `wallpaper_stock` row as read from staging (values defensive-typed). */
export interface RawStagingRow {
  code: unknown;
  name: unknown;
  price_retail: unknown;
  qty: unknown;
  export_date: unknown;
}

export interface PrepareRowsResult {
  rows: WallpaperRow[];
  /** Rows dropped by the defensive validation (DB CHECKs make this rare). */
  skipped: number;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** products.price is NUMERIC(12,2) — the DB rounds on write; matching here
 * keeps re-plans free of phantom price updates. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Distinct-on-JS over the paged staging read: the freshest row per 1С code
 * (max export_date; tie → later input row — staging is append-only and a
 * later ingest supersedes an earlier one). Output preserves the
 * first-appearance order of each code, which keeps the planner deterministic.
 *
 * Migration 041 does not persist the CSV `article` column, so article is
 * always null here (skus derive from codes: `wc-x<code>`); rollSize is
 * restored from the name for downstream consumers.
 */
export function prepareRows(raw: readonly RawStagingRow[]): PrepareRowsResult {
  const byCode = new Map<string, { row: WallpaperRow; exportDate: string }>();
  let skipped = 0;

  for (const src of raw) {
    const code = typeof src.code === 'string' ? src.code.trim() : '';
    const name = typeof src.name === 'string' ? src.name.trim() : '';
    const exportDate = typeof src.export_date === 'string' ? src.export_date.trim() : '';
    const price = toFiniteNumber(src.price_retail);
    const qty = toFiniteNumber(src.qty);

    const valid =
      code !== '' &&
      name !== '' &&
      exportDate !== '' &&
      price !== null &&
      price >= 0 &&
      qty !== null &&
      qty >= 0 &&
      Number.isInteger(qty);
    if (!valid) {
      skipped += 1;
      continue;
    }

    const row: WallpaperRow = {
      code,
      name,
      article: null,
      rollSize: parseRollSize(name),
      priceRetail: round2(price),
      qty,
    };
    const prev = byCode.get(code);
    if (prev === undefined || exportDate >= prev.exportDate) {
      byCode.set(code, { row, exportDate });
    }
  }

  return { rows: [...byCode.values()].map((e) => e.row), skipped };
}

/** Exact batch windows of `size` (≤ BATCH_SIZE at every call site). */
export function chunkRows<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Parse + validate the `--category-map` file: a JSON object mapping 1С codes
 * to storefront category slugs. Throws (fail-closed) on any shape violation.
 */
export function parseCategoryMap(text: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('category map: файл не є валідним JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`category map: очікується JSON-об'єкт {code: categorySlug}`);
  }
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.trim() === '') throw new Error('category map: порожній код у category map');
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `category map: значення для кода "${key}" має бути непустим рядком-slug'ом`
      );
    }
    map.set(key.trim(), value.trim());
  }
  return map;
}

/**
 * create.sku → 1С code, needed to apply the code-keyed category map.
 *
 * Derived THROUGH the planner itself (single source of truth for sku
 * derivation, including `-2` collision suffixes): with an empty existing map
 * every row becomes a create, and creates[i] corresponds to rows[i]. A sku
 * that cannot be resolved (sibling-collision re-runs) falls back to the root
 * category at the call site — a safe default, never a wrong assignment.
 */
export function deriveCodeBySku(rows: readonly WallpaperRow[]): Map<string, string> {
  const creates = planWallpaperImport(new Map<string, ExistingProduct>(), [...rows]).creates;
  const map = new Map<string, string>();
  const n = Math.min(creates.length, rows.length);
  for (let i = 0; i < n; i++) {
    const create = creates[i];
    const row = rows[i];
    if (create !== undefined && row !== undefined) map.set(create.sku, row.code);
  }
  return map;
}

/** products INSERT payload for a planned create (consistent on arrival). */
export function productInsertRow(
  plan: WallpaperPlanRow,
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

export interface WallpaperImportCliArgs {
  mode: 'plan' | 'run' | 'publish';
  categoryMapPath: string | null;
}

/** Exactly ONE action flag must be present; mixing (or none) → usage. */
export function parseArgs(argv: readonly string[]): WallpaperImportCliArgs | null {
  const modes: WallpaperImportCliArgs['mode'][] = [];
  if (argv.includes('--plan')) modes.push('plan');
  if (argv.includes('--run')) modes.push('run');
  if (argv.includes('--publish')) modes.push('publish');
  if (modes.length !== 1) return null; // neither or mixed → usage
  const mode = modes[0];
  if (mode === undefined) return null;
  const mapIdx = argv.indexOf('--category-map');
  let categoryMapPath: string | null = null;
  if (mapIdx !== -1) {
    const value = argv[mapIdx + 1];
    if (value === undefined || value.startsWith('--')) return null;
    categoryMapPath = value;
  }
  if (mode === 'publish' && categoryMapPath !== null) return null; // publish takes no options
  return { mode, categoryMapPath };
}

// ---------------------------------------------------------------------------
// env + DB readers (SELECT-only, paged, fresh builder per page)
// ---------------------------------------------------------------------------

/** .env.local loader (same contract as scripts/yugcontract-content-apply.ts). */
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
        .from('wallpaper_stock')
        .select('code,name,price_retail,qty,export_date')
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<RawStagingRow[]>(),
    'wallpaper_stock'
  );
}

interface ExistingProductDbRow {
  id: unknown;
  sku: unknown;
  name: unknown;
  price: unknown;
  stock_quantity: unknown;
  is_active: unknown;
}

/** The wallpaper domain only: yugcontract_id IS NULL AND sku LIKE 'wc-%'. */
async function readExistingWallpaperProducts(
  client: SupabaseClient
): Promise<Map<string, ExistingProduct>> {
  const rows = await readAllPages<ExistingProductDbRow>(
    (from) =>
      client
        .from('products')
        .select('id,sku,name,price,stock_quantity,is_active')
        .is('yugcontract_id', null)
        .like('sku', 'wc-%')
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<ExistingProductDbRow[]>(),
    'products (wc-*)'
  );
  const existing = new Map<string, ExistingProduct>();
  for (const r of rows) {
    const sku = typeof r.sku === 'string' ? r.sku.trim() : '';
    const price = toFiniteNumber(r.price);
    const stock = toFiniteNumber(r.stock_quantity);
    if (sku === '' || price === null || stock === null || typeof r.id !== 'string') {
      throw new Error(`існуючий wc-* товар з некоректними даними (sku=${String(r.sku)})`);
    }
    existing.set(sku, {
      id: r.id,
      sku,
      name: typeof r.name === 'string' ? r.name : '',
      price,
      stockQuantity: stock,
      isActive: r.is_active === true,
    });
  }
  return existing;
}

interface CategoryDbRow {
  id: unknown;
  slug: unknown;
  name: unknown;
  parent_id: unknown;
}

async function readCategories(client: SupabaseClient): Promise<ExistingWallpaperCategory[]> {
  const rows = await readAllPages<CategoryDbRow>(
    (from) =>
      client
        .from('categories')
        .select('id,slug,name,parent_id')
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<CategoryDbRow[]>(),
    'categories'
  );
  const out: ExistingWallpaperCategory[] = [];
  for (const r of rows) {
    if (typeof r.id !== 'string' || typeof r.slug !== 'string' || typeof r.name !== 'string') {
      continue;
    }
    out.push({
      id: r.id,
      slug: r.slug,
      name: r.name,
      parentId: typeof r.parent_id === 'string' ? r.parent_id : null,
    });
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
  categoryMap: { path: string; entries: number } | null;
}

function printPlan(plan: WallpaperPlan, stats: PlanStats): void {
  console.log(
    `staging: ${stats.rawCount} сирих рядків → ${stats.freshCount} свіжих на код (пропущено ${stats.skipped})`
  );
  console.log(`існуючих wc-* товарів: ${stats.existingCount}`);
  console.log(`creates: ${plan.creates.length}`);
  for (const c of plan.creates.slice(0, 10)) {
    console.log(
      `  + ${c.sku} "${c.name}" price=${c.price} qty=${c.stockQuantity} ${c.availability}`
    );
  }
  console.log(`updates: ${plan.updates.length}`);
  for (const u of plan.updates.slice(0, 10)) {
    const parts: string[] = [];
    if (u.fields.price !== undefined) parts.push(`price→${u.fields.price}`);
    if (u.fields.stock_quantity !== undefined) parts.push(`stock_quantity→${u.fields.stock_quantity}`);
    console.log(`  ~ id=${u.id} ${parts.join(', ')}`);
  }
  console.log(`missing (OOS, stock_quantity=0): ${plan.missing.length}`);
  for (const m of plan.missing.slice(0, 10)) console.log(`  ! id=${m.id}`);
  console.log(`noops: ${plan.noops.length}`);
  for (const s of plan.noops.slice(0, 10)) console.log(`  = ${s}`);
  console.log(`conflicts: ${plan.conflicts.length}`);
  if (stats.categoryMap !== null) {
    console.log(`category-map: ${stats.categoryMap.path} (${stats.categoryMap.entries} кодів)`);
  }
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
  console.log(`== WALLPAPER IMPORT (${args.mode}, ${new Date().toISOString()}) ==`);

  if (args.mode === 'publish') {
    // Standalone photo-presence gate: no staging read, no planner, no
    // category logic — returns BEFORE any sync read/write is reachable.
    const totals = await publishWallpapers(client);
    const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `\n== Публікація (${elapsedS} с): опубліковано ${totals.published}, приховано ${totals.hidden} ` +
        `(з фото ${totals.withPhotos} з ${totals.total} wc-*) ==`
    );
    return 0;
  }

  const rawStaging = await readStagingRaw(client);
  const { rows, skipped } = prepareRows(rawStaging);
  const existing = await readExistingWallpaperProducts(client);
  const plan = planWallpaperImport(existing, rows);

  if (args.mode === 'plan') {
    let categoryMap: PlanStats['categoryMap'] = null;
    if (args.categoryMapPath !== null) {
      const parsed = parseCategoryMap(readFileSync(args.categoryMapPath, 'utf8'));
      categoryMap = { path: args.categoryMapPath, entries: parsed.size };
    }
    printPlan(plan, {
      rawCount: rawStaging.length,
      skipped,
      freshCount: rows.length,
      existingCount: existing.size,
      categoryMap,
    });
    return 0;
  }

  const totals = await applyPlan(client, args, plan, rows, existing);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n== Підсумок (${elapsedS} с): створено ${totals.created}, оновлено ${totals.updated}, ` +
      `зниклі→OOS ${totals.missingSet}, history ${totals.history}, no-op ${totals.noops} ==`
  );

  // Restock hook (v1) — ONLY here, after a successful --run (the --plan and
  // --publish branches have already returned above). notifyRestockRequests
  // never throws: a hook failure is logged and the run still exits 0.
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

async function applyPlan(
  client: SupabaseClient,
  args: WallpaperImportCliArgs,
  plan: WallpaperPlan,
  rows: readonly WallpaperRow[],
  existing: ReadonlyMap<string, ExistingProduct>
): Promise<RunTotals> {
  const categoryMap =
    args.categoryMapPath !== null
      ? parseCategoryMap(readFileSync(args.categoryMapPath, 'utf8'))
      : new Map<string, string>();

  // ---- categories: reuse the Task 4 planner, create only what is needed ----
  const existingCategories = await readCategories(client);
  const slugToId = new Map(existingCategories.map((c) => [c.slug, c.id]));
  const catPlan = planCategoryUpsert(existingCategories);
  const neededSlugs = new Set<string>([WALLPAPER_ROOT.slug, ...categoryMap.values()]);
  const conflicts = catPlan.conflicts.filter((s) => neededSlugs.has(s));
  if (conflicts.length > 0) {
    throw new Error(
      `категорії-конфлікти (slug існує з іншою назвою, не чіпаємо): ${conflicts.join(', ')}`
    );
  }
  const plannedSlugs = new Set(catPlan.creates.map((c) => c.slug));
  const unknownSlugs = [...neededSlugs].filter((s) => !slugToId.has(s) && !plannedSlugs.has(s));
  if (unknownSlugs.length > 0) {
    throw new Error(
      `категорії неможливо забезпечити (немає в БД й поза деревом шпалер): ${unknownSlugs.join(', ')}`
    );
  }

  // Creates arrive in dependency order (root first); parents resolve through
  // the live slug→id map — per-insert resolution, never a stale snapshot.
  // is_active is omitted: the categories table defaults it to TRUE.
  let batchNo = 1;
  for (const create of catPlan.creates) {
    if (!neededSlugs.has(create.slug) || slugToId.has(create.slug)) continue;
    const parentId =
      create.parentSlug === null ? null : (slugToId.get(create.parentSlug) ?? null);
    if (create.parentSlug !== null && parentId === null) {
      throw new Error(`батч #${batchNo}: батьківську категорію ${create.parentSlug} не знайдено`);
    }
    const { data, error } = await client
      .from('categories')
      .insert({ name: create.name, slug: create.slug, parent_id: parentId, sort_order: 0 })
      .select('id')
      .returns<{ id: string }[]>();
    if (error || data === null || data.length === 0) {
      throw new Error(
        `батч #${batchNo} (categories insert ${create.slug}): ${error?.message ?? '0 rows'}`
      );
    }
    const inserted = data[0];
    if (inserted !== undefined) slugToId.set(create.slug, String(inserted.id));
    batchNo += 1;
  }

  // ---- category per create: map[code] ?? wallpaper root ----
  const codeBySku = deriveCodeBySku(rows);
  const rootCategoryId = slugToId.get(WALLPAPER_ROOT.slug);
  if (rootCategoryId === undefined) {
    throw new Error(`кореневу категорію ${WALLPAPER_ROOT.slug} не знайдено й не створено`);
  }
  const categoryIdBySku = new Map<string, string>();
  for (const create of plan.creates) {
    const code = codeBySku.get(create.sku);
    const slug = (code !== undefined ? categoryMap.get(code) : undefined) ?? WALLPAPER_ROOT.slug;
    const categoryId = slugToId.get(slug);
    if (categoryId === undefined) {
      throw new Error(`категорію ${slug} (код ${code ?? '—'}) не знайдено`);
    }
    categoryIdBySku.set(create.sku, categoryId);
  }

  // ---- creates: products inserts (≤200), ids collected via .select ----
  const productIdBySku = new Map<string, string>();
  let created = 0;
  for (const group of chunkRows(plan.creates, BATCH_SIZE)) {
    const payload = group.map((c) => productInsertRow(c, categoryIdBySku.get(c.sku) ?? null));
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

  // ---- junction rows for the fresh products (direct assignment only) ----
  const junction = plan.creates
    .map((c) => ({
      product_id: productIdBySku.get(c.sku),
      category_id: categoryIdBySku.get(c.sku),
    }))
    .filter(
      (r): r is { product_id: string; category_id: string } =>
        r.product_id !== undefined && r.category_id !== undefined
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
// --publish executor — photo-presence gate (spec §4.4), the ONLY place this
// CLI writes is_active (pinned by tests/wallpaper-publish.test.ts)
// ---------------------------------------------------------------------------

interface PhotoOwnerDbRow {
  product_id: unknown;
}

/**
 * product_ids (within the wc-* domain) that own ≥1 product_images row — the
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
 * Publish ONLY wc-* products with ≥1 image; hide the rest of the wallpaper
 * domain — the equivalent of
 *
 *   UPDATE products SET is_active = true  WHERE sku LIKE 'wc-%' AND EXISTS
 *     (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id);
 *   UPDATE products SET is_active = false WHERE sku LIKE 'wc-%' AND NOT EXISTS (...);
 *
 * scoped to the same domain the sync reads (yugcontract_id IS NULL).
 * EXISTS/NOT EXISTS resolve as the paged JS semi-join above; both writes are
 * diff-aware (only rows that actually flip are sent, so a re-run is a no-op)
 * and batched ≤200 ids per UPDATE. Any batch failure throws with the batch
 * number — re-running --publish recovers (no checkpoints needed: idempotent).
 */
export async function publishWallpapers(client: SupabaseClient): Promise<PublishTotals> {
  const existing = await readExistingWallpaperProducts(client);
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

// ---------------------------------------------------------------------------
// Restock hook (v1) — «Повідомити про наявність» owner digest, invoked ONLY
// from the --run branch after applyPlan succeeds (see runImportCli above).
// Defined AFTER the publish executor on purpose: tests/wallpaper-import-cli
// slices the sync half before publishWallpapers, and this section belongs to
// neither sync nor publish — it reads/writes ONLY restock_requests
// (migration 042; RLS + revoke, service-role client) and never products.
// ---------------------------------------------------------------------------

/** A pending `restock_requests` row (SELECT only; notified_at IS NULL). */
export interface RestockRequestRow {
  id: string;
  product_id: string;
  email: string;
}

/** The product facts the digest filter needs (all SELECT-only). */
export interface RestockProductRow {
  id: string;
  sku: string;
  name: string;
  stockQuantity: number;
  isActive: boolean;
}

/** One «product that came back in stock» digest line (pure). */
export interface RestockDigestEntry {
  productId: string;
  sku: string;
  name: string;
  requestCount: number;
  emails: string[];
}

/** Digest caps: Telegram hard limit is 4096 — keep headroom (telegram.ts). */
export const RESTOCK_MESSAGE_MAX = 3900;
/** Products per digest message; overflow is summarized, never lost. */
export const RESTOCK_MAX_PRODUCTS = 50;
/** Emails listed per product; the rest collapse into «+N». */
export const RESTOCK_MAX_EMAILS_PER_PRODUCT = 10;

/**
 * Pure grouping: pending requests → digest entries for products that NOW
 * have stock (stock_quantity > 0 AND is_active — the storefront-visible
 * restock). Products unknown to the map (deleted), sold-out-again or still
 * unpublished are skipped (their requests stay pending for a later run);
 * first-appearance order of requests is preserved.
 */
export function buildRestockEntries(
  requests: readonly RestockRequestRow[],
  productsById: ReadonlyMap<string, RestockProductRow>
): RestockDigestEntry[] {
  const order: string[] = [];
  const byProduct = new Map<string, string[]>();
  for (const r of requests) {
    if (!productsById.has(r.product_id)) continue;
    let emails = byProduct.get(r.product_id);
    if (emails === undefined) {
      emails = [];
      byProduct.set(r.product_id, emails);
      order.push(r.product_id);
    }
    if (!emails.includes(r.email)) emails.push(r.email);
  }

  const entries: RestockDigestEntry[] = [];
  for (const productId of order) {
    const product = productsById.get(productId);
    const emails = byProduct.get(productId);
    if (product === undefined || emails === undefined) continue;
    if (!(product.stockQuantity > 0) || !product.isActive) continue;
    entries.push({
      productId,
      sku: product.sku,
      name: product.name,
      requestCount: emails.length,
      emails,
    });
  }
  return entries;
}

/**
 * PII hygiene (audit P2): the digest goes to stdout/logs — emails are
 * masked (first char + *** + domain) so a log reader can match requests
 * without harvesting addresses.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Plain-text owner digest (no parse_mode, same reasoning as telegram.ts):
 *   Надійшли товари (2):
 *   • wc-x6647-04 — Шпалери 6647-04, 53см*10м (запитів: 3, emails: a***@b.c, d***@e.f)
 * Capped per RESTOCK_* constants; the message itself is hard-capped at
 * RESTOCK_MESSAGE_MAX (per-recipient Telegram failures never depend on it).
 */
export function buildRestockMessage(entries: readonly RestockDigestEntry[]): string {
  const lines: string[] = [`Надійшли товари (${entries.length}):`];
  const shown = entries.slice(0, RESTOCK_MAX_PRODUCTS);
  for (const entry of shown) {
    const emailList =
      entry.emails.length <= RESTOCK_MAX_EMAILS_PER_PRODUCT
        ? entry.emails.map(maskEmail).join(', ')
        : `${entry.emails.slice(0, RESTOCK_MAX_EMAILS_PER_PRODUCT).map(maskEmail).join(', ')} +${entry.emails.length - RESTOCK_MAX_EMAILS_PER_PRODUCT}`;
    const name = entry.name.length > 120 ? `${entry.name.slice(0, 120)}…` : entry.name;
    lines.push(`• ${entry.sku} — ${name} (запитів: ${entry.requestCount}, emails: ${emailList})`);
  }
  if (entries.length > shown.length) {
    lines.push(`…та ще ${entries.length - shown.length} товарів (наступний прогон)`);
  }
  const message = lines.join('\n');
  return message.length > RESTOCK_MESSAGE_MAX
    ? `${message.slice(0, RESTOCK_MESSAGE_MAX)}…`
    : message;
}

export interface RestockNotifyResult {
  /** false = the hook aborted (read/update failure) — the import is unaffected. */
  ok: boolean;
  /** Pending (notified_at IS NULL) requests found at read time. */
  pendingRequests: number;
  /** Digest products that qualified (stock > 0 AND active). */
  matchedProducts: number;
  /** Confirmed Telegram delivery (all configured recipients). */
  telegramSent: boolean;
  /** Requests stamped notified_at (only after a confirmed send). */
  markedNotified: number;
}

/**
 * Runs the whole hook; NEVER throws (any failure is logged and resolved as
 * { ok: false }), so a restock problem can never fail a finished --run.
 * Semantics:
 *  - 0 pending requests → nothing else happens (telegram is NOT called);
 *  - telegram send not confirmed (failure OR disabled env) → notified_at is
 *    NOT stamped — the same requests are offered again on the next run;
 *  - migration 042 not applied yet → the read fails → { ok: false }, run ok.
 */
export async function notifyRestockRequests(
  client: SupabaseClient,
  sendText: (text: string) => Promise<TelegramSendResult> = sendTelegramText
): Promise<RestockNotifyResult> {
  try {
    const requests = await readAllPages<RestockRequestRow>(
      (from) =>
        client
          .from('restock_requests')
          .select('id,product_id,email')
          .is('notified_at', null)
          .order('id')
          .range(from, from + PAGE_SIZE - 1)
          .returns<RestockRequestRow[]>(),
      'restock_requests'
    );
    if (requests.length === 0) {
      return { ok: true, pendingRequests: 0, matchedProducts: 0, telegramSent: false, markedNotified: 0 };
    }

    // Fresh stock facts for the requested products only, ≤200 ids per .in
    // window (project invariant); the result set is ≤ ids count < 1000, so
    // one read per window is enough.
    const productIds = [...new Set(requests.map((r) => r.product_id))];
    const productsById = new Map<string, RestockProductRow>();
    for (const group of chunkRows(productIds, BATCH_SIZE)) {
      const { data, error } = await client
        .from('products')
        .select('id,sku,name,stock_quantity,is_active')
        .in('id', group)
        .returns<
          {
            id: unknown;
            sku: unknown;
            name: unknown;
            stock_quantity: unknown;
            is_active: unknown;
          }[]
        >();
      if (error) throw new Error(`помилка читання products: ${error.message}`);
      for (const r of data ?? []) {
        if (typeof r.id !== 'string' || typeof r.sku !== 'string') continue;
        const stock = toFiniteNumber(r.stock_quantity);
        if (stock === null) continue;
        productsById.set(r.id, {
          id: r.id,
          sku: r.sku,
          name: typeof r.name === 'string' ? r.name : '',
          stockQuantity: stock,
          isActive: r.is_active === true,
        });
      }
    }

    const entries = buildRestockEntries(requests, productsById);
    if (entries.length === 0) {
      return {
        ok: true,
        pendingRequests: requests.length,
        matchedProducts: 0,
        telegramSent: false,
        markedNotified: 0,
      };
    }

    const result = await sendText(buildRestockMessage(entries));
    if (!result.sent) {
      console.error(
        `restock notify: telegram не надіслано (${result.reason ?? 'невідома причина'}) — notified_at НЕ проставлено, заявки підуть у наступний прогон`
      );
      return {
        ok: true,
        pendingRequests: requests.length,
        matchedProducts: entries.length,
        telegramSent: false,
        markedNotified: 0,
      };
    }

    // Stamp ONLY the requests that were included in the digest.
    const digested = new Set(entries.map((e) => e.productId));
    const issuedIds = [...new Set(requests.filter((r) => digested.has(r.product_id)).map((r) => r.id))];
    let markedNotified = 0;
    for (const group of chunkRows(issuedIds, BATCH_SIZE)) {
      const { error } = await client
        .from('restock_requests')
        .update({ notified_at: new Date().toISOString() })
        .in('id', group);
      if (error) throw new Error(`помилка позначення notified_at: ${error.message}`);
      markedNotified += group.length;
    }

    return {
      ok: true,
      pendingRequests: requests.length,
      matchedProducts: entries.length,
      telegramSent: true,
      markedNotified,
    };
  } catch (error) {
    console.error(
      `restock notify failed (імпорт не зачеплено): ${error instanceof Error ? error.message : 'error'}`
    );
    return { ok: false, pendingRequests: 0, matchedProducts: 0, telegramSent: false, markedNotified: 0 };
  }
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
