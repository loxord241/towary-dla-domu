// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPriceCatalogWithMeta, getCategoriesCatalog } from './client.ts';
import {
  extractRawProducts,
  extractCategoryRows,
  detectCategoryFields,
  normalizeCategoryNode,
  normalizeYcProduct,
} from './normalize.ts';
import {
  SELECTED_CATEGORIES,
  collectExpandedIds,
  flattenSelectedIds,
} from './selection.ts';
import { makeCategoryFilter } from './dry-run.ts';
import {
  buildBrandPlan,
  buildCategoryPlan,
  mapFeedProducts,
  splitProductWrites,
  type CategoryPlan,
  type ExistingBrandRow,
  type ExistingCategoryRow,
  type MappedProductRow,
} from './import-plan.ts';
import type { YcProduct } from './types';
import { RowErrorCollector } from './row-errors.ts';

/**
 * Server-side execution of the Yugcontract import.
 *
 * Invariants:
 *  - ONE checkpoint row per (run, phase, batch) in yc_import_batches;
 *    a crashed invocation leaves 'running' which becomes retryable after
 *    STALE_RUNNING_MS — safe because every write below is idempotent
 *    (identity = yugcontract_id; inserts are re-derived from the feed).
 *  - Writes happen in small chunks (CHUNK rows per request), never one
 *    giant transaction and never the whole feed in memory: raw rows are
 *    normalized and reduced to write ops before persistence.
 *  - Existing manual products/categories/brands are never modified or
 *    deleted. Slug/is_active of already-imported rows stay stable.
 *  - Every credential stays inside client.ts; nothing here logs or
 *    returns secrets.
 */

const CHUNK = 200;
export const STALE_RUNNING_MS = 10 * 60 * 1000;

export interface ImportBatchRow {
  id: string;
  run_id: string;
  phase: 'categories' | 'products';
  batch_no: number;
  payload: { cats?: string[] } | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  processed_count: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface BatchCounters {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
}

export interface ImportDeps {
  /** live tree + approved selection expansion */
  loadExpandedTree(): Promise<{ nodes: ReturnType<typeof normalizeCategoryNode>[]; expanded: Set<string> }>;
  /** leaf category ids of the approved selection (request batching units) */
  loadLeaves(): Promise<string[]>;
  /** normalized, selection-filtered, deduped feed rows for one leaf batch */
  loadFeedBatch(leafCats: string[]): Promise<YcProduct[]>;
}

/** Real deps wired to the Yugcontract API + approved category selection. */
export function makeRealDeps(): ImportDeps {
  type Node = ReturnType<typeof normalizeCategoryNode>;
  let cache: { nodes: Node[]; expanded: Set<string>; leaves: string[] } | null = null;

  async function loadOnce() {
    if (cache) return cache;
    const parsed = await getCategoriesCatalog();
    const { rows } = extractCategoryRows(parsed);
    const fields = detectCategoryFields(rows);
    const nodes = rows.map((row) => normalizeCategoryNode(row, fields));
    const { expanded } = collectExpandedIds(nodes, flattenSelectedIds(SELECTED_CATEGORIES));
    // leaf = no other tree node declares it as parent
    const parentIds = new Set(nodes.map((n) => n.parentId));
    const leaves = [...expanded].filter((id) => !parentIds.has(id)).sort((a, b) => Number(a) - Number(b));
    cache = { nodes, expanded, leaves };
    return cache;
  }

  // Cross-batch duplicate guard within one deps instance: an id handed out
  // once is never handed out again (leaf batches are disjoint in practice).
  const seen = new Set<string>();

  return {
    async loadExpandedTree() {
      const { nodes, expanded } = await loadOnce();
      return { nodes, expanded };
    },
    async loadLeaves() {
      const { leaves } = await loadOnce();
      return leaves;
    },
    async loadFeedBatch(leafCats: string[]) {
      const { parsed } = await getPriceCatalogWithMeta({ cats: leafCats.map(Number) });
      const raw = extractRawProducts(parsed);
      const { expanded } = await loadOnce();
      const keep = makeCategoryFilter(expanded);
      const out: YcProduct[] = [];
      for (const r of raw) {
        const p = normalizeYcProduct(r);
        if (p.externalId === '' || seen.has(p.externalId)) continue;
        if (!keep(p)) continue;
        seen.add(p.externalId);
        out.push(p);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Checkpoint CRUD (yc_import_batches)
// ---------------------------------------------------------------------------

async function selectBatches(
  client: SupabaseClient,
  runId: string
): Promise<ImportBatchRow[]> {
  // Paged defensively: (run_id,phase,batch_no) is unique so the order is
  // deterministic, but a mega-run could exceed the 1000-row response cap.
  const rows: ImportBatchRow[] = [];
  let from = 0;
  for (;;) {
    const PAGE = 1000;
    const { data, error } = await client
      .from('yc_import_batches')
      .select('*')
      .eq('run_id', runId)
      .order('phase', { ascending: true })
      .order('batch_no', { ascending: true })
      .range(from, from + PAGE - 1)
      .returns<ImportBatchRow[]>();
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return rows;
    from += PAGE;
  }
}

/** Insert planned batches that do not exist yet; never reset existing ones. */
export async function ensureRun(
  client: SupabaseClient,
  runId: string,
  planned: { phase: 'categories' | 'products'; batchNo: number; payload?: { cats?: string[] } }[]
): Promise<ImportBatchRow[]> {
  const existing = await selectBatches(client, runId);
  const key = (phase: string, no: number) => `${phase}:${no}`;
  const known = new Set(existing.map((b) => key(b.phase, b.batch_no)));
  const missing = planned.filter((p) => !known.has(key(p.phase, p.batchNo)));
  if (missing.length > 0) {
    const { error } = await client.from('yc_import_batches').insert(
      missing.map((p) => ({
        run_id: runId,
        phase: p.phase,
        batch_no: p.batchNo,
        payload: p.payload ?? null,
        status: 'pending',
      }))
    );
    if (error) throw new Error(error.message);
  }
  return selectBatches(client, runId);
}

/**
 * Claim the next workable batch: categories first, then products in order.
 * 'failed' batches are retryable; 'running' only after STALE_RUNNING_MS
 * (crashed invocation recovery).
 */
export async function claimNextBatch(
  client: SupabaseClient,
  runId: string
): Promise<ImportBatchRow | null> {
  const rows = await selectBatches(client, runId);
  if (rows.length === 0) return null;

  const categoriesDone = rows.some(
    (b) => b.phase === 'categories' && b.status === 'done'
  );

  const now = Date.now();
  const claimable = rows.filter((b) => {
    if (b.status === 'done') return false;
    if (b.phase === 'products' && !categoriesDone) return false;
    if (b.status === 'pending' || b.status === 'failed') return true;
    if (b.status === 'running') {
      const startedAt = Date.parse(b.started_at ?? '');
      return Number.isFinite(startedAt) && now - startedAt > STALE_RUNNING_MS;
    }
    return false;
  });
  // Atomic compare-and-swap: walk candidates in order and only land the
  // claim UPDATE while the batch is still in the state we saw. An empty
  // .select('id') result means another runner won the race — skip it and
  // try the next candidate.
  for (const next of claimable) {
    let cas = client
      .from('yc_import_batches')
      .update({ status: 'running', started_at: new Date().toISOString(), last_error: null })
      .eq('id', next.id)
      .eq('status', next.status);
    if (next.status === 'running') {
      // Stale-running reclaim: pin started_at so a batch that was already
      // re-claimed (and restarted) by someone else is never intercepted.
      cas = cas.eq('started_at', next.started_at ?? '');
    }
    const { data, error } = await cas.select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) continue;
    return { ...next, status: 'running' };
  }
  return null;
}

async function finishBatch(
  client: SupabaseClient,
  batchId: string,
  status: 'done' | 'failed',
  counters: BatchCounters,
  lastError: string | null
): Promise<void> {
  const { error } = await client
    .from('yc_import_batches')
    .update({
      status,
      processed_count: counters.inserted + counters.updated + counters.skipped + counters.errors,
      inserted_count: counters.inserted,
      updated_count: counters.updated,
      skipped_count: counters.skipped,
      error_count: counters.errors,
      last_error: lastError,
      finished_at: new Date().toISOString(),
    })
    .eq('id', batchId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Shared DB readers (SELECT-only, paged)
// ---------------------------------------------------------------------------

// PostgREST caps ANY single response at 1000 rows regardless of the
// requested window, so PAGE must stay <= 1000 or this loop silently
// stops after the first page (observed live: PAGE=5000 returned 1000
// of 4323 products). `.order('id')` keeps multi-page reads deterministic.
const PAGE = 1000;

export async function fetchAllRows<T>(
  client: SupabaseClient,
  table: string,
  select: string
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(select)
      .order('id')
      .range(from, from + PAGE - 1)
      .returns<T[]>();
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return rows;
    from += PAGE;
  }
}

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function insertChunked(
  client: SupabaseClient,
  table: string,
  rows: object[],
  select: string
): Promise<Record<string, unknown>[]> {
  const inserted: Record<string, unknown>[] = [];
  for (const part of chunk(rows)) {
    const { data, error } = await client
      .from(table)
      .insert(part as Record<string, unknown>[])
      .select(select);
    if (error) throw new Error(`${table}: ${error.message}`);
    inserted.push(...((data ?? []) as unknown as Record<string, unknown>[]));
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Phase executors — each is idempotent, so a retried batch cannot duplicate.
// ---------------------------------------------------------------------------

export interface BatchOutcome {
  phase: 'categories' | 'products';
  batchNo: number;
  status: 'done' | 'failed' | 'conflict';
  counters: BatchCounters;
  conflicts: string[];
  message: string;
}

/** Resolve CategoryPlan parent links to UUIDs and apply creates+updates. */
export async function applyCategoryPlan(
  client: SupabaseClient,
  plan: CategoryPlan
): Promise<BatchCounters & { rowErrors: RowErrorCollector }> {
  // seed ext→uuid with already-known supplier categories
  const existingRows = await fetchAllRows<ExistingCategoryRow & { yugcontract_id: string | null }>(
    client,
    'categories',
    'id,parent_id,name,slug,yugcontract_id'
  );
  const extToUuid = new Map<string, string>();
  for (const row of existingRows) {
    if (row.yugcontract_id !== null) extToUuid.set(row.yugcontract_id, row.id);
  }

  let inserted = 0;
  // Parent resolution must happen PER CHUNK: creates are globally
  // depth-sorted, so by the time a chunk is built its parents already sit
  // in extToUuid (from earlier chunks or earlier rows of the same INSERT,
  // which PostgreSQL checks row-by-row). Resolving upfront would null
  // every child's parent_id.
  for (const ops of chunk(plan.creates)) {
    const rows = ops.map((op) => ({
      yugcontract_id: op.yugcontract_id,
      name: op.name,
      slug: op.slug,
      parent_id:
        op.parentYcId !== null ? extToUuid.get(op.parentYcId) ?? null : null,
      sort_order: 0,
      is_active: true,
    }));
    const created = await insertChunked(client, 'categories', rows, 'id,yugcontract_id');
    for (const row of created) {
      if (typeof row.yugcontract_id === 'string' && typeof row.id === 'string') {
        extToUuid.set(row.yugcontract_id, row.id);
      }
    }
    inserted += created.length;
  }

  let updated = 0;
  let errors = 0;
  const rowErrors = new RowErrorCollector();
  for (const op of plan.updates) {
    const fields: Record<string, unknown> = {};
    if (op.name !== undefined) fields.name = op.name;
    if (op.parentYcId !== undefined) {
      fields.parent_id =
        op.parentYcId !== null ? extToUuid.get(op.parentYcId) ?? null : null;
    }
    if (Object.keys(fields).length === 0) continue;
    const { error } = await client.from('categories').update(fields).eq('id', op.id);
    if (error) {
      errors += 1;
      rowErrors.add(`category ${op.id}`, error.message);
    } else updated += 1;
  }

  return { inserted, updated, skipped: 0, errors, rowErrors };
}

async function runCategoriesBatch(
  client: SupabaseClient,
  batch: ImportBatchRow,
  deps: ImportDeps
): Promise<BatchOutcome> {
  try {
    const { nodes, expanded } = await deps.loadExpandedTree();
    const existingRows = await fetchAllRows<ExistingCategoryRow>(
      client,
      'categories',
      'id,parent_id,name,slug,yugcontract_id'
    );
    const plan = buildCategoryPlan(nodes, expanded, existingRows);
    if (plan.conflicts.length > 0) {
      await finishBatch(client, batch.id, 'failed', { inserted: 0, updated: 0, skipped: 0, errors: 0 },
        `конфлікти: ${plan.conflicts.slice(0, 5).join('; ')}`);
      return {
        phase: 'categories',
        batchNo: batch.batch_no,
        status: 'conflict',
        counters: { inserted: 0, updated: 0, skipped: 0, errors: 0 },
        conflicts: plan.conflicts,
        message: `Знайдено ${plan.conflicts.length} конфліктів категорій — імпорт зупинено`,
      };
    }
    const { rowErrors, ...counters } = await applyCategoryPlan(client, plan);
    await finishBatch(client, batch.id, 'done', counters, rowErrors.toLastError());
    return {
      phase: 'categories',
      batchNo: batch.batch_no,
      status: 'done',
      counters,
      conflicts: [],
      message: `Категорії: +${counters.inserted} створено, ${counters.updated} оновлено`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishBatch(client, batch.id, 'failed', { inserted: 0, updated: 0, skipped: 0, errors: 1 }, msg);
    return {
      phase: 'categories',
      batchNo: batch.batch_no,
      status: 'failed',
      counters: { inserted: 0, updated: 0, skipped: 0, errors: 1 },
      conflicts: [],
      message: `Помилка фази категорій: ${msg}`,
    };
  }
}

interface StockHistoryRow {
  product_id: string;
  old_quantity: number;
  new_quantity: number;
  reason: string;
  source: string;
}

async function runProductsBatch(
  client: SupabaseClient,
  batch: ImportBatchRow,
  deps: ImportDeps
): Promise<BatchOutcome> {
  const zero = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  const cats = batch.payload?.cats ?? [];
  try {
    // ---- feed ----
    const feed = await deps.loadFeedBatch(cats);
    // An all-empty feed for a whole batch is almost always an upstream
    // anomaly (auth drift, ignored cats, changed envelope). Fail the
    // batch so the checkpoint records it and a retry re-fetches —
    // never mark a zero-work batch as 'done'.
    if (feed.length === 0) {
      throw new Error(
        `порожня відповідь фіду для ${cats.length} cats — ймовірна аномалія API`
      );
    }
    const { rows, skipped } = mapFeedProducts(feed);

    // ---- brands: exact normalized link first, create the rest ----
    const ourBrands = await fetchAllRows<ExistingBrandRow>(client, 'brands', 'id,name,slug');
    const brandDisplayByName = new Map<string, string>();
    for (const p of feed) {
      if (p.brand !== null) brandDisplayByName.set(p.brand.toLowerCase().replace(/\s+/g, ' '), p.brand);
    }
    const brandPlan = buildBrandPlan([...brandDisplayByName.values()], ourBrands);
    const brandLinks = new Map(brandPlan.links);
    if (brandPlan.creates.length > 0) {
      const created = await insertChunked(
        client,
        'brands',
        brandPlan.creates.map((b) => ({ name: b.name, slug: b.slug, is_active: true })),
        'id,name'
      );
      for (const row of created) {
        const key = normalizeKeyOf(String(row.name));
        if (typeof row.id === 'string') brandLinks.set(key, row.id);
      }
    }

    // ---- categories map ----
    const ycCats = await fetchAllRows<{ id: string; yugcontract_id: string | null }>(
      client,
      'categories',
      'id,yugcontract_id'
    );
    const catByYc = new Map<string, string>();
    for (const c of ycCats) if (c.yugcontract_id !== null) catByYc.set(c.yugcontract_id, c.id);

    // ---- split against existing products ----
    const ids = rows.map((r) => r.yugcontract_id);
    const existingRows = (
      await Promise.all(
        chunk(ids).map(async (part) => {
          const { data, error } = await client
            .from('products')
            .select('id,yugcontract_id,sku,name,slug,price,old_price,stock_quantity,availability_status,category_id')
            .in('yugcontract_id', part)
            .returns<ExistingProductRowLite[]>();
          if (error) throw new Error(error.message);
          return data ?? [];
        })
      )
    ).flat();
    // sku squatters among manual rows (full row shape: splitProductWrites
    // needs it when the squatter IS a previously imported yc product)
    const skus = rows.map((r) => r.sku);
    const squatRows = (
      await Promise.all(
        chunk(skus).map(async (part) => {
          const { data, error } = await client
            .from('products')
            .select('id,yugcontract_id,sku,name,slug,price,old_price,stock_quantity,availability_status,category_id')
            .in('sku', part)
            .returns<ExistingProductRowLite[]>();
          if (error) throw new Error(error.message);
          return data ?? [];
        })
      )
    ).flat();

    const split = splitProductWrites(rows, [...existingRows, ...squatRows], (row) => ({
      brand_id: row.brandKey !== null ? brandLinks.get(row.brandKey) ?? null : null,
      category_id: row.catYcId !== null ? catByYc.get(row.catYcId) ?? null : null,
    }));

    if (split.hardConflicts.length > 0) {
      const summary = split.hardConflicts.slice(0, 5).join('; ');
      await finishBatch(client, batch.id, 'failed', zero, `конфлікти sku: ${summary}`);
      return {
        phase: 'products',
        batchNo: batch.batch_no,
        status: 'conflict',
        counters: zero,
        conflicts: split.hardConflicts,
        message: `SKU-конфлікти (${split.hardConflicts.length}) — батч зупинено`,
      };
    }

    // ---- writes: inserts, updates, stock history, junction links ----
    let inserted = 0;
    let updatedCount = 0;
    let recategorized = 0;
    let errors = 0;
    const history: StockHistoryRow[] = [];

    for (const part of chunk(split.inserts.map((r) => ({ ...r })))) {
      const done = await insertChunked(client, 'products', part, 'id,yugcontract_id');
      inserted += done.length;
      // Junction rows for the fresh products: exactly one DIRECT link (the
      // resolved YC leaf). Parents are never materialized here.
      const pcRows = done
        .filter((row) => typeof row.id === 'string')
        .map((row) => ({
          product_id: row.id as string,
          category_id:
            part.find((p) => p.yugcontract_id === row.yugcontract_id)?.category_id ?? null,
        }))
        .filter((row): row is { product_id: string; category_id: string } =>
          Boolean(row.category_id)
        );
      if (pcRows.length > 0) {
        await insertChunked(client, 'product_categories', pcRows, 'product_id');
      }
    }

    // Row failures never fail the batch (checkpoint semantics) — the only
    // persistent trace is last_error, so record id + message for the first few.
    const rowErrors = new RowErrorCollector();
    for (const op of split.updates) {
      const { data, error } = await client
        .from('products')
        .update(op.fields)
        .eq('id', op.id)
        .select('id');
      if (error || !data || data.length === 0) {
        errors += 1;
        rowErrors.add(
          `${op.id} (yc ${op.yugcontractId})`,
          error?.message ?? '0 rows updated (товар зник під час батчу?)'
        );
        continue;
      }
      updatedCount += 1;
      if (op.categorySync) {
        // Replace-all semantics for YC rows: upsert first (idempotent on
        // retry), then drop every other direct link of this product.
        const { error: upErr } = await client
          .from('product_categories')
          .upsert(
            { product_id: op.id, category_id: op.categorySync.newCategoryId },
            { onConflict: 'product_id,category_id' }
          );
        if (upErr) {
          errors += 1;
          rowErrors.add(
            `${op.id} (yc ${op.yugcontractId})`,
            `product_categories upsert: ${upErr.message}`
          );
        } else {
          const { error: delErr } = await client
            .from('product_categories')
            .delete()
            .eq('product_id', op.id)
            .neq('category_id', op.categorySync.newCategoryId);
          if (delErr) {
            errors += 1;
            rowErrors.add(
              `${op.id} (yc ${op.yugcontractId})`,
              `product_categories cleanup: ${delErr.message}`
            );
          } else recategorized += 1;
        }
      }
      if (op.stockChanged) {
        history.push({
          product_id: op.id,
          old_quantity: op.oldStock ?? 0,
          new_quantity: op.newStock,
          reason: 'yugcontract_sync',
          source: 'yugcontract',
        });
      }
    }

    if (history.length > 0) {
      await insertChunked(client, 'product_stock_history', history, 'id');
    }

    const counters: BatchCounters = {
      inserted,
      updated: updatedCount,
      skipped: skipped.length + split.unresolvedRefs.length,
      errors,
    };
    await finishBatch(client, batch.id, 'done', counters, rowErrors.toLastError());
    return {
      phase: 'products',
      batchNo: batch.batch_no,
      status: 'done',
      counters,
      conflicts: [],
      message: `Батч ${batch.batch_no}: +${inserted} нових, ${updatedCount} оновлено${
        recategorized > 0 ? `, ${recategorized} рекатегоризовано` : ''
      }, ${counters.skipped} пропущено${split.unresolvedCategoryUpdates.length > 0 ? ` (${split.unresolvedCategoryUpdates.length} без зміни категорії)` : ''}, ${errors} помилок`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishBatch(client, batch.id, 'failed', zero, msg);
    return {
      phase: 'products',
      batchNo: batch.batch_no,
      status: 'failed',
      counters: zero,
      conflicts: [],
      message: `Помилка товарного батча ${batch.batch_no}: ${msg}`,
    };
  }
}

type ExistingProductRowLite = {
  id: string;
  yugcontract_id: string | null;
  sku: string;
  name: string;
  slug: string;
  price: number | null;
  old_price: number | null;
  stock_quantity: number | null;
  availability_status: string | null;
  category_id: string | null;
};

function normalizeKeyOf(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Execute one claimed checkpoint batch end-to-end. Never throws:
 * failures land in the checkpoint so the next invocation can retry.
 */
export async function executeBatch(
  client: SupabaseClient,
  batch: ImportBatchRow,
  deps: ImportDeps
): Promise<BatchOutcome> {
  if (batch.phase === 'categories') return runCategoriesBatch(client, batch, deps);
  return runProductsBatch(client, batch, deps);
}

/**
 * Claim + execute batches until nothing claimable is left or a batch
 * fails/conflicts. Each iteration is a full checkpointed unit, so this
 * loop is safe to interrupt at any moment and resume later.
 */
export async function runUntilDone(
  client: SupabaseClient,
  runId: string,
  deps: ImportDeps,
  onOutcome?: (outcome: BatchOutcome) => void
): Promise<{ stopped: boolean; reason: string | null; outcomes: BatchOutcome[] }> {
  const outcomes: BatchOutcome[] = [];
  for (;;) {
    const batch = await claimNextBatch(client, runId);
    if (batch === null) return { stopped: false, reason: null, outcomes };
    const outcome = await executeBatch(client, batch, deps);
    outcomes.push(outcome);
    onOutcome?.(outcome);
    if (outcome.status !== 'done') {
      return { stopped: true, reason: outcome.message, outcomes };
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-write plan (read-only) — printed before any real import starts.
// ---------------------------------------------------------------------------

export interface ImportPlanSummary {
  categories: { create: number; update: number; conflicts: string[] };
  brands: { linkExisting: number; create: number; nearMatches: { ycBrand: string; ourBrand: string }[] };
  products: { feedRows: number; insert: number; update: number; recategorized: number; skip: number; conflicts: string[] };
  leaves: number;
  productBatches: string[][];
}

/**
 * Read-only plan over the FULL approved feed. Performs SELECTs only —
 * safe to run any number of times before the first real write.
 */
export async function buildFullPlan(
  client: SupabaseClient,
  deps: ImportDeps,
  catsPerBatch = 40
): Promise<ImportPlanSummary> {
  const leaves = await deps.loadLeaves();
  const { nodes } = await deps.loadExpandedTree();

  // categories plan (no writes)
  const existingCats = await fetchAllRows<ExistingCategoryRow>(
    client,
    'categories',
    'id,parent_id,name,slug,yugcontract_id'
  );
  const catPlan = buildCategoryPlan(nodes, new Set((await deps.loadExpandedTree()).expanded.values()), existingCats);

  // full feed, merged in memory as compact mapped rows only
  const seenBatches: string[][] = [];
  const merged = new Map<string, MappedProductRowHolder>();
  let skipCount = 0;
  for (let i = 0; i < leaves.length; i += catsPerBatch) {
    const part = leaves.slice(i, i + catsPerBatch);
    seenBatches.push(part);
    const feed = await deps.loadFeedBatch(part);
    const { rows, skipped } = mapFeedProducts(feed);
    skipCount += skipped.length;
    for (const r of rows) if (!merged.has(r.yugcontract_id)) merged.set(r.yugcontract_id, { row: r });
  }

  // brands plan over distinct normalized feed brand keys
  const allRows = [...merged.values()].map((h) => h.row);
  const brandKeys = [...new Set(allRows.map((r) => r.brandKey).filter((v): v is string => v !== null))];
  const ourBrands = await fetchAllRows<ExistingBrandRow>(client, 'brands', 'id,name,slug');
  const brandPlan = buildBrandPlan(brandKeys, ourBrands);

  // products split vs existing rows
  const ycIds = allRows.map((r) => r.yugcontract_id);
  const existingProducts = (
    await Promise.all(
      chunk(ycIds).map(async (part) => {
        const { data, error } = await client
          .from('products')
          .select('id,yugcontract_id,sku,name,slug,price,old_price,stock_quantity,availability_status,category_id')
          .in('yugcontract_id', part)
          .returns<ExistingProductRowLite[]>();
        if (error) throw new Error(error.message);
        return data ?? [];
      })
    )
  ).flat();
  const skus = allRows.map((r) => r.sku);
  const squats = (
    await Promise.all(
      chunk(skus).map(async (part) => {
        const { data, error } = await client
          .from('products')
          .select('id,yugcontract_id,sku,name,slug,price,old_price,stock_quantity,availability_status,category_id')
          .in('sku', part)
          .returns<ExistingProductRowLite[]>();
        if (error) throw new Error(error.message);
        return data ?? [];
      })
    )
  ).flat();

  const catByYc = new Map<string, string>();
  for (const c of existingCats) {
    if (c.yugcontract_id !== null) catByYc.set(c.yugcontract_id, c.id);
  }
  // The plan must reflect the state AFTER the phases run in order:
  // categories created by phase 1 satisfy product references even though
  // they are not persisted yet ('(план)' placeholder uuids).
  for (const c of catPlan.creates) if (!catByYc.has(c.yugcontract_id)) catByYc.set(c.yugcontract_id, '(план)');
  const brandLinks = new Map([...brandPlan.links.entries()]);
  for (const c of brandPlan.creates) brandLinks.set(c.name.toLowerCase().replace(/\s+/g, ' '), '(новий)');
  const split = splitProductWrites(allRows, [...existingProducts, ...squats], (row) => ({
    brand_id: row.brandKey !== null ? brandLinks.get(row.brandKey) ?? null : null,
    category_id: row.catYcId !== null ? catByYc.get(row.catYcId) ?? null : null,
  }));

  return {
    categories: {
      create: catPlan.creates.length,
      update: catPlan.updates.length,
      conflicts: catPlan.conflicts,
    },
    brands: {
      linkExisting: brandPlan.links.size,
      create: brandPlan.creates.length,
      nearMatches: brandPlan.nearMatches,
    },
    products: {
      feedRows: allRows.length,
      insert: split.inserts.length,
      update: split.updates.length,
      recategorized: split.updates.filter((u) => u.categorySync !== undefined).length,
      skip:
        skipCount +
        split.unresolvedRefs.length +
        split.unresolvedCategoryUpdates.length,
      conflicts: split.hardConflicts,
    },
    leaves: leaves.length,
    productBatches: seenBatches,
  };
}

interface MappedProductRowHolder {
  row: MappedProductRow;
}
