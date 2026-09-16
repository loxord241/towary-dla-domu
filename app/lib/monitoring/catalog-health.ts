/**
 * Pure classification logic for the read-only catalog health check
 * (monitoring stage, 2026-08-28). NO DB ACCESS HERE — the script
 * scripts/catalog-health-check.ts fetches rows with read-only selects and
 * feeds plain data into these functions, which keeps classification unit
 * testable with mock data and guarantees the classifier can never write.
 *
 * Status model (production audit 2026-08-28):
 *   FAIL — sync is actually broken: a failed import batch, a stuck running
 *          batch, or no successful Yugcontract run in the last 96h;
 *   WARN — degraded catalog data (products without price/category)
 *          or a sync that is older than its 48h schedule allows;
 *   PASS — no critical problems. Manual (non-YC) products, pending orders
 *          and imageless active products (expected import backlog before
 *          photo upload; storefront eligibility = product_images!inner)
 *          are informational and do not escalate the overall status.
 *
 * Newest-products OOS skew (2026-09-05): the storefront's first screen is
 *   populated by the newest active products (created_at desc), so a supplier
 *   data drift that marks them out_of_stock empties the whole first screen
 *   while the global OOS share stays low. Monitoring measures the newest-100
 *   slice directly: FAIL at ≥ 50% out_of_stock, WARN at ≥ 20%. A sample
 *   smaller than 20 products is advisory (warn at most, never escalates);
 *   0 active products ⇒ skip.
 *
 * Content/images phases (2026-09-06): yc_content_batches (phases
 *   'description' and 'images') joins the monitoring surface: failed batches
 *   ⇒ FAIL, running older than CONTENT_STUCK_RUNNING_MS (10 min, mirrors the
 *   importer's own reclaim window) ⇒ FAIL, and the newest 'done' batch of
 *   ANY phase (products, description, images) feeds the "sync freshness"
 *   metric — freshness = max over all last-done timestamps, so a successful
 *   content run right after a skipped products cycle does not page falsely.
 *
 * Feed-liveness (2026-09-06): share of availability_status='in_stock' among
 *   active products with a base (non-_du) yugcontract_id. WARN < 50%,
 *   FAIL < 20% (strictly below; exactly 50% / 20% is the healthier level).
 *   A known supplier incident (~3.3% in_stock at measurement time) can be
 *   acknowledged with a baseline file logs/feed-liveness-baseline.json:
 *
 *     {
 *       "acknowledgedAt": "2026-09-08T09:00:00.000Z",
 *       "acknowledgedShare": 0.033
 *     }
 *
 *   acknowledgedShare = the in_stock share at ack time (0..1). While the
 *   file exists (and "acknowledged" is not explicitly false), the absolute
 *   floors do NOT apply; the check only WARNs when the share drops BELOW
 *   the acknowledged baseline (further degradation of the acknowledged
 *   incident). Remove the file or set "acknowledged": false to return to
 *   the absolute thresholds. Without the file the usual thresholds apply.
 *
 * Category drift (2026-09-06): if the newest categories batch of
 *   yc_import_batches has inserted_count > 0, the supplier changed/extended
 *   the category tree (new ids ⇒ remap risk, new branches ⇒ assortment
 *   growth) — WARN to review the remap/selection. informational-only when 0.
 *
 * Exit codes (systemd-friendly): PASS=0, WARN=1, FAIL=2.
 */

export type HealthLevel = 'pass' | 'warn' | 'fail';

export interface HealthCheck {
  id: string;
  label: string;
  level: HealthLevel;
  count: number;
  description: string;
  /** advisory checks are reported but never escalate the overall status */
  affectsStatus: boolean;
  /** optional problem list (capped) for products checks */
  items?: string[];
}

/** Minimal plain shape of a yc_import_batches row (read-only select). */
export interface ImportBatchInfo {
  run_id: string;
  phase: string;
  batch_no: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  /** rows inserted by the batch; only read for the categories-drift check */
  inserted_count?: number | null;
}

export interface ImportAnalysis {
  failedCount: number;
  stuckCount: number;
  /** ISO timestamp of the newest finished 'done' batch, null if none */
  lastSuccessAt: string | null;
}

export interface CatalogCounts {
  activeTotal: number;
  noYcId: number;
  noCategory: number;
  noImages: number;
  noPrice: number;
  nonPositivePrice: number;
}

export interface CatalogHealthInput {
  now: Date;
  counts: CatalogCounts;
  /** sample rows (yugcontract_id / sku / slug / name) of imageless products */
  noImageItems?: string[];
  batches: ImportBatchInfo[];
  /** orders with payment_status='pending' older than 24h (advisory: COD-like) */
  pendingOrdersOlderThan24h: number;
  /** optional _du allowlist drift section (checked when the script provides it) */
  du?: DuDriftInput;
  /**
   * Optional newest-active-products slice (created_at desc, is_active=true,
   * capped at NEWEST_SAMPLE_SIZE) for the storefront first-screen OOS skew
   * check — measured when the script provides it.
   */
  newestProducts?: NewestProductRow[];
  /**
   * Optional yc_content_batches rows (phases 'description' | 'images') —
   * measured when the script provides them. Adds failed/stuck checks and
   * joins the last-done content/images batch into the sync-freshness metric
   * (max over products + content phases).
   */
  contentBatches?: ImportBatchInfo[];
  /**
   * Optional feed-liveness measurement (active base Yugcontract products) —
   * computed when the script provides it.
   */
  feedLiveness?: FeedLivenessInput;
}

// ---- feed-liveness (2026-09-06) -------------------------------------------

/**
 * Acknowledged supplier-incident baseline, parsed from
 * logs/feed-liveness-baseline.json by the script:
 *   { acknowledgedAt: ISO string, acknowledgedShare: 0..1 }
 * Presence of a valid file means the incident is acknowledged; the absolute
 * WARN/FAIL floors then do not apply (see analyzeFeedLiveness).
 */
export interface FeedLivenessAck {
  acknowledgedAt: string;
  acknowledgedShare: number;
}

export interface FeedLivenessInput {
  /** active products with a base (non-_du) yugcontract_id */
  total: number;
  /** of those, availability_status = 'in_stock' */
  inStock: number;
  /** parsed baseline file; null/absent ⇒ absolute thresholds apply */
  ack?: FeedLivenessAck | null;
}

export interface FeedLivenessAnalysis {
  total: number;
  inStock: number;
  /** inStock / total, null when there is nothing to measure */
  share: number | null;
  /** baseline file present and valid */
  acked: boolean;
  /** acked AND the share dropped below the acknowledged baseline */
  degradedFromAck: boolean;
  /** nothing to measure (0 base products) — skip, always pass */
  skip: boolean;
  level: HealthLevel;
}

/**
 * Classify the in_stock share among active base Yugcontract products.
 * Without an ack: WARN < 50%, FAIL < 20% (strictly below — exactly 50% /
 * exactly 20% stay at the healthier level). With an ack: the absolute floors
 * are suspended; only a drop BELOW the acknowledged baseline WARNs (further
 * degradation of the known incident), otherwise PASS. Pure — no I/O.
 */
export function analyzeFeedLiveness(input: FeedLivenessInput): FeedLivenessAnalysis {
  const { total, inStock, ack } = input;
  const acked = ack !== null && ack !== undefined;
  const share = total === 0 ? null : inStock / total;
  const skip = total === 0;
  let level: HealthLevel = 'pass';
  let degradedFromAck = false;
  if (!skip && share !== null) {
    if (acked) {
      if (share < ack!.acknowledgedShare) {
        degradedFromAck = true;
        level = 'warn';
      }
    } else if (share < FEED_LIVENESS_FAIL_SHARE) {
      level = 'fail';
    } else if (share < FEED_LIVENESS_WARN_SHARE) {
      level = 'warn';
    }
  }
  return { total, inStock, share, acked, degradedFromAck, skip, level };
}

// ---- category drift (2026-09-06) -------------------------------------------

export interface CategoriesDriftAnalysis {
  /** inserted_count of the newest categories batch, null when none exists */
  lastInsertedCount: number | null;
}

/**
 * Find the newest categories batch and report its inserted_count.
 * inserted_count > 0 in the latest run means the supplier changed or
 * extended the category tree (id remap / assortment growth risk).
 * Pure — no I/O.
 */
export function analyzeCategoriesBatch(
  batches: ReadonlyArray<ImportBatchInfo>
): CategoriesDriftAnalysis {
  let newest: ImportBatchInfo | null = null;
  let newestStamp = '';
  for (const b of batches) {
    if (b.phase !== 'categories') continue;
    const stamp = b.finished_at ?? b.started_at ?? '';
    if (newest === null || stamp > newestStamp) {
      newest = b;
      newestStamp = stamp;
    }
  }
  return {
    lastInsertedCount: newest === null ? null : (newest.inserted_count ?? 0),
  };
}

// A running batch older than the importer's own STALE_RUNNING_MS (10 min)
// is retryable but suspicious; monitoring uses a generous 60 min window so
// normal in-flight chunks never alert.
export const STUCK_RUNNING_MS = 60 * 60 * 1000;
// Content/images batches are reclaimed by the importer itself after
// CONTENT_STALE_RUNNING_MS (10 min, content-import.ts) — monitoring mirrors
// that tighter window instead of the 60 min products window.
export const CONTENT_STUCK_RUNNING_MS = 10 * 60 * 1000;
// Sync schedule is 48h (launcher success stamp). The daily 18:00 trigger
// with the 47h guard means a healthy last success is never older than ~48h
// when the health check runs; >56h ⇒ the latest attempt failed or was
// skipped, >96h ⇒ two consecutive cycles missed.
export const SYNC_WARN_AGE_MS = 56 * 60 * 60 * 1000;
export const SYNC_FAIL_AGE_MS = 96 * 60 * 60 * 1000;
// Orders pending >24h are expected for cash-on-delivery style flow, so the
// check is advisory and never fails the overall result.
export const PENDING_ORDER_WARN_HOURS = 24;
// _du audit invariant (2026-09-16 regeneration): _du products WITHOUT a base
// product. The generator hard-fails outside this number; monitoring mirrors it
// as a WARN regenerate signal. (2026-08-31 audit: 26 → 2026-09-01: 24 →
// 2026-09-02: 25 → 2026-09-07 post-incident restore: 39 → 2026-09-12
// live probe: 40 → 2026-09-16: 38 — 10 allowlisted pairs and 1 orphan row
// deleted from the DB outside the importer, 1 orphan 6895802_du promoted to
// a pair; 293 pairs now, ALL redirect to base since the 2026-09-12 policy
// change.)
export const DU_EXPECTED_ORPHANS = 38;

// ---- newest-products OOS skew (2026-09-05) ------------------------------
// The storefront's first screen is populated by the newest active products
// (created_at desc). A Yugcontract sync once made that slice ~86%
// out_of_stock while the whole active catalog sat at ~6% — the global share
// hides the skew, so monitoring measures the newest slice directly.
export const NEWEST_SAMPLE_SIZE = 100;
// Thresholds are inclusive: exactly 20% ⇒ WARN, exactly 50% ⇒ FAIL.
export const OOS_WARN_SHARE = 0.2;
export const OOS_FAIL_SHARE = 0.5;
// A slice below this size is too small to trust the share: the check is
// reported as advisory WARN at most and never escalates the overall status.
export const NEWEST_MIN_SAMPLE = 20;

// ---- feed-liveness (2026-09-06) ------------------------------------------
// Share of in_stock among active base Yugcontract products. Thresholds are
// strict "below": exactly 50% is not WARN, exactly 20% is not FAIL.
export const FEED_LIVENESS_WARN_SHARE = 0.5;
export const FEED_LIVENESS_FAIL_SHARE = 0.2;
/** Ack file for a known supplier incident (see header docstring for format). */
export const FEED_LIVENESS_BASELINE_PATH = 'logs/feed-liveness-baseline.json';

/** Minimal plain shape of a yc_content_batches row (read-only select). */
export type ContentBatchInfo = ImportBatchInfo;

/** Minimal plain shape of a newest-products sample row (read-only select). */
export interface NewestProductRow {
  availability_status: string | null;
}

export interface NewestOosAnalysis {
  /** actual size of the newest-active slice (≤ NEWEST_SAMPLE_SIZE) */
  sampleSize: number;
  oosCount: number;
  /** oosCount / sampleSize, null when there is nothing to measure */
  oosShare: number | null;
  /** sample smaller than NEWEST_MIN_SAMPLE — the result is advisory only */
  smallSample: boolean;
}

/**
 * Classify the out_of_stock share among the newest active products.
 * The slice itself (is_active=true, created_at desc, limit) is the script's
 * responsibility — pinned by a wiring test; this function only classifies.
 * Pure — no I/O.
 */
export function analyzeNewestOos(
  rows: ReadonlyArray<NewestProductRow>
): NewestOosAnalysis {
  const sampleSize = rows.length;
  const oosCount = rows.filter(
    (r) => r.availability_status === 'out_of_stock'
  ).length;
  const oosShare = sampleSize === 0 ? null : oosCount / sampleSize;
  return { sampleSize, oosCount, oosShare, smallSample: sampleSize < NEWEST_MIN_SAMPLE };
}

/** Minimal plain shape of a products row needed for _du drift (read-only select). */
export interface DuProductRow {
  yugcontract_id: string;
  slug: string;
  price: number | null;
}

/** Plain snapshot of the generated allowlist — the lib never imports du-redirects. */
export interface DuAllowlistSnapshot {
  /** every allowlisted _du id: 96 redirect + 10 price-diff yugcontract_ids */
  duIds: ReadonlySet<string>;
  /** the 10 documented price-diff _du ids (never redirected) */
  priceDiffIds: ReadonlySet<string>;
  /** audit invariant: expected count of _du rows without a base */
  expectedOrphans: number;
}

export interface DuDriftInput {
  duRows: DuProductRow[];
  baseRows: DuProductRow[];
  allowlist: DuAllowlistSnapshot;
}

export interface DuDriftAnalysis {
  duTotal: number;
  /** _du rows whose base product is absent (audit 2026-09-01: 24) */
  orphanCount: number;
  /** _du with an existing base that is absent from the allowlist — new duplicates */
  unknownDu: string[];
  /** allowlisted _du missing from the DB entirely */
  missingDu: string[];
  /** known pair whose base is gone or whose slug derivation broke */
  brokenPairs: string[];
  /** known pair whose price-equality class flipped (needs allowlist regenerate) */
  priceDrift: string[];
}

/** Classify _du drift against the allowlist. Pure — no I/O. */
export function analyzeDuDrift(drift: DuDriftInput): DuDriftAnalysis {
  const { duRows, baseRows, allowlist } = drift;
  const stripDu = (s: string) => s.replace(/_du$/, '');
  const bases = new Map(baseRows.map((b) => [b.yugcontract_id, b]));
  const present = new Set(duRows.map((d) => d.yugcontract_id));

  const missingDu = [...allowlist.duIds].filter((id) => !present.has(id)).sort();

  const unknownDu: string[] = [];
  const brokenPairs: string[] = [];
  const priceDrift: string[] = [];
  let orphanCount = 0;

  for (const du of duRows) {
    const base = bases.get(stripDu(du.yugcontract_id));
    if (!base) {
      orphanCount += 1;
      // An allowlisted _du losing its base is a broken pair (generator gate:
      // pairs !== 106), not an orphan — orphans are only non-allowlisted _du.
      if (allowlist.duIds.has(du.yugcontract_id)) {
        brokenPairs.push(`${du.yugcontract_id} | base ${stripDu(du.yugcontract_id)} missing`);
      }
      continue;
    }
    if (!allowlist.duIds.has(du.yugcontract_id)) {
      unknownDu.push(`${du.yugcontract_id} | ${du.slug}`);
      continue;
    }
    if (base.slug !== stripDu(du.slug)) {
      brokenPairs.push(`${du.yugcontract_id} | slug mismatch: du=${du.slug} base=${base.slug}`);
      continue;
    }
    const pricesDiffer = du.price !== base.price;
    const expectedDiff = allowlist.priceDiffIds.has(du.yugcontract_id);
    if (pricesDiffer !== expectedDiff) {
      priceDrift.push(`${du.yugcontract_id} | du=${String(du.price)} base=${String(base.price)}`);
    }
  }

  return {
    duTotal: duRows.length,
    orphanCount,
    unknownDu: unknownDu.sort(),
    missingDu,
    brokenPairs: brokenPairs.sort(),
    priceDrift: priceDrift.sort(),
  };
}

/** Detect failed / stuck import batches and the last successful run. */
export function analyzeImportBatches(
  batches: ImportBatchInfo[],
  now: Date,
  stuckWindowMs: number = STUCK_RUNNING_MS
): ImportAnalysis {
  let failedCount = 0;
  let stuckCount = 0;
  let lastSuccessAt: string | null = null;

  for (const b of batches) {
    if (b.status === 'failed') failedCount += 1;
    if (
      b.status === 'running' &&
      b.started_at !== null &&
      now.getTime() - new Date(b.started_at).getTime() > stuckWindowMs
    ) {
      stuckCount += 1;
    }
    if (
      b.status === 'done' &&
      b.finished_at !== null &&
      (lastSuccessAt === null ||
        new Date(b.finished_at) > new Date(lastSuccessAt))
    ) {
      lastSuccessAt = b.finished_at;
    }
  }
  return { failedCount, stuckCount, lastSuccessAt };
}

function lastSuccessLevel(iso: string | null, now: Date): HealthLevel {
  if (iso === null) return 'fail';
  const age = now.getTime() - new Date(iso).getTime();
  if (age > SYNC_FAIL_AGE_MS) return 'fail';
  if (age > SYNC_WARN_AGE_MS) return 'warn';
  return 'pass';
}

function ageHours(iso: string | null, now: Date): string {
  if (iso === null) return 'ніколи';
  return `${Math.round((now.getTime() - new Date(iso).getTime()) / 3600000)} год тому`;
}

/** Build every check from fetched read-only data. Pure — no I/O. */
export function buildCatalogChecks(
  input: CatalogHealthInput
): HealthCheck[] {
  const { now, counts, batches, pendingOrdersOlderThan24h } = input;
  const imports = analyzeImportBatches(batches, now);
  // Content/images phases: same classification, tighter stuck window; their
  // last done batch joins the freshness metric (max over all phases) so a
  // successful content run counts as a live sync signal too.
  const content = input.contentBatches
    ? analyzeImportBatches(input.contentBatches, now, CONTENT_STUCK_RUNNING_MS)
    : null;
  const lastSuccessCandidates = [imports.lastSuccessAt, content?.lastSuccessAt ?? null].filter(
    (v): v is string => v !== null
  );
  const combinedLastSuccess =
    lastSuccessCandidates.length > 0
      ? lastSuccessCandidates.reduce((a, b) => (b > a ? b : a))
      : null;
  const lastSuccessLevelValue = lastSuccessLevel(combinedLastSuccess, now);
  const categories = analyzeCategoriesBatch(batches);

  const checks: HealthCheck[] = [
    {
      id: 'products-manual',
      label: 'Активні товари без yugcontract_id (ручні)',
      level: 'pass',
      count: counts.noYcId,
      description:
        'Товари, створені вручну (не з фіду Yugcontract). Це очікуваний стан, не проблема.',
      affectsStatus: false,
    },
    {
      id: 'products-no-category',
      label: 'Активні товари без категорії',
      level: counts.noCategory > 0 ? 'warn' : 'pass',
      count: counts.noCategory,
      description:
        counts.noCategory > 0
          ? 'Товари не прив’язані до жодної категорії — невидимі в дереві каталогу (пошук/прямий URL працюють).'
          : 'Усі активні товари мають категорію.',
      affectsStatus: true,
    },
    {
      id: 'products-no-images',
      label: 'Активні товари без зображень',
      level: counts.noImages > 0 ? 'warn' : 'pass',
      count: counts.noImages,
      description:
        counts.noImages > 0
          ? 'Товари без жодного фото: невидимі на вітрині та відсутні в sitemap (eligibility = product_images!inner). Очікуваний стан свіжого імпорту до завантаження фото — advisory, статус не погіршує, інакше беклог зображень тримає health у WARN і маскує реальні регресії.'
          : 'Усі активні товари мають зображення.',
      affectsStatus: false,
      ...(counts.noImages > 0 && input.noImageItems?.length
        ? { items: input.noImageItems }
        : {}),
    },
    {
      id: 'products-no-price',
      label: 'Активні товари з price IS NULL',
      level: counts.noPrice > 0 ? 'warn' : 'pass',
      count: counts.noPrice,
      description:
        counts.noPrice > 0
          ? 'Без ціни товар не може бути куплений (серверний pricing відкидає рядок).'
          : 'Ціна заповнена для всіх активних товарів.',
      affectsStatus: true,
    },
    {
      id: 'products-nonpositive-price',
      label: 'Активні товари з price <= 0',
      level: counts.nonPositivePrice > 0 ? 'warn' : 'pass',
      count: counts.nonPositivePrice,
      description:
        counts.nonPositivePrice > 0
          ? 'Нульова або від’ємна ціна на вітрині — пошкоджені дані фіду/імпорту.'
          : 'Некоректних цін немає.',
      affectsStatus: true,
    },
    {
      id: 'import-failed-batches',
      label: 'Failed import batches (Yugcontract)',
      level: imports.failedCount > 0 ? 'fail' : 'pass',
      count: imports.failedCount,
      description:
        imports.failedCount > 0
          ? 'Є незавершені (failed) батчі імпорту — sync реально зламаний. Відновлення: node scripts/yugcontract-import-run.ts --run --resume <RUN_ID>.'
          : 'Failed батчів немає.',
      affectsStatus: true,
    },
    {
      id: 'import-stuck-batches',
      label: 'Stuck running batches (Yugcontract)',
      level: imports.stuckCount > 0 ? 'fail' : 'pass',
      count: imports.stuckCount,
      description:
        imports.stuckCount > 0
          ? `Батчі у статусі running довше ${STUCK_RUNNING_MS / 60000} хв — process зупинився, не прибравши статус.`
          : 'Завислих running-батчів немає.',
      affectsStatus: true,
    },
    {
      id: 'import-last-success',
      label: 'Останній успішний Yugcontract run',
      level: lastSuccessLevelValue,
      count: 1,
      description: `${ageHours(combinedLastSuccess, now)} (розклад: sync кожні 48 год; WARN > ${SYNC_WARN_AGE_MS / 3600000} год, FAIL > ${SYNC_FAIL_AGE_MS / 3600000} год; враховуються products + content/images фази).`,
      affectsStatus: true,
    },
    {
      id: 'categories-drift',
      label: 'Категорійний дрейф (останній categories-батч)',
      level: categories.lastInsertedCount !== null && categories.lastInsertedCount > 0 ? 'warn' : 'pass',
      count: categories.lastInsertedCount ?? 0,
      description:
        categories.lastInsertedCount !== null && categories.lastInsertedCount > 0
          ? `Останній categories-батч вставив ${categories.lastInsertedCount} категорій — постачальник змінив/розширив дерево категорій (зміна id = ризик ремапу, нові гілки = розширення асортименту). Перевірити ремап/selection.`
          : 'Останній categories-батч не вставляв нових категорій — дерево стабільне.',
      affectsStatus: true,
    },
    {
      id: 'orders-pending-24h',
      label: 'Замовлення pending старше 24 год (advisory)',
      level: pendingOrdersOlderThan24h > 0 ? 'warn' : 'pass',
      count: pendingOrdersOlderThan24h,
      description:
        pendingOrdersOlderThan24h > 0
          ? 'Pending-замовлення старше 24 год. Для наложеного платежу/оплати менеджером це очікувано — advisory, статус не погіршує.'
          : 'Старих pending-замовлень немає.',
      // Advisory on purpose: COD-like orders legitimately stay pending.
      affectsStatus: false,
    },
  ];

  // ---- _du allowlist drift (audit 2026-08-31) -----------------------------
  // Mirrors the generator's hard gates as monitoring checks:
  //   FAIL — a new _du with a base outside the allowlist, or a known pair
  //          broken (du/base missing, slug derivation changed);
  //   WARN — price-equality class flipped inside the known pairs, or the
  //          orphan count left the audited value ⇒ regenerate the allowlist.
  if (input.du) {
    const d = analyzeDuDrift(input.du);
    const expectedOrphans = input.du.allowlist.expectedOrphans;
    const broken = [...d.missingDu.map((id) => `${id} | missing from products`), ...d.brokenPairs];
    checks.push(
      {
        id: 'du-unknown-new',
        label: 'Нові _du товари з base поза allowlist',
        level: d.unknownDu.length > 0 ? 'fail' : 'pass',
        count: d.unknownDu.length,
        description:
          d.unknownDu.length > 0
            ? 'У БД з’явилися _du-товари з існуючим base, яких немає в allowlist (96 redirect + 10 price-diff) — дублікати URL без redirect. Regenerate: node --experimental-strip-types scripts/yugcontract-du-redirect-allowlist.ts'
            : 'Нових _du-пар поза allowlist немає.',
        affectsStatus: true,
        ...(d.unknownDu.length > 0 ? { items: d.unknownDu } : {}),
      },
      {
        id: 'du-pairs-integrity',
        label: 'Зниклі/змінені allowlist _du пари',
        level: broken.length > 0 ? 'fail' : 'pass',
        count: broken.length,
        description:
          broken.length > 0
            ? 'Allowlist-пара зламана: _du або base зник, або slug більше не виводиться з du-суфікса. Regenerate allowlist після з’ясування причин.'
            : 'Усі allowlist _du пари цілі (slug-вивід збігається).',
        affectsStatus: true,
        ...(broken.length > 0 ? { items: broken } : {}),
      },
      {
        id: 'du-price-drift',
        label: `Price-drift у відомих _du парах (WARN = regenerate)`,
        level: d.priceDrift.length > 0 ? 'warn' : 'pass',
        count: d.priceDrift.length,
        description:
          d.priceDrift.length > 0
            ? 'Клас рівності цін у відомих парах змінився (redirect-пара стала різноцінною або price-diff зрівнялась) — allowlist більше не відповідає аудиту. Regenerate: node --experimental-strip-types scripts/yugcontract-du-redirect-allowlist.ts'
            : `Класи цін пар відповідають аудиту (price-diff: ${input.du.allowlist.priceDiffIds.size}).`,
        affectsStatus: true,
        ...(d.priceDrift.length > 0 ? { items: d.priceDrift } : {}),
      },
      {
        id: 'du-orphans',
        label: `_du сироти без base (очікується ${expectedOrphans})`,
        level: d.orphanCount !== expectedOrphans ? 'warn' : 'pass',
        count: d.orphanCount,
        description:
          d.orphanCount !== expectedOrphans
            ? `Кількість _du без base (${d.orphanCount}) відхилилася від аудиту (${expectedOrphans}) — з’явилися нові сироти або base відновився. Regenerate allowlist.`
            : `Кількість _du сиріт відповідає аудиту (${expectedOrphans}).`,
        affectsStatus: true,
      },
    );
  }

  // ---- newest-products OOS skew (2026-09-05) ------------------------------
  // FAIL ≥ 50% / WARN ≥ 20% out_of_stock among the newest active products;
  // a sample < NEWEST_MIN_SAMPLE is advisory (warn at most, never
  // escalates); 0 active products ⇒ skip (pass).
  if (input.newestProducts) {
    const a = analyzeNewestOos(input.newestProducts);
    const pct =
      a.oosShare === null ? null : Math.round(a.oosShare * 1000) / 10;
    let level: HealthLevel = 'pass';
    let description: string;
    let advisory = false;
    if (a.oosShare === null) {
      description =
        'Пропущено: немає активних товарів — міряти частку out-of-stock нема чого.';
    } else if (a.smallSample) {
      advisory = true;
      level = a.oosShare >= OOS_WARN_SHARE ? 'warn' : 'pass';
      description =
        `Вибірка мала (${a.sampleSize} < ${NEWEST_MIN_SAMPLE} товарів): ${a.oosCount} з ${a.sampleSize} out-of-stock (${pct}%). ` +
        'Мала вибірка — advisory, статус не погіршує, але перекос видно вже зараз.';
    } else if (a.oosShare >= OOS_FAIL_SHARE) {
      level = 'fail';
      description =
        `${pct}% із ${a.sampleSize} нових активних товарів out-of-stock (≥ ${OOS_FAIL_SHARE * 100}%). ` +
        'Перший екран вітрини складається з відсутніх товарів — зсув даних імпорту/постачальника.';
    } else if (a.oosShare >= OOS_WARN_SHARE) {
      level = 'warn';
      description =
        `${pct}% із ${a.sampleSize} нових активних товарів out-of-stock (≥ ${OOS_WARN_SHARE * 100}%) — ` +
        'перший екран вітрини починає «просідати».';
    } else {
      description =
        `${pct}% із ${a.sampleSize} нових активних товарів out-of-stock — ` +
        'новинки доступні, перший екран вітрини здоровий.';
    }
    checks.push({
      id: 'newest-oos-skew',
      label: `Перекос «новинки = out-of-stock» (топ-${NEWEST_SAMPLE_SIZE} за created_at)`,
      level,
      count: a.oosCount,
      description,
      affectsStatus: !advisory,
    });
  }

  // ---- content/images phases (yc_content_batches, 2026-09-06) -------------
  // Same FAIL semantics as the products phase: a failed batch ⇒ sync really
  // broken (resume per docs/wsl-sync.md §7); a running batch older than the
  // importer's own 10-min reclaim window ⇒ the runner died mid-batch.
  if (input.contentBatches && content) {
    checks.push(
      {
        id: 'content-failed-batches',
        label: 'Failed content/images batches (Yugcontract)',
        level: content.failedCount > 0 ? 'fail' : 'pass',
        count: content.failedCount,
        description:
          content.failedCount > 0
            ? 'Є failed-батчі у content/images фазах — синк контенту/зображень зламався. Відновлення: docs/wsl-sync.md, розділ 7 (resume content-images).'
            : 'Failed батчів у content/images фазах немає.',
        affectsStatus: true,
      },
      {
        id: 'content-stuck-batches',
        label: `Stuck running content/images batches (> ${CONTENT_STUCK_RUNNING_MS / 60000} хв)`,
        level: content.stuckCount > 0 ? 'fail' : 'pass',
        count: content.stuckCount,
        description:
          content.stuckCount > 0
            ? `Батчі content/images у статусі running довше ${CONTENT_STUCK_RUNNING_MS / 60000} хв (вікно reclaim імпортера) — process зупинився, не прибравши статус.`
            : 'Завислих running-батчів у content/images фазах немає.',
        affectsStatus: true,
      },
    );
  }

  // ---- feed-liveness (2026-09-06) -----------------------------------------
  // Share of in_stock among active base Yugcontract products: WARN < 50%,
  // FAIL < 20%. A known supplier incident can be acknowledged with
  // logs/feed-liveness-baseline.json ({ acknowledgedAt, acknowledgedShare });
  // while the ack is valid only a drop BELOW the acknowledged baseline warns.
  if (input.feedLiveness) {
    const f = analyzeFeedLiveness(input.feedLiveness);
    const pct = f.share === null ? null : Math.round(f.share * 1000) / 10;
    const ack = input.feedLiveness.ack ?? null;
    const ackSharePct =
      ack === null ? null : Math.round(ack.acknowledgedShare * 1000) / 10;
    const ackNote =
      ack === null
        ? ''
        : ` (ack ${ack.acknowledgedAt}, baseline ${ackSharePct}%)`;
    let description: string;
    if (f.skip) {
      description =
        'Пропущено: немає активних товарів з yugcontract_id (base) — міряти feed-liveness нема чого.';
    } else if (f.acked && !f.degradedFromAck) {
      description =
        `${pct}% in_stock (${f.inStock} з ${f.total})${ackNote} — інцидент визнано, абсолютні пороги призупинено; нижче визнаного baseline не просіло.`;
    } else if (f.degradedFromAck) {
      description =
        `${pct}% in_stock (${f.inStock} з ${f.total}) — нижче визнаного baseline ${ackSharePct}%${ackNote}: ситуація з фідом погіршилася далі.`;
    } else if (f.level === 'fail') {
      description =
        `Лише ${pct}% in_stock (${f.inStock} з ${f.total}) серед активних товарів Yugcontract (< ${FEED_LIVENESS_FAIL_SHARE * 100}%) — масова відсутність товару у постачальника. ` +
        `Якщо це відома подія — створіть ${FEED_LIVENESS_BASELINE_PATH}: {"acknowledgedAt":"<ISO>","acknowledgedShare":<частка 0..1>}.`;
    } else if (f.level === 'warn') {
      description =
        `${pct}% in_stock (${f.inStock} з ${f.total}) серед активних товарів Yugcontract (< ${FEED_LIVENESS_WARN_SHARE * 100}%) — більше половини асортименту відсутнє. ` +
        `Якщо це відома подія — створіть ${FEED_LIVENESS_BASELINE_PATH}: {"acknowledgedAt":"<ISO>","acknowledgedShare":<частка 0..1>}.`;
    } else {
      description = `${pct}% in_stock (${f.inStock} з ${f.total}) — фід постачальника здоровий.`;
    }
    checks.push({
      id: 'feed-liveness',
      label: 'Feed-liveness: частка in_stock (активні товари Yugcontract, base)',
      level: f.level,
      count: f.inStock,
      description,
      // The acknowledged-baseline state itself never escalates (PASS);
      // degradation below the acknowledged baseline is a real WARN.
      affectsStatus: true,
    });
  }

  return checks;
}

export interface OverallResult {
  status: 'PASS' | 'WARN' | 'FAIL';
  exitCode: 0 | 1 | 2;
}

/** Worst level among status-affecting checks (advisory ones never escalate). */
export function overallResult(checks: HealthCheck[]): OverallResult {
  let worst: HealthLevel = 'pass';
  for (const c of checks) {
    if (!c.affectsStatus) continue;
    if (c.level === 'fail') worst = 'fail';
    else if (c.level === 'warn' && worst !== 'fail') worst = 'warn';
  }
  if (worst === 'fail') return { status: 'FAIL', exitCode: 2 };
  if (worst === 'warn') return { status: 'WARN', exitCode: 1 };
  return { status: 'PASS', exitCode: 0 };
}
