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
  /** optional _du allowlist drift section (checked when the script provides it) */
  du?: DuDriftInput;
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
// _du audit invariant (2026-09-01 regeneration): _du products WITHOUT a base
// product. The generator hard-fails outside this number; monitoring mirrors
// it as a WARN regenerate signal. (2026-08-31 audit: 26; two orphans gained
// bases on the 2026-08-31 16:00 import run → 24.)
export const DU_EXPECTED_ORPHANS = 24;

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
