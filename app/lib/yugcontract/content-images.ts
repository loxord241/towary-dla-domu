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
 * Ordering semantics (matches project invariants):
 *   - at most ONE is_main=true per product (admin UI enforces this);
 *   - gallery order = sort_order ASC.
 *   Fresh products (zero existing images): staging.pictures[0] gets
 *   sort_order 0 + is_main=true, rest follow by index — exactly the spec.
 *   Products that already HAVE any image (manual main included): their
 *   existing main is NEVER touched; imported pictures are appended AFTER
 *   max(existing sort_order), ALL is_main=false — two mains would break
 *   storefront main-image resolution, and demoting a manual main is out
 *   of scope without an explicit business decision.
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
  const unmatchedStaged = 0;
  const staleImported: ImagePlan['staleImported'] = [];
  let productsWithManualImages = 0;
  let manualMainPreserved = 0;

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

    // Canonical desired state for THIS product's imported set:
    //   sort_order = baseOffset + staging index (stable across re-runs);
    //   is_main    = staging index 0, UNLESS a foreign image owns the main slot.
    const baseOffset =
      foreignRows.length > 0
        ? Math.max(0, ...foreignRows.map((r) => Math.max(0, r.sort_order ?? 0))) + 1
        : 0;
    const desiredState = new Map<string, { sortOrder: number; isMain: boolean }>();
    desired.forEach((url, index) => {
      desiredState.set(url, {
        sortOrder: baseOffset + index,
        isMain: index === 0 && !foreignHasMain,
      });
    });

    const existingByUrl = new Map(existingImported.map((r) => [r.image_url, r]));

    // A) INSERT missing / B+C) reconcile existing imported rows
    for (const [url, want] of desiredState) {
      const row = existingByUrl.get(url);
      if (!row) {
        inserts.push({
          product_id: product.dbId,
          image_url: url,
          alt: null,
          sort_order: want.sortOrder,
          is_main: want.isMain,
        });
        continue;
      }

      const curSort = row.sort_order ?? 0;
      const curMain = row.is_main === true;
      const fields: ImageUpdateOp['fields'] = {};
      if (curSort !== want.sortOrder) fields.sort_order = want.sortOrder;
      // is_main reconciles only within the imported set AND only when no
      // foreign (manual) image owns the main slot.
      if (!foreignHasMain && curMain !== want.isMain) fields.is_main = want.isMain;
      if (Object.keys(fields).length > 0) {
        updates.push({ id: row.id, product_id: row.product_id, fields });
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
      if (!desiredState.has(row.image_url)) {
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
