/**
 * Yugcontract IMAGES HOTLINK phase — plan / run.
 *
 * Imports external supplier image URLs from yc_content_goods.pictures
 * into the EXISTING product_images table (image_url = absolute URL).
 * NO Storage uploads, NO downloads, NO HEAD requests — pure DB ops.
 *
 * Identity/idempotency: (product_id, image_url), diff-aware reconciliation;
 * manual Storage rows (relative paths) are NEVER touched; deletions are
 * intentionally NOT implemented (stale imported rows are reported only).
 *
 * Modes:
 *   node scripts/yugcontract-content-images.ts --plan               read-only report
 *   node scripts/yugcontract-content-images.ts --run                new run (phase='images')
 *   node scripts/yugcontract-content-images.ts --run --resume ID    resume crashed run
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // env vars can come from the shell too
}

// Type-only static imports: fully erased before execution.
import type { StagedContentRow } from '../app/lib/yugcontract/content-staging.ts';
import type { ContentProductRow } from '../app/lib/yugcontract/content-import.ts';
import type { ProductImageRow } from '../app/lib/yugcontract/content-images.ts';

const { createClient } = await import('@supabase/supabase-js');
const { revalidateStagedPictures, planImageOps, isExternalImportedImage } = await import(
  '../app/lib/yugcontract/content-images.ts'
);
const {
  ensureContentRun,
  runContentUntilDone,
  loadOurProductsForContent,
} = await import('../app/lib/yugcontract/content-import.ts');

const runIdx = process.argv.indexOf('--resume');
const resumeId = runIdx !== -1 ? process.argv[runIdx + 1] : null;
const mode = process.argv.includes('--run')
  ? 'run'
  : process.argv.includes('--plan')
    ? 'plan'
    : null;
if (!mode) {
  console.error('Використання: --plan | --run [--resume RUN_ID]');
  process.exit(1);
}

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!supabaseUrl || !serviceKey) {
  console.error('Немає SUPABASE env-змінних');
  process.exit(1);
}
const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const t0 = Date.now();
console.log(`== YC CONTENT IMAGES (${mode}, ${new Date().toISOString()}) ==`);

// ---- inputs (read-only in BOTH modes up to the write section) ---------------
const stagedAll: StagedContentRow[] = [];
{
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from('yc_content_goods')
      .select('yugcontract_id,category_id,name,description,pictures,params')
      // Stable multi-page windows: OFFSET paging without ORDER BY can
      // return overlapping/gapped pages (live-verified). PK is the key.
      .order('yugcontract_id')
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`Помилка читання staging: ${error.message}`);
      process.exit(1);
    }
    stagedAll.push(...((data ?? []) as unknown as StagedContentRow[]));
    if ((data ?? []).length < PAGE) break;
    from += PAGE;
  }
}

let products: ContentProductRow[] = [];
try {
  products = await loadOurProductsForContent(client, stagedAll.map((s) => s.yugcontract_id));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Re-validate EVERY staged picture on the way out (never trust JSONB).
const stagedPictures = new Map<string, string[]>();
let invalidInStaging = 0;
for (const s of stagedAll) {
  const { urls, rejected } = revalidateStagedPictures(s.pictures as unknown);
  invalidInStaging += rejected;
  stagedPictures.set(s.yugcontract_id, urls);
}

const dbIdByYc = new Map(products.map((p) => [p.yugcontract_id ?? '', p.id]));
const planInput = [...dbIdByYc.entries()].map(([yugcontractId, dbId]) => ({ dbId, yugcontractId }));

// existing product_images for ALL matched products (.in chunks of 200 AND
// explicit pagination: PostgREST caps ANY response at 1000 rows even with
// .in() — a 200-product chunk can hold far more images than that)
const productDbIds = [...dbIdByYc.values()];
const existingImages: ProductImageRow[] = [];
for (let i = 0; i < productDbIds.length; i += 200) {
  const part = productDbIds.slice(i, i + 200);
  let from = 0;
  for (;;) {
    const PAGE = 1000;
    const { data, error } = await client
      .from('product_images')
      .select('id,product_id,image_url,alt,sort_order,is_main')
      .in('product_id', part)
      // Stable multi-page windows: OFFSET paging without ORDER BY can
      // return overlapping/gapped windows (live-verified: 72 dups + 73
      // missed rows on a 23848-row read → phantom INSERTs in --plan).
      // 'id' is unique and stable.
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`Помилка читання product_images: ${error.message}`);
      process.exit(1);
    }
    existingImages.push(...((data ?? []) as unknown as ProductImageRow[]));
    if ((data ?? []).length < PAGE) break;
    from += PAGE;
  }
}

const plan = planImageOps(planInput, stagedPictures, existingImages);

// ---- report -----------------------------------------------------------------
const matchedWithPictures = planInput.filter(
  (p) => (stagedPictures.get(p.yugcontractId)?.length ?? 0) > 0
).length;
const totalDesired = [...stagedPictures.values()].reduce((a, u) => a + u.length, 0);

console.log(`staging рядків:                 ${fmtInt(stagedAll.length)}`);
console.log(`matched товарів:                ${fmtInt(planInput.length)}`);
console.log(`  з картинками:                 ${fmtInt(matchedWithPictures)}`);
console.log(`  без картинок у staging:       ${fmtInt(plan.productsWithoutPictures)}`);
console.log(`URL у staging (після ревалідації): ${fmtInt(totalDesired)} (невалідних відхилено: ${fmtInt(invalidInStaging)})`);

const manualImages = existingImages.filter((r) => !isExternalImportedImage(r.image_url));
const externalExisting = existingImages.filter((r) => isExternalImportedImage(r.image_url));
console.log(`product_images зараз:           ${fmtInt(existingImages.length)} (manual/storage: ${fmtInt(manualImages.length)}, external: ${fmtInt(externalExisting.length)})`);
console.log(`товарів з manual-зображеннями:  ${fmtInt(plan.productsWithManualImages)}`);
console.log(`  з них main у manual:          ${fmtInt(plan.manualMainPreserved)} → hotlink НЕ отримає is_main`);

console.log(`\n== PLAN ==`);
console.log(`INSERT (нових external URL):    ${fmtInt(plan.inserts.length)}`);
console.log(`UPDATE (reorder/main в imported): ${fmtInt(plan.updates.length)}`);
console.log(`NO-OP (вже ідентичні):          ${fmtInt(plan.noops)}`);
console.log(`DELETE:                         0 (видалення свідомо НЕ реалізовано)`);
console.log(`stale imported (звіт лише):     ${fmtInt(plan.staleImported.length)}`);

if (plan.staleImported.length > 0) {
  console.log('  приклади stale:');
  for (const s of plan.staleImported.slice(0, 5)) {
    console.log(`    product=${s.product_id} url=${s.image_url.slice(0, 70)}…`);
  }
}
const dupUrlCounts = new Map<string, number>();
for (const ins of plan.inserts) dupUrlCounts.set(ins.image_url, (dupUrlCounts.get(ins.image_url) ?? 0) + 1);
const crossProductDups = [...dupUrlCounts.entries()].filter(([, c]) => c > 1);
console.log(`дублі URL між товарами серед INSERT: ${fmtInt(crossProductDups.length)}`);

const anomalies: string[] = [];
const multiMain = new Map<string, number>();
for (const row of existingImages) {
  if (row.is_main === true) multiMain.set(row.product_id, (multiMain.get(row.product_id) ?? 0) + 1);
}
const brokenMains = [...multiMain.entries()].filter(([, c]) => c > 1);
if (brokenMains.length > 0) anomalies.push(`товарів з >1 is_main=true СЬОГОДНІ: ${brokenMains.length}`);
if (invalidInStaging > 0) anomalies.push(`невалідних URL у staging: ${invalidInStaging}`);
console.log(anomalies.length > 0 ? `\nАНОМАЛІЇ:\n${anomalies.map((a) => `  ⚠ ${a}`).join('\n')}` : '\nАномалій немає.');

// ---- batch layout ------------------------------------------------------------
const idsForBatches = [...stagedPictures.keys()].sort();
const batches: string[][] = [];
for (let i = 0; i < idsForBatches.length; i += 200) {
  batches.push(idsForBatches.slice(i, i + 200));
}
console.log(`батчів буде:                    ${fmtInt(batches.length)} (phase='images', по ≤200 id)`);

if (mode === 'plan') {
  console.log('\n--plan: жодних записів (product_images не змінено).');
  process.exit(0);
}

// ---- real run ------------------------------------------------------------------
const runId =
  resumeId ?? `ycci-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
await ensureContentRun(
  client,
  runId,
  batches.map((ids, idx) => ({
    phase: 'images' as const,
    batchNo: idx + 1,
    payload: { ids },
  }))
);
console.log(`\n== Виконання run=${runId}: ${batches.length} батчів ==`);

const result = await runContentUntilDone(client, runId, (outcome) => {
  const mark = outcome.status === 'done' ? '✓' : '✗';
  console.log(`${mark} [${outcome.phase} #${outcome.batchNo}] ${outcome.message}`);
});

const totals = result.outcomes.reduce(
  (acc, o) => ({
    updated: acc.updated + o.counters.updated,
    skipped: acc.skipped + o.counters.skipped,
    errors: acc.errors + o.counters.errors,
  }),
  { updated: 0, skipped: 0, errors: 0 }
);
console.log(
  `\n== Підсумок (${((Date.now() - t0) / 1000).toFixed(1)} с): записано/оновлено ${fmtInt(totals.updated)}, пропущено ${fmtInt(totals.skipped)}, помилок ${fmtInt(totals.errors)} ==`
);
if (result.stopped) {
  console.log(`ЗУПИНЕНО: ${result.reason}`);
  console.log(`Повторний запуск (--run --resume ${runId}) продовжить з місця падіння.`);
  process.exit(1);
}
console.log('Images-імпорт завершено повністю.');
