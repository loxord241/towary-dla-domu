/**
 * Yugcontract import orchestrator (stage 2B).
 *
 * Uses EXACTLY the same lib functions as the admin API routes
 * (makeRealDeps / buildFullPlan / ensureRun / runUntilDone), so a local
 * run and a Vercel run share one code path and one checkpoint format.
 *
 * Modes:
 *   node scripts/yugcontract-import-run.ts --plan            read-only plan
 *   node scripts/yugcontract-import-run.ts --run             new run (plan first)
 *   node scripts/yugcontract-import-run.ts --run --resume ID resume crashed run
 *
 * Safety: prints the full pre-write plan before any write; stops on any
 * blocking conflict; every batch is checkpointed in yc_import_batches.
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

const { createClient } = await import('@supabase/supabase-js');
const {
  makeRealDeps,
  buildFullPlan,
  ensureRun,
  runUntilDone,
} = await import('../app/lib/yugcontract/import-run.ts');

const mode =
  process.argv.includes('--run') ? 'run' : process.argv.includes('--plan') ? 'plan' : null;
const resumeIdx = process.argv.indexOf('--resume');
const resumeId = resumeIdx !== -1 ? process.argv[resumeIdx + 1] : null;

if (!mode) {
  console.error('Використання: --plan | --run [--resume RUN_ID]');
  process.exit(1);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!supabaseUrl || !serviceKey) {
  console.error('Немає SUPABASE env-змінних');
  process.exit(1);
}
const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
const deps = makeRealDeps();

const t0 = Date.now();
console.log(`== План імпорту (read-only, ${new Date().toISOString()}) ==`);
const plan = await buildFullPlan(client, deps);

console.log(
  `категорії: створити ${plan.categories.create}, оновити ${plan.categories.update}`
);
console.log(
  `бренди: зв’язати існуючих ${plan.brands.linkExisting}, створити ${plan.brands.create}` +
    (plan.brands.nearMatches.length > 0
      ? `, НЕОБ'ЄДНАНИХ схожих: ${plan.brands.nearMatches.length}`
      : '')
);
for (const n of plan.brands.nearMatches.slice(0, 10)) {
  console.log(`  ~ фід "${n.ycBrand}" ≠ магазин "${n.ourBrand}" (тримаємо окремо)`);
}
console.log(
  `товари: у фіді ${plan.products.feedRows}, нових ${plan.products.insert}, оновлень ${plan.products.update}, пропущено ${plan.products.skip}`
);
console.log(
  `батчів: категорії=1, товари=${plan.productBatches.length} (листів ${plan.leaves})`
);

const allConflicts = [...plan.categories.conflicts, ...plan.products.conflicts];
if (allConflicts.length > 0) {
  console.log('\nБЛОКУЮЧІ КОНФЛІКТИ:');
  for (const c of allConflicts.slice(0, 20)) console.log(`  ✗ ${c}`);
  console.log('Імпорт зупинено — виправте конфлікти й повторіть.');
  process.exit(1);
}

if (mode === 'plan') {
  console.log('\n--plan: записи не виконувалися.');
  process.exit(0);
}

// ---- real run --------------------------------------------------------------
const runId = resumeId ?? `yc-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
const planned: { phase: 'categories' | 'products'; batchNo: number; payload?: { cats?: string[] } }[] = [
  { phase: 'categories', batchNo: 0 },
];
plan.productBatches.forEach((cats, i) => {
  planned.push({ phase: 'products', batchNo: i + 1, payload: { cats } });
});

await ensureRun(client, runId, planned);
console.log(`\n== Виконання run=${runId} ==`);

// Fresh deps for the execution phase: the planner instance already
// consumed the whole feed and its seen-set must not suppress re-fetches.
const execDeps = makeRealDeps();

let done = 0;
const result = await runUntilDone(client, runId, execDeps, (outcome) => {
  done += 1;
  const mark = outcome.status === 'done' ? '✓' : '✗';
  console.log(`${mark} [${outcome.phase} #${outcome.batchNo}] ${outcome.message}`);
});

console.log(`\n== Підсумок (${((Date.now() - t0) / 1000).toFixed(1)} с) ==`);
const totals = result.outcomes.reduce(
  (acc, o) => ({
    inserted: acc.inserted + o.counters.inserted,
    updated: acc.updated + o.counters.updated,
    skipped: acc.skipped + o.counters.skipped,
    errors: acc.errors + o.counters.errors,
  }),
  { inserted: 0, updated: 0, skipped: 0, errors: 0 }
);
console.log(
  `батчів виконано: ${done}; вставлено ${totals.inserted}; оновлено ${totals.updated}; пропущено ${totals.skipped}; помилок ${totals.errors}`
);
if (result.stopped) {
  console.log(`ЗУПИНЕНО: ${result.reason}`);
  console.log('Повторний запуск (--run --resume ' + runId + ') продовжить з місця падіння.');
  process.exit(1);
}
console.log('Імпорт завершено повністю.');
