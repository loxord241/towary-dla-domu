/**
 * Yugcontract content FETCH → staging (stage 3).
 *
 * Makes EXACTLY ONE full get-content-goods call per invocation, reduces
 * the feed to staging rows (sanitized description, validated pictures,
 * {name,value} params) and upserts them into yc_content_goods.
 * Batch processing later reads ONLY this table.
 *
 * Duplicate upstream ids: deterministic FIRST-WINS (same rule the
 * dry-run reported on; never last-write-wins).
 *
 * Modes:
 *   node scripts/yugcontract-content-fetch.ts --plan    fetch + report, ZERO writes
 *   node scripts/yugcontract-content-fetch.ts --stage   fetch + report + upsert staging
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
const { getContentGoodsWithMeta, YugcontractError } = await import(
  '../app/lib/yugcontract/client.ts'
);
const {
  extractContentGoods,
  normalizeContentGood,
  dedupeContentGoods,
  matchContentGoodsToProducts,
  buildDescriptionStats,
  buildParamsStats,
} = await import('../app/lib/yugcontract/content-dry-run.ts');
const { reduceGoodsToStagedRows } = await import(
  '../app/lib/yugcontract/content-staging.ts'
);
const { planContentUpdates, planContentBatches } = await import(
  '../app/lib/yugcontract/content-import.ts'
);

// Type-only static imports: fully erased before execution.
import type { ContentProductRow } from '../app/lib/yugcontract/content-import.ts';
import type { OurProductRow } from '../app/lib/yugcontract/content-dry-run.ts';

/**
 * Paged products SELECT (Supabase caps a range request at 1000 rows).
 * specifications may not exist yet (migration 011 pending) → caller
 * retries without it.
 */
async function loadProductsForPlanPreview(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  withSpecifications: boolean
): Promise<{ rows: (OurProductRow & Pick<ContentProductRow, 'specifications'>)[]; specificationsAvailable: boolean }> {
  const PAGE = 1000;
  const select =
    'id,yugcontract_id,sku,name,description' + (withSpecifications ? ',specifications' : '');
  const rows: (OurProductRow & Pick<ContentProductRow, 'specifications'>)[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from('products')
      .select(select)
      // Stable multi-page windows: OFFSET paging without ORDER BY can
      // return overlapping/gapped pages (live-verified). 'id' is unique.
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as (OurProductRow & Pick<ContentProductRow, 'specifications'>)[]));
    if ((data ?? []).length < PAGE) {
      return { rows, specificationsAvailable: withSpecifications };
    }
    from += PAGE;
  }
}

const mode = process.argv.includes('--stage')
  ? 'stage'
  : process.argv.includes('--plan')
    ? 'plan'
    : null;
if (!mode) {
  console.error('Використання: --plan | --stage');
  process.exit(1);
}

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

const t0 = Date.now();
console.log(`== YC CONTENT FETCH (${mode}, ${new Date().toISOString()}) ==`);

// ---- 1) one full API call ---------------------------------------------------
let parsed: unknown;
let byteLength = 0;
try {
  ({ parsed, byteLength } = await getContentGoodsWithMeta());
} catch (err) {
  if (err instanceof YugcontractError) {
    console.error(
      `Помилка Yugcontract [${err.kind}${err.httpStatus ? `:${err.httpStatus}` : ''}]: ${err.message}`
    );
  } else {
    console.error('Непередбачена помилка запиту до Yugcontract');
  }
  process.exit(1);
}
console.log(
  `API викликано 1 раз: ${(byteLength / 1024 / 1024).toFixed(1)} MB за ${((Date.now() - t0) / 1000).toFixed(1)} с`
);

// ---- 2) normalize + dedupe --------------------------------------------------
let rawGoods: unknown[];
try {
  ({ goods: rawGoods } = extractContentGoods(parsed));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const validGoods = [];
for (const raw of rawGoods) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
  const { good } = normalizeContentGood(raw as Record<string, unknown>);
  if (good) validGoods.push(good);
}
const deduped = dedupeContentGoods(validGoods);

// ---- 3) reduce to staging rows ----------------------------------------------
const reduction = reduceGoodsToStagedRows(deduped.unique);

console.log(`raw goods:                 ${fmtInt(rawGoods.length)}`);
console.log(`валідних:                  ${fmtInt(validGoods.length)}`);
console.log(`унікальних (first-wins):   ${fmtInt(deduped.unique.length)} (дубрів рядків: ${fmtInt(deduped.duplicateRowCount)})`);
console.log(`описів санізовано:         ${fmtInt(reduction.sanitizedDescriptions)}`);
console.log(`URL картинок відхилено:`);
for (const r of reduction.rejectedPictures.slice(0, 10)) {
  console.log(`  [${r.reason}] ×${fmtInt(r.count)}  напр. ${r.exampleUrl.slice(0, 80)}`);
}
if (reduction.rejectedPictures.length === 0) console.log('  —');

/**
 * Read-only matching + future-apply preview against live products.
 * SELECT only — no staging, no writes of any kind.
 */
async function runPlanPreview(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    console.error('\nНемає SUPABASE env-змінних — план-превью недоступне');
    process.exit(1);
  }
  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let products;
  let specificationsAvailable = true;
  try {
    ({ rows: products, specificationsAvailable } =
      await loadProductsForPlanPreview(client, true));
  } catch {
    // migration 011 not applied yet → column products.specifications absent
    ({ rows: products, specificationsAvailable } =
      await loadProductsForPlanPreview(client, false));
  }

  const manualCount = products.filter((p) => p.yugcontract_id === null).length;
  console.log(`\nSELECT products: ${products.length} рядків (ручних: ${manualCount})`);
  if (!specificationsAvailable) {
    console.log(
      'УВАГА: products.specifications не існує (міграція 011 не застосована) — specifications у плані НЕ враховані.'
    );
  }

  const goodsById = new Map(deduped.unique.map((g) => [g.externalId, g]));
  const match = matchContentGoodsToProducts(goodsById, products);
  const matchedPairs = match.matchedLocal;

  console.log(`\n== MATCHING ==`);
  console.log(`matchedLocal:              ${fmtInt(matchedPairs.length)}`);
  console.log(`unmatchedLocal:            ${fmtInt(match.unmatchedLocal.length)}`);
  console.log(`ycUnused:                  ${fmtInt(match.ycUnusedIds.length)}`);
  if (match.unmatchedLocal.length > 0) {
    console.log(
      `  приклади: ${match.unmatchedLocal.slice(0, 5).map((p) => `${p.sku} (${p.yugcontract_id})`).join(', ')}`
    );
  }

  const descMatched = buildDescriptionStats(
    matchedPairs.map(({ good }) => ({
      externalId: good.externalId,
      description: good.description,
    }))
  );
  console.log(`\n== DESCRIPTION (matched) ==`);
  console.log(`з описом / порожніх:       ${fmtInt(descMatched.withDescription)} / ${fmtInt(descMatched.emptyDescription)}`);
  console.log(`HTML/plain:                ${fmtInt(descMatched.htmlCount)} / ${fmtInt(descMatched.plainTextCount)}`);
  console.log(
    `небезпечне (підрахунок):   iframe=${descMatched.danger.iframeTag}, style=${descMatched.danger.styleTagOrAttr}, script=${descMatched.danger.scriptTag}, on*=${descMatched.danger.eventHandlers}`
  );

  const paramsMatched = buildParamsStats(matchedPairs.map((m) => m.good), 10);
  console.log(`\n== PARAMETERS (matched) ==`);
  console.log(
    `товарів з params / без:    ${fmtInt(paramsMatched.withParams)} / ${fmtInt(paramsMatched.withoutParams)}`
  );
  console.log(
    `всього параметрів:         ${fmtInt(paramsMatched.totalParams)} (унікальних назв: ${fmtInt(paramsMatched.uniqueParamNames)})`
  );
  console.log(
    `конфлікти name→різні values: ${fmtInt(paramsMatched.goodsWithConflictingValues)}`
  );

  const contentRows: ContentProductRow[] = products.map((p) => ({
    id: p.id,
    yugcontract_id: p.yugcontract_id,
    description: p.description,
    specifications: specificationsAvailable ? p.specifications ?? null : null,
  }));
  const plan = planContentUpdates(reduction.rows, contentRows, {
    includeSpecifications: specificationsAvailable,
  });
  const batches = planContentBatches(deduped.unique.map((g) => g.externalId));

  console.log(`\n== APPLY PLAN PREVIEW (якщо після цього зробити --stage + --run) ==`);
  console.log(`потенційних UPDATE:        ${fmtInt(plan.updates.length)}`);
  const fills = plan.updates.filter((u) => u.fields.description && !u.currentHadDescription).length;
  console.log(`  заповнень порожніх:      ${fmtInt(fills)}`);
  console.log(`  перезаписів непорожніх:  ${fmtInt(plan.overwriteNonEmptyCount)} ← має бути 0`);
  console.log(
    `  specifications зміниться: ${specificationsAvailable ? fmtInt(plan.updates.filter((u) => u.fields.specifications).length) : '— (немає колонки)'}`
  );
  console.log(`ідентичних (no-op):        ${fmtInt(plan.identical)}`);
  console.log(`без опису в контенті:      ${fmtInt(plan.noDescriptionAvailable)}`);
  console.log(`батчів буде:               ${fmtInt(batches.length)} (по ≤200 id)`);
}

if (mode === 'plan') {
  await runPlanPreview();
  console.log('\n--plan: staging НЕ записано; БД лише прочитано (SELECT); Storage не чіпано.');
  process.exit(0);
}

// ---- 4) stage (service role only) -------------------------------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!supabaseUrl || !serviceKey) {
  console.error('Немає SUPABASE env-змінних');
  process.exit(1);
}
const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const CHUNK = 200;
let staged = 0;
for (let i = 0; i < reduction.rows.length; i += CHUNK) {
  const part = reduction.rows.slice(i, i + CHUNK).map((row) => ({
    yugcontract_id: row.yugcontract_id,
    category_id: row.category_id,
    name: row.name,
    description: row.description,
    pictures: row.pictures,
    params: row.params,
  }));
  const { error } = await client
    .from('yc_content_goods')
    .upsert(part, { onConflict: 'yugcontract_id' });
  if (error) {
    console.error(`Помилка upsert чанка ${i / CHUNK}: ${error.message}`);
    process.exit(1);
  }
  staged += part.length;
}

console.log(`\nstaging yc_content_goods: ${fmtInt(staged)} рядків записано/оновлено.`);
console.log('Далі: scripts/yugcontract-content-apply.ts --plan | --run');
