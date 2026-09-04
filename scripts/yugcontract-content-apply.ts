/**
 * Yugcontract CONTENT APPLY — products.description / specifications.
 *
 * Reads ONLY the yc_content_goods staging table (never get-content-goods)
 * and updates ONLY products.description + products.specifications via
 * checkpointed, resumable, diff-aware batches in yc_content_batches.
 * price/old_price/stock/name/slug/is_active/category_id/brand_id/sku are
 * structurally unreachable (assertContentFields guard + tests).
 *
 * Modes:
 *   node scripts/yugcontract-content-apply.ts --plan              read-only plan over staging
 *   node scripts/yugcontract-content-apply.ts --run               new run
 *   node scripts/yugcontract-content-apply.ts --run --resume ID   resume crashed run
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // env vars can come from the shell too
}

// Type-only static import: fully erased before execution.
import type { StagedContentRow } from '../app/lib/yugcontract/content-staging.ts';

const { createClient } = await import('@supabase/supabase-js');
const {
  planContentUpdates,
  planContentBatches,
  ensureContentRun,
  runContentUntilDone,
  loadStagedRows,
  loadOurProductsForContent,
} = await import('../app/lib/yugcontract/content-import.ts');

// Legacy belt-and-suspenders barrier for KNOWN empty-shell supplier ids
// (2026-08/09 audit). Detection of NEW shells no longer depends on this
// list: planContentUpdates applies the dynamic isEmptyHtmlShell guard to
// every staged description. Kept for compatibility/historical ids only.
const EXCLUDE_EMPTY_HTML_DESC_IDS: ReadonlySet<string> = new Set([
  '6377542', '6377543', '6466242', '6546069', '6655320', '6806965',
  '6819981', '6824731', '6837160', '6858140', '6860593', '6863794',
  '6874251', '6897244', '6910428', '6986702', '7022281', '7022284',
  '7038700', '7046725', '7079237', '7082039', '7088382', '7096545',
  '7111320', '7229372', '7231271', '7231276', '7250282', '7259480',
  '7261496', '7266825',
]);

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
console.log(`== YC CONTENT APPLY (${mode}, ${new Date().toISOString()}) ==`);

// ---- load ALL staged rows (paged ≤1000 per request) -------------------------
const stagedIds: string[] = [];
let from = 0;
for (;;) {
  const PAGE = 1000; // Supabase caps a range request at 1000 rows
  const { data, error } = await client
    .from('yc_content_goods')
    .select('yugcontract_id')
    // Stable multi-page windows: OFFSET paging without ORDER BY can
    // return overlapping/gapped pages (live-verified). PK is the key.
    .order('yugcontract_id')
    .range(from, from + PAGE - 1);
  if (error) {
    console.error(`Помилка читання staging: ${error.message}`);
    console.error('(Міграція 011 застосована? Таблиця yc_content_goods існує?)');
    process.exit(1);
  }
  const batch = data ?? [];
  stagedIds.push(...batch.map((r) => String(r.yugcontract_id)));
  if (batch.length < PAGE) break;
  from += PAGE;
}
console.log(`staging: ${fmtInt(stagedIds.length)} рядків`);

if (mode === 'plan') {
  // Full read-only plan: reuse executor loaders for identical semantics.
  const stagedRows: StagedContentRow[] = [];
  for (let i = 0; i < stagedIds.length; i += 1000) {
    stagedRows.push(...(await loadStagedRows(client, stagedIds.slice(i, i + 1000))));
  }
  const ourProducts = await loadOurProductsForContent(client, stagedIds);
  const plan = planContentUpdates(stagedRows, ourProducts, {
    excludeDescriptionIds: EXCLUDE_EMPTY_HTML_DESC_IDS,
  });
  const batches = planContentBatches(stagedIds);

  console.log(`наших товарів у плані:            ${fmtInt(ourProducts.length)}`);
  console.log(`потенційних UPDATE products:      ${fmtInt(plan.updates.length)}`);
  console.log(`  описів ЗАПОВНЕННЯ (було порожньо): ${fmtInt(plan.updates.filter((u) => !u.currentHadDescription && u.fields.description).length)}`);
  console.log(`  описів ПЕРЕЗАПИС (було непорожньо): ${fmtInt(plan.overwriteNonEmptyCount)} ← перевірте вручну`);
  console.log(`  specifications зміниться:           ${fmtInt(plan.updates.filter((u) => u.fields.specifications).length)}`);
  console.log(`  описів ВИКЛЮЧЕНО (статичний список): ${fmtInt(plan.excludedDescription)}`);
  console.log(`  описів ПОРОЖНІ HTML-ШЕЛЛІ (динамічний guard): ${fmtInt(plan.emptyShellDescription)}`);
  console.log(`ідентичних (no-op):               ${fmtInt(plan.identical)}`);
  console.log(`без опису в staging:              ${fmtInt(plan.noDescriptionAvailable)}`);
  console.log(`unmatched staging рядків:         ${fmtInt(plan.unmatchedStaged)}`);
  console.log(`батчів буде створено:             ${fmtInt(batches.length)} (по ≤200 id)`);
  console.log('\n--plan: жодних записів.');
  process.exit(0);
}

// ---- real run ---------------------------------------------------------------
const runId =
  resumeId ?? `ycc-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
const batches = planContentBatches(stagedIds);
await ensureContentRun(
  client,
  runId,
  batches.map((b) => ({
    phase: 'description' as const,
    batchNo: b.batchNo,
    payload: { ids: b.ids },
  }))
);
console.log(`\n== Виконання run=${runId}: ${batches.length} батчів ==`);

const result = await runContentUntilDone(client, runId, (outcome) => {
  const mark = outcome.status === 'done' ? '✓' : '✗';
  console.log(`${mark} [${outcome.phase} #${outcome.batchNo}] ${outcome.message}`);
}, { excludeDescriptionIds: EXCLUDE_EMPTY_HTML_DESC_IDS });

const totals = result.outcomes.reduce(
  (acc, o) => ({
    updated: acc.updated + o.counters.updated,
    skipped: acc.skipped + o.counters.skipped,
    errors: acc.errors + o.counters.errors,
  }),
  { updated: 0, skipped: 0, errors: 0 }
);
console.log(
  `\n== Підсумок (${((Date.now() - t0) / 1000).toFixed(1)} с): оновлено ${fmtInt(totals.updated)}, пропущено ${fmtInt(totals.skipped)}, помилок ${fmtInt(totals.errors)} ==`
);
if (result.stopped) {
  console.log(`ЗУПИНЕНО: ${result.reason}`);
  console.log(`Повторний запуск (--run --resume ${runId}) продовжить з місця падіння.`);
  process.exit(1);
}
console.log('Контент-імпорт завершено повністю.');
