// Explicit .ts extension on value imports: required by node:test ESM
// resolution and allowed by allowImportingTsExtensions for the Next bundler.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  coerceStagedRow,
  buildSpecificationJson,
  type StagedContentRow,
} from './content-staging.ts';
import {
  planImageOps,
  assertImageUpdateFields,
  revalidateStagedPictures,
  type ProductImageRow,
} from './content-images.ts';
import { RowErrorCollector } from './row-errors.ts';
import { duBaseIdOf, DU_BASE_TO_DU } from './content-du-mapping.ts';

/**
 * Content import executor (stage 3) — description + specifications.
 *
 * Deliberately SEPARATE from the price importer (import-run.ts): its own
 * checkpoint table (yc_content_batches), its own phases, zero shared
 * write paths. The ONLY columns this module may ever write are
 * products.description and products.specifications — enforced here by
 * assertContentFields() at the single update choke point and by tests.
 *
 * Invariants:
 *  - identity = yugcontract_id (staging PK = our products.yugcontract_id
 *    join key); manual products without a yugcontract_id are structurally
 *    unreachable;
 *  - diff-aware: identical values produce NO write, so re-running over
 *    already-updated data is a no-op;
 *  - resumable: one checkpoint row per (run, phase, batch); crashed
 *    'running' batches become retryable after STALE_RUNNING_MS;
 *  - every write is derived from staging rows only — get-content-goods is
 *    never called here;
 *  - markup-only empty HTML shell descriptions are NEVER written
 *    (isEmptyHtmlShell dynamic guard); the static excludeDescriptionIds
 *    list remains as a legacy extra barrier only.
 */

export const CONTENT_BATCH_SIZE = 200;
export const CONTENT_STALE_RUNNING_MS = 10 * 60 * 1000;

/** Columns the content pipeline may EVER touch. Nothing else. */
const WRITABLE_FIELDS = new Set(['description', 'specifications']);

/**
 * True when a supplier description carries NO real text after safe tag/entity
 * stripping: markup-only HTML shells like `<div><div><div></div></div></div>`,
 * `<p>&nbsp;</p>` or pure whitespace. Conservative by design — anything that
 * retains a single non-whitespace character (including entities that decode to
 * punctuation, e.g. `&amp;`) is treated as real text and still imports.
 *
 * This is the DYNAMIC guard that keeps new empty-shell supplier ids out of
 * products.description without maintaining a static id list (2026-09-02:
 * ids 7202243 / 7270047 slipped past the static list). EXCLUDE_EMPTY_HTML_DESC_IDS
 * in scripts/yugcontract-content-apply.ts stays as a belt-and-suspenders
 * barrier for historical ids but is no longer required for detection.
 */
export function isEmptyHtmlShell(html: string): boolean {
  return (
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#160;|&#x0*a0;/gi, ' ')
      .trim() === ''
  );
}

/** Defense-in-depth guard applied before every client.update(). */
export function assertContentFields(fields: Record<string, unknown>): void {
  for (const key of Object.keys(fields)) {
    if (!WRITABLE_FIELDS.has(key)) {
      throw new Error(
        `content import спробував записати заборонене поле products.${key}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pure planning (unit-testable)
// ---------------------------------------------------------------------------

export interface ContentProductRow {
  id: string;
  yugcontract_id: string | null;
  description: string | null;
  specifications: unknown;
}

export interface ContentUpdateOp {
  productDbId: string;
  yugcontractId: string;
  /** ONLY description/specifications keys — guarded by assertContentFields */
  fields: { description?: string; specifications?: { name: string; value: string }[] };
  currentHadDescription: boolean;
}

export interface ContentPlan {
  updates: ContentUpdateOp[];
  /** staged row matched a product but nothing differs */
  identical: number;
  /** no product with that yugcontract_id (staged beyond assortment) */
  unmatchedStaged: number;
  /** staged description empty/absent */
  noDescriptionAvailable: number;
  /** subset of updates where a NON-empty local description gets replaced */
  overwriteNonEmptyCount: number;
  /** matched rows whose staged description existed but was suppressed (excludeDescriptionIds) */
  excludedDescription: number;
  /** matched rows whose staged description is a markup-only empty HTML shell (dynamic guard) */
  emptyShellDescription: number;
}

function specsDiffer(
  existing: unknown,
  next: readonly { name: string; value: string }[]
): boolean {
  // No stable canonical form exists yet; supplier order IS the contract
  // (array format decision), so plain JSON comparison is correct here.
  return JSON.stringify(existing) !== JSON.stringify(next);
}

export function planContentUpdates(
  staged: readonly StagedContentRow[],
  products: readonly ContentProductRow[],
  options: {
    includeSpecifications?: boolean;
    /**
     * yugcontract_ids whose staged `description` must NOT be written, even
     * when one exists (used by content-apply to skip text-empty supplier
     * HTML shells). Specifications for these ids still flow normally.
     * Defaults to undefined → no behaviour change for existing callers.
     */
    excludeDescriptionIds?: ReadonlySet<string>;
  } = {}
): ContentPlan {
  const includeSpecifications = options.includeSpecifications ?? true;
  const excludeDesc = options.excludeDescriptionIds ?? new Set<string>();
  const byYcId = new Map(products.map((p) => [p.yugcontract_id ?? '', p]));

  // `_du` products (Task #19/#20): their content lives under the BASE
  // Yugcontract id, so each allowlisted `_du` product is planned from its
  // base staged row. Allowlist-only (fail-closed): a `_du` id absent from
  // content-du-mapping.ts is planned like any regular product (i.e. only
  // from its own exact staged row, which never exists in practice).
  // Shadow rule: if a staged row exists for the `_du` id ITSELF, the du
  // product is planned through that exact row and the base mapping for it
  // is suppressed (never planned twice).
  const stagedIds = new Set(staged.map((s) => s.yugcontract_id));
  const duByBase = new Map<string, ContentProductRow[]>();
  for (const p of products) {
    const base = duBaseIdOf(p.yugcontract_id);
    if (base === null) continue;
    if (p.yugcontract_id !== null && stagedIds.has(p.yugcontract_id)) continue;
    const list = duByBase.get(base) ?? [];
    list.push(p);
    duByBase.set(base, list);
  }

  const updates: ContentUpdateOp[] = [];
  let identical = 0;
  let unmatchedStaged = 0;
  let noDescriptionAvailable = 0;
  let overwriteNonEmptyCount = 0;
  let excludedDescription = 0;
  let emptyShellDescription = 0;

  for (const s of staged) {
    const targets: {
      product: ContentProductRow;
      ycId: string;
      duBase: string | null;
    }[] = [];
    const exact = byYcId.get(s.yugcontract_id);
    if (exact) {
      targets.push({ product: exact, ycId: s.yugcontract_id, duBase: null });
    }
    for (const du of duByBase.get(s.yugcontract_id) ?? []) {
      if (du.yugcontract_id === null || stagedIds.has(du.yugcontract_id)) continue;
      targets.push({ product: du, ycId: du.yugcontract_id, duBase: s.yugcontract_id });
    }

    if (targets.length === 0) {
      unmatchedStaged += 1;
      continue;
    }

    for (const { product, ycId, duBase } of targets) {
      const fields: ContentUpdateOp['fields'] = {};

      const rawStagedDesc = s.description !== null && s.description.trim() !== '' ? s.description : null;
      // Dynamic empty-shell guard (2026-09-02): markup-only supplier HTML
      // (no real text after tag/entity stripping) is treated like an absent
      // description — never written, existing content never blanked out.
      // Specifications below still flow normally for such rows.
      const stagedDesc = rawStagedDesc !== null && !isEmptyHtmlShell(rawStagedDesc) ? rawStagedDesc : null;
      const currentDesc = product.description !== null && product.description.trim() !== '' ? product.description : null;
      // Excluded ids: never emit a description, but still allow specs below.
      // A `_du` product inherits the exclusion of its base id.
      const skipDesc =
        excludeDesc.has(s.yugcontract_id) ||
        excludeDesc.has(ycId) ||
        (duBase !== null && excludeDesc.has(duBase));

      // Disjoint counters: identical = matched row with NOTHING to write;
      // noDescriptionAvailable = matched row whose staged description is
      // absent/empty (and nothing else differed).
      if (
        includeSpecifications &&
        s.params.length > 0 &&
        specsDiffer(product.specifications, buildSpecificationJson(s.params))
      ) {
        fields.specifications = buildSpecificationJson(s.params);
      }

      if (rawStagedDesc !== null && stagedDesc === null) {
        // dynamic empty-shell guard: counted for observability, never written
        // (checked FIRST — primary detection; the static list is legacy)
        emptyShellDescription += 1;
      } else if (skipDesc) {
        if (stagedDesc !== null) excludedDescription += 1;
      } else if (stagedDesc === null) {
        // keep existing description untouched (never blank out content)
      } else if (currentDesc !== null && currentDesc === stagedDesc.trim()) {
        // equal — nothing to write for description
      } else {
        fields.description = stagedDesc;
        if (currentDesc !== null) overwriteNonEmptyCount += 1;
      }

      if (Object.keys(fields).length === 0) {
        if (stagedDesc === null) noDescriptionAvailable += 1;
        else identical += 1;
        continue;
      }

      updates.push({
        productDbId: product.id,
        // the op always carries the TARGET product's own yugcontract_id —
        // the executor guard is .eq('id', …).eq('yugcontract_id', …)
        yugcontractId: ycId,
        fields,
        currentHadDescription: currentDesc !== null,
      });
    }
  }

  return { updates, identical, unmatchedStaged, noDescriptionAvailable, overwriteNonEmptyCount, excludedDescription, emptyShellDescription };
}

export interface PlannedBatch {
  batchNo: number;
  ids: string[];
}

/** Deterministic chunks over sorted staged ids. */
export function planContentBatches(
  stagedIds: readonly string[],
  size = CONTENT_BATCH_SIZE
): PlannedBatch[] {
  const sorted = [...stagedIds].sort();
  const batches: PlannedBatch[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    batches.push({ batchNo: batches.length + 1, ids: sorted.slice(i, i + size) });
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Checkpoint CRUD (yc_content_batches) — mirrors import-run.ts patterns
// ---------------------------------------------------------------------------

export interface ContentBatchRow {
  id: string;
  run_id: string;
  phase: 'description' | 'images';
  batch_no: number;
  payload: { ids?: string[] } | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  processed_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

async function selectContentBatches(
  client: SupabaseClient,
  runId: string
): Promise<ContentBatchRow[]> {
  // Paged defensively (see selectBatches in import-run.ts).
  const rows: ContentBatchRow[] = [];
  let from = 0;
  for (;;) {
    const PAGE = 1000;
    const { data, error } = await client
      .from('yc_content_batches')
      .select('*')
      .eq('run_id', runId)
      .order('phase', { ascending: true })
      .order('batch_no', { ascending: true })
      .range(from, from + PAGE - 1)
      .returns<ContentBatchRow[]>();
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return rows;
    from += PAGE;
  }
}

export async function ensureContentRun(
  client: SupabaseClient,
  runId: string,
  planned: { phase: 'description' | 'images'; batchNo: number; payload?: { ids?: string[] } }[]
): Promise<ContentBatchRow[]> {
  const existing = await selectContentBatches(client, runId);
  const key = (phase: string, no: number) => `${phase}:${no}`;
  const known = new Set(existing.map((b) => key(b.phase, b.batch_no)));
  const missing = planned.filter((p) => !known.has(key(p.phase, p.batchNo)));
  if (missing.length > 0) {
    const { error } = await client.from('yc_content_batches').insert(
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
  return selectContentBatches(client, runId);
}

export async function claimNextContentBatch(
  client: SupabaseClient,
  runId: string
): Promise<ContentBatchRow | null> {
  const rows = await selectContentBatches(client, runId);
  if (rows.length === 0) return null;

  const now = Date.now();
  const claimable = rows.filter((b) => {
    if (b.status === 'done') return false;
    if (b.status === 'pending' || b.status === 'failed') return true;
    if (b.status === 'running') {
      const startedAt = Date.parse(b.started_at ?? '');
      return (
        Number.isFinite(startedAt) && now - startedAt > CONTENT_STALE_RUNNING_MS
      );
    }
    return false;
  });
  // Atomic compare-and-swap (see claimNextBatch in import-run.ts): the
  // claim UPDATE only lands while the batch is still in the state we saw;
  // an empty .select('id') means another runner won — try the next candidate.
  for (const next of claimable) {
    let cas = client
      .from('yc_content_batches')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', next.id)
      .eq('status', next.status);
    if (next.status === 'running') {
      cas = cas.eq('started_at', next.started_at ?? '');
    }
    const { data, error } = await cas.select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) continue;
    return { ...next, status: 'running' };
  }
  return null;
}

async function finishContentBatch(
  client: SupabaseClient,
  batchId: string,
  status: 'done' | 'failed',
  counters: { updated: number; skipped: number; errors: number },
  lastError: string | null
): Promise<void> {
  const { error } = await client
    .from('yc_content_batches')
    .update({
      status,
      processed_count: counters.updated + counters.skipped + counters.errors,
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
// Execution
// ---------------------------------------------------------------------------

export async function loadStagedRows(
  client: SupabaseClient,
  ids: readonly string[]
): Promise<StagedContentRow[]> {
  const out: StagedContentRow[] = [];
  for (let i = 0; i < ids.length; i += CONTENT_BATCH_SIZE) {
    const part = ids.slice(i, i + CONTENT_BATCH_SIZE);
    const { data, error } = await client
      .from('yc_content_goods')
      .select('yugcontract_id,category_id,name,description,pictures,params')
      .in('yugcontract_id', part);
    if (error) throw new Error(error.message);
    for (const raw of data ?? []) {
      const row = coerceStagedRow(raw as Record<string, unknown>);
      if (row) out.push(row);
    }
  }
  return out;
}

/**
 * Pure expansion of staged (base) ids into the full product query set:
 * every id plus all allowlisted `_du` product ids that derive their
 * content from it. Unit-tested — the executor/CLI behaviour relies on it.
 */
export function contentProductQueryIds(ycIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ycIds) {
    out.add(id);
    for (const du of DU_BASE_TO_DU.get(id) ?? []) out.add(du);
  }
  return [...out];
}

export async function loadOurProductsForContent(
  client: SupabaseClient,
  ycIds: readonly string[]
): Promise<ContentProductRow[]> {
  const out: ContentProductRow[] = [];
  for (let i = 0; i < ycIds.length; i += CONTENT_BATCH_SIZE) {
    const part = contentProductQueryIds(ycIds.slice(i, i + CONTENT_BATCH_SIZE));
    const { data, error } = await client
      .from('products')
      .select('id,yugcontract_id,description,specifications')
      .in('yugcontract_id', part)
      .returns<ContentProductRow[]>();
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Images phase (hotlink): product_images rows with external supplier URLs
// ---------------------------------------------------------------------------

async function loadProductImagesFor(
  client: SupabaseClient,
  productDbIds: readonly string[]
): Promise<ProductImageRow[]> {
  const out: ProductImageRow[] = [];
  for (let i = 0; i < productDbIds.length; i += CONTENT_BATCH_SIZE) {
    const part = productDbIds.slice(i, i + CONTENT_BATCH_SIZE);
    // 200 products can hold FAR more than 1000 images; PostgREST caps any
    // single response at 1000 rows unless explicitly paged → paginate.
    let from = 0;
    for (;;) {
      const PAGE = 1000;
      const { data, error } = await client
        .from('product_images')
        .select('id,product_id,image_url,alt,sort_order,is_main')
        .in('product_id', part)
        // Stable multi-page windows: PostgREST caps any response at 1000
        // rows, and OFFSET paging without ORDER BY returns overlapping /
        // gapped windows (observed live: 72 dups + 73 missed rows on a
        // 23848-row read). 'id' is a unique stable key.
        .order('id')
        .range(from, from + PAGE - 1)
        .returns<ProductImageRow[]>();
      if (error) throw new Error(error.message);
      out.push(...(data ?? []));
      if ((data ?? []).length < PAGE) break;
      from += PAGE;
    }
  }
  return out;
}

export async function executeImagesBatch(
  client: SupabaseClient,
  batch: ContentBatchRow
): Promise<ContentBatchOutcome> {
  const zero = { updated: 0, skipped: 0, errors: 0 };
  const ids = batch.payload?.ids ?? [];
  try {
    // ids here are yc_content_goods.yugcontract_id values
    const staged = await loadStagedRows(client, ids);
    const products = await loadOurProductsForContent(client, ids);
    const dbIdByYc = new Map(products.map((p) => [p.yugcontract_id ?? '', p.id]));
    const planInput = [...dbIdByYc.entries()].map(([yugcontractId, dbId]) => ({
      dbId,
      yugcontractId,
    }));
    const stagedPictures = new Map<string, string[]>();
    let revalidatedOut = 0;
    for (const row of staged) {
      // NEVER trust staging JSONB blindly — revalidate on the way out.
      const { urls, rejected } = revalidateStagedPictures(row.pictures as unknown);
      revalidatedOut += rejected;
      stagedPictures.set(row.yugcontract_id, urls);
    }

    const existingImages = await loadProductImagesFor(client, [...dbIdByYc.values()]);
    const plan = planImageOps(planInput, stagedPictures, existingImages);

    // Row failures never fail the batch here either — status stays
    // `errors > 0 ? 'failed' : 'done'`; diagnostics go to last_error.
    const rowErrors = new RowErrorCollector();
    let updated = 0;
    let errors = 0;
    for (const op of plan.updates) {
      assertImageUpdateFields(op.fields);
      const { data, error } = await client
        .from('product_images')
        .update(op.fields)
        .eq('id', op.id)
        .eq('product_id', op.product_id)
        .select('id');
      if (error || !data || data.length === 0) {
        errors += 1;
        rowErrors.add(
          `img ${op.id} (product ${op.product_id})`,
          error?.message ?? '0 rows updated (зображення зникло під час батчу?)'
        );
        continue;
      }
      updated += 1;
    }

    for (let i = 0; i < plan.inserts.length; i += CONTENT_BATCH_SIZE) {
      const part = plan.inserts.slice(i, i + CONTENT_BATCH_SIZE);
      const { error } = await client.from('product_images').insert(part);
      if (error) throw new Error(`product_images insert: ${error.message}`);
    }

    if (revalidatedOut > 0) {
      console.warn(`images: ${revalidatedOut} невалідних URL у staging відхилено повторно`);
    }

    const counters = {
      updated: updated + plan.inserts.length,
      skipped:
        plan.noops +
        plan.productsWithoutPictures +
        plan.unmatchedStaged +
        plan.staleImported.length,
      errors,
    };
    await finishContentBatch(
      client,
      batch.id,
      errors > 0 ? 'failed' : 'done',
      counters,
      rowErrors.toLastError()
    );
    return {
      phase: 'images',
      batchNo: batch.batch_no,
      status: errors > 0 ? 'failed' : 'done',
      counters,
      message: `Images-батч ${batch.batch_no}: +${plan.inserts.length} вставок, ${updated} оновлень, ${counters.skipped} пропущено, ${errors} помилок`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishContentBatch(client, batch.id, 'failed', zero, msg);
    return {
      phase: 'images',
      batchNo: batch.batch_no,
      status: 'failed',
      counters: zero,
      message: `Помилка images-батча ${batch.batch_no}: ${msg}`,
    };
  }
}

export interface ContentBatchOutcome {
  phase: 'description' | 'images';
  batchNo: number;
  status: 'done' | 'failed';
  counters: { updated: number; skipped: number; errors: number };
  message: string;
}

export async function executeDescriptionBatch(
  client: SupabaseClient,
  batch: ContentBatchRow,
  options: { excludeDescriptionIds?: ReadonlySet<string> } = {}
): Promise<ContentBatchOutcome> {
  const zero = { updated: 0, skipped: 0, errors: 0 };
  const ids = batch.payload?.ids ?? [];
  try {
    const staged = await loadStagedRows(client, ids);
    const products = await loadOurProductsForContent(client, ids);
    const plan = planContentUpdates(staged, products, {
      excludeDescriptionIds: options.excludeDescriptionIds,
    });

    const rowErrors = new RowErrorCollector();
    let updated = 0;
    let errors = 0;
    for (const op of plan.updates) {
      assertContentFields(op.fields);
      const { data, error } = await client
        .from('products')
        .update(op.fields)
        .eq('id', op.productDbId)
        .eq('yugcontract_id', op.yugcontractId)
        .select('id');
      if (error || !data || data.length === 0) {
        errors += 1;
        rowErrors.add(
          `${op.yugcontractId} (product ${op.productDbId})`,
          error?.message ?? '0 rows updated (товар зник під час батчу?)'
        );
        continue;
      }
      updated += 1;
    }

    const counters = {
      updated,
      skipped:
        plan.identical + plan.noDescriptionAvailable + plan.unmatchedStaged,
      errors,
    };
    await finishContentBatch(
      client,
      batch.id,
      errors > 0 ? 'failed' : 'done',
      counters,
      rowErrors.toLastError()
    );
    return {
      phase: 'description',
      batchNo: batch.batch_no,
      status: errors > 0 ? 'failed' : 'done',
      counters,
      message: `Контент-батч ${batch.batch_no}: ${updated} оновлено, ${counters.skipped} пропущено, ${errors} помилок`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishContentBatch(client, batch.id, 'failed', zero, msg);
    return {
      phase: 'description',
      batchNo: batch.batch_no,
      status: 'failed',
      counters: zero,
      message: `Помилка контент-батча ${batch.batch_no}: ${msg}`,
    };
  }
}

export async function runContentUntilDone(
  client: SupabaseClient,
  runId: string,
  onOutcome?: (outcome: ContentBatchOutcome) => void,
  options: { excludeDescriptionIds?: ReadonlySet<string> } = {}
): Promise<{ stopped: boolean; reason: string | null; outcomes: ContentBatchOutcome[] }> {
  const outcomes: ContentBatchOutcome[] = [];
  for (;;) {
    const batch = await claimNextContentBatch(client, runId);
    if (batch === null) return { stopped: false, reason: null, outcomes };
    // Phase dispatch. Both executors are idempotent and checkpointed.
    const outcome =
      batch.phase === 'images'
        ? await executeImagesBatch(client, batch)
        : await executeDescriptionBatch(client, batch, {
            excludeDescriptionIds: options.excludeDescriptionIds,
          });
    outcomes.push(outcome);
    onOutcome?.(outcome);
    if (outcome.status !== 'done') {
      return { stopped: true, reason: outcome.message, outcomes };
    }
  }
}
