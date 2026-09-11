// Explicit .ts extension on value imports: required by node:test ESM
// resolution and allowed by allowImportingTsExtensions for the Next bundler.
import { isImportableExternalImageUrl } from './content-staging.ts';

/**
 * Pure planner for the IMAGES hotlink phase (yc_content_batches
 * phase='images'). No I/O — fully unit-testable. The CLI/executor owns
 * all reads/writes.
 *
 * Identity & idempotency (no schema change):
 *   identity of an imported image = (product_id, image_url).
 *   There is NO unique index on it — reconciliation is diff-aware at the
 *   executor level (single-runner assumption, same as price import).
 *
 * Imported vs manual discrimination WITHOUT schema change:
 *   - manual rows are ALWAYS relative Storage paths ("products/<uuid>/…",
 *     the admin upload route never stores absolute URLs);
 *   - therefore a row whose image_url is an absolute http(s) URL on the
 *     supplier host can ONLY have been created by this importer and is
 *     the ONLY kind of row this phase may ever modify or report stale.
 *
 * Ordering semantics — STICKY (churn fix 2026-09-11):
 *   - at most ONE is_main=true per product (partial unique index enforces);
 *   - gallery order = sort_order ASC.
 *   ROOT CAUSE this encodes: the supplier feed returns pictures[] in an
 *   UNSTABLE order between API calls (measured by scripts/images-churn.mts:
 *   every sync rewrote ~1836/5200 products). The previous planner derived
 *   the canonical state from the feed index (sort_order = offset + index,
 *   is_main = index === 0), so every feed shuffle was misread as a real
 *   reorder → wholesale UPDATE churn at zero actual change.
 *   DECISION: the DB order is "sticky" — the feed position of ALREADY
 *   IMPORTED urls is ignored entirely. Specifically:
 *     1. desired URL set == existing imported set AND the row holding
 *        is_main=true keeps its URL → ZERO write ops (DB order preserved);
 *     2. new URLs are INSERTed AFTER max(existing sort_order) in feed
 *        order (appended, existing rows never renumbered);
 *     3. main is a property of the URL, not of position: it changes only
 *        when the current main URL disappears from the feed (next-in-line
 *        by EXISTING gallery order is promoted, demote-before-promote per
 *        F12) or the slot is vacant (first new URL / first existing row);
 *     4. sort_order of existing rows is NEVER written.
 *   Fresh products (zero existing images) keep the original spec:
 *   staging.pictures[0] → sort_order 0 + is_main=true, rest by index.
 *   Foreign (manual) images and their main slot remain untouchable;
 *   imported pictures land after max(foreign sort_order), all is_main=false
 *   when a foreign main exists.
 *
 * Deletions: NOT implemented (v1). Rows imported earlier but missing
 * from current staging.pictures are reported as staleImported so the
 * operator can decide; manual rows are structurally unreachable.
 */

export interface ProductImageRow {
  id: string;
  product_id: string;
  image_url: string;
  alt: string | null;
  sort_order: number | null;
  is_main: boolean | null;
}

/** True only for absolute supplier-host URLs (i.e. importer-owned rows). */
export function isExternalImportedImage(imageUrl: string): boolean {
  return isImportableExternalImageUrl(imageUrl).ok;
}

/** Re-validation guard: staging JSONB is trusted but never blindly. */
export function revalidateStagedPictures(
  rawPictures: unknown
): { urls: string[]; rejected: number } {
  if (!Array.isArray(rawPictures)) return { urls: [], rejected: 0 };
  const urls: string[] = [];
  let rejected = 0;
  for (const entry of rawPictures) {
    if (typeof entry !== 'string') {
      rejected += 1;
      continue;
    }
    if (isImportableExternalImageUrl(entry).ok) urls.push(entry);
    else rejected += 1;
  }
  return { urls, rejected };
}

export interface ImageInsertOp {
  product_id: string;
  image_url: string;
  alt: null;
  sort_order: number;
  is_main: boolean;
}

export interface ImageUpdateOp {
  id: string;
  product_id: string;
  /** ONLY sort_order/is_main keys — guarded by assertImageUpdateFields */
  fields: { sort_order?: number; is_main?: boolean };
}

export interface ImagePlanInputProduct {
  dbId: string;
  yugcontractId: string;
}

export interface ImagePlan {
  inserts: ImageInsertOp[];
  updates: ImageUpdateOp[];
  noops: number;
  /** matched staged goods whose validated pictures list is empty */
  productsWithoutPictures: number;
  /** staged ids with no matching product row */
  unmatchedStaged: number;
  /**
   * importer-owned rows no longer present in staging (v1 never DELETES).
   * F12 refinement: a stale row holding is_main=true additionally gets a
   * flag-only demote UPDATE (it appears in `updates` too), because the
   * partial unique main-per-product index would otherwise reject the new
   * main with 23505.
   */
  staleImported: { id: string; product_id: string; image_url: string }[];
  /** existing rows per product summary for reporting */
  productsWithManualImages: number;
  /** products where a manual image holds is_main → imports stay non-main */
  manualMainPreserved: number;
}

/** Guard applied before every client.update() in the executor. */
const IMAGE_UPDATE_FIELDS = new Set(['sort_order', 'is_main']);
export function assertImageUpdateFields(fields: Record<string, unknown>): void {
  for (const key of Object.keys(fields)) {
    if (!IMAGE_UPDATE_FIELDS.has(key)) {
      throw new Error(`images import спробував оновити заборонене поле ${key}`);
    }
  }
}

export function planImageOps(
  products: readonly ImagePlanInputProduct[],
  stagedPicturesByYcId: ReadonlyMap<string, string[]>,
  existingImages: readonly ProductImageRow[]
): ImagePlan {
  const existingByProduct = new Map<string, ProductImageRow[]>();
  for (const row of existingImages) {
    const list = existingByProduct.get(row.product_id) ?? [];
    list.push(row);
    existingByProduct.set(row.product_id, list);
  }

  const inserts: ImageInsertOp[] = [];
  const updates: ImageUpdateOp[] = [];
  let noops = 0;
  let productsWithoutPictures = 0;
  // Staged goods ids with no matching product row in THIS plan input —
  // real data for the skipped-counters report (was a hardcoded 0).
  let unmatchedStaged = 0;
  const staleImported: ImagePlan['staleImported'] = [];
  let productsWithManualImages = 0;
  let manualMainPreserved = 0;

  const plannedYcIds = new Set(products.map((p) => p.yugcontractId));
  for (const stagedId of stagedPicturesByYcId.keys()) {
    if (!plannedYcIds.has(stagedId)) unmatchedStaged += 1;
  }

  for (const product of products) {
    const desired = stagedPicturesByYcId.get(product.yugcontractId);
    if (desired === undefined) {
      // not in staging at all (shouldn't happen: batches built from staging)
      continue;
    }

    const existingRows = existingByProduct.get(product.dbId) ?? [];
    // Foreign = anything this importer does not own (manual Storage paths).
    // Their gallery position and main flag are untouchable.
    const foreignRows = existingRows.filter((r) => !isExternalImportedImage(r.image_url));
    const existingImported = existingRows.filter((r) => isExternalImportedImage(r.image_url));
    if (foreignRows.length > 0) productsWithManualImages += 1;

    if (desired.length === 0) {
      productsWithoutPictures += 1;
      continue;
    }

    const foreignHasMain = foreignRows.some((r) => r.is_main === true);
    if (foreignHasMain) manualMainPreserved += 1;

    // STICKY, order-insensitive diff (see "Ordering semantics" above).
    // Feed duplicates collapse via Set (identity = (product_id, image_url)).
    const desiredUrls = [...new Set(desired)];
    const desiredSet = new Set(desiredUrls);
    const existingByUrl = new Map(existingImported.map((r) => [r.image_url, r]));

    const remainingRows: ProductImageRow[] = []; // url still in the feed
    const newUrls: string[] = []; // feed order preserved for appends
    for (const url of desiredUrls) {
      const row = existingByUrl.get(url);
      if (row) remainingRows.push(row);
      else newUrls.push(url);
    }

    // Main is a property of the URL, not of feed position: the row holding
    // is_main=true keeps the main slot for as long as its URL is in the
    // feed (≤1 main per product is guaranteed by the partial unique index;
    // a foreign main always wins and imported rows never claim it).
    const currentMain = existingImported.find((r) => r.is_main === true) ?? null;

    // Promotion only when the main is gone from the feed or the slot is
    // vacant: next-in-line by the EXISTING gallery order (sticky — never a
    // positional flip-flop), else the first newly inserted URL. Never next
    // to a foreign (manual) main.
    let promoteRow: ProductImageRow | null = null;
    let promoteNewUrl: string | null = null;
    if (!foreignHasMain) {
      const mainPersists = currentMain !== null && desiredSet.has(currentMain.image_url);
      if (!mainPersists) {
        promoteRow =
          [...remainingRows].sort(
            (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id)
          )[0] ?? null;
        if (!promoteRow) promoteNewUrl = newUrls[0] ?? null;
      }
    }

    // INSERT missing URLs AFTER max(existing sort_order) — appended at the
    // end; existing rows are never renumbered. Fresh product (no rows at
    // all): feed order 0..n-1, first URL is main — the original spec.
    const maxExistingSort = [...foreignRows, ...existingImported].reduce(
      (m, r) => Math.max(m, r.sort_order ?? 0),
      0
    );
    let nextSort = existingRows.length > 0 ? maxExistingSort + 1 : 0;
    for (const url of newUrls) {
      inserts.push({
        product_id: product.dbId,
        image_url: url,
        alt: null,
        sort_order: nextSort,
        is_main: url === promoteNewUrl,
      });
      nextSort += 1;
    }

    // Existing rows: NO sort_order writes, ever. The only update emitted
    // here is a main promotion (main-URL replacement or zero-main repair).
    for (const row of remainingRows) {
      if (promoteRow?.id === row.id && row.is_main !== true) {
        updates.push({ id: row.id, product_id: row.product_id, fields: { is_main: true } });
      } else {
        noops += 1;
      }
    }

    // D) stale imported rows: owned by us but absent from current
    // staging.pictures. REPORT ONLY — deletion is intentionally NOT
    // implemented in v1. EXCEPTION (F12): a stale row holding the main
    // flag would make the DB reject the new main with 23505 (partial
    // unique (product_id) WHERE is_main = TRUE), so it receives a
    // flag-only demote below. It is still never deleted and still
    // reported here.
    for (const row of existingImported) {
      if (!desiredSet.has(row.image_url)) {
        staleImported.push({ id: row.id, product_id: row.product_id, image_url: row.image_url });
        if (row.is_main === true) {
          // Clears an orphaned main so the canonical main can be promoted.
          // Safe under a foreign main too: two mains would already be an
          // anomaly, and this restores the ≤1-main invariant.
          updates.push({
            id: row.id,
            product_id: row.product_id,
            fields: { is_main: false },
          });
        }
      }
    }
  }

  // Execution-order invariant (F12): the database enforces ≤1 main per
  // product via a PARTIAL UNIQUE index on (product_id) WHERE is_main =
  // TRUE. The executor applies updates strictly sequentially, so the plan
  // itself must emit every demote (is_main → false) BEFORE any promote
  // (is_main → true); otherwise a reorder of an already-imported set
  // fails mid-batch with 23505. Stable three-phase partition preserves
  // the deterministic per-product order while guaranteeing demote-first.
  // A transient zero-main window between phases is legal (the unique
  // index forbids >1, not 0) and lasts only for the remaining statements
  // of this batch.
  const demotes = updates.filter((u) => u.fields.is_main === false);
  const neutral = updates.filter((u) => u.fields.is_main === undefined);
  const promotes = updates.filter((u) => u.fields.is_main === true);

  return {
    inserts,
    updates: [...demotes, ...neutral, ...promotes],
    noops,
    productsWithoutPictures,
    unmatchedStaged,
    staleImported,
    productsWithManualImages,
    manualMainPreserved,
  };
}
