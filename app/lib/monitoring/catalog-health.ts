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
 *   WARN — degraded catalog data (products without images/price/category)
 *          or a sync that is older than its 48h schedule allows;
 *   PASS — no critical problems. Manual (non-YC) products and pending
 *          orders are informational and do not escalate the overall status.
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
}

// A running batch older than the importer's own STALE_RUNNING_MS (10 min)
// is retryable but suspicious; monitoring uses a generous 60 min window so
// normal in-flight chunks never alert.
export const STUCK_RUNNING_MS = 60 * 60 * 1000;
// Sync schedule is 48h (launcher success stamp). The daily 18:00 trigger
// with the 47h guard means a healthy last success is never older than ~48h
// when the health check runs; >56h ⇒ the latest attempt failed or was
// skipped, >96h ⇒ two consecutive cycles missed.
export const SYNC_WARN_AGE_MS = 56 * 60 * 60 * 1000;
export const SYNC_FAIL_AGE_MS = 96 * 60 * 60 * 1000;
// Orders pending >24h are expected for cash-on-delivery style flow, so the
// check is advisory and never fails the overall result.
export const PENDING_ORDER_WARN_HOURS = 24;

/** Detect failed / stuck import batches and the last successful run. */
export function analyzeImportBatches(
  batches: ImportBatchInfo[],
  now: Date
): ImportAnalysis {
  let failedCount = 0;
  let stuckCount = 0;
  let lastSuccessAt: string | null = null;

  for (const b of batches) {
    if (b.status === 'failed') failedCount += 1;
    if (
      b.status === 'running' &&
      b.started_at !== null &&
      now.getTime() - new Date(b.started_at).getTime() > STUCK_RUNNING_MS
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
  const lastSuccessLevelValue = lastSuccessLevel(imports.lastSuccessAt, now);

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
          ? 'Товари без жодного фото: невидимі на вітрині та відсутні в sitemap (eligibility = product_images!inner). Виправляється контентною кампанією, не автоматикою.'
          : 'Усі активні товари мають зображення.',
      affectsStatus: true,
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
      description: `${ageHours(imports.lastSuccessAt, now)} (розклад: sync кожні 48 год; WARN > ${SYNC_WARN_AGE_MS / 3600000} год, FAIL > ${SYNC_FAIL_AGE_MS / 3600000} год).`,
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
