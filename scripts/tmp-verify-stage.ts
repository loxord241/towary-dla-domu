/**
 * Read-only STAGING VERIFICATION for yc_content_goods (+ untouched-tables
 * sentinels). Zero writes. Modes:
 *   node scripts/tmp-verify-stage.ts              full staging audit
 *   node scripts/tmp-verify-stage.ts --sentinels  quick untouched-tables probe (JSON)
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

// Type-only static import: fully erased before execution.
import type { YcContentGood } from '../app/lib/yugcontract/content-dry-run.ts';

const { createClient } = await import('@supabase/supabase-js');
const { buildDescriptionStats, buildParamsStats } = await import(
  '../app/lib/yugcontract/content-dry-run.ts'
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!url || !serviceKey) {
  console.error('Немає SUPABASE env-змінних');
  process.exit(1);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client: any = createClient(url, serviceKey, { auth: { persistSession: false } });

async function headCount(table: string): Promise<number | null> {
  const { count, error } = await client
    .from(table)
    .select('*', { count: 'exact', head: true });
  return error ? null : count ?? null;
}

/** Paged select honoring the live 1000-row range cap. */
/** Unique key per table: stable multi-page windows need ORDER BY. */
function orderKey(table: string): string {
  return table === 'yc_content_goods' ? 'yugcontract_id' : 'id';
}

async function selectAll(table: string, select: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client.from(table).select(select).order(orderKey(table)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as Record<string, unknown>[]));
    if ((data ?? []).length < PAGE) return out;
    from += PAGE;
  }
}

function printSentinels(): Promise<void> {
  return (async () => {
    const [products, images, importBatches, stockHistory] = await Promise.all([
      headCount('products'),
      headCount('product_images'),
      headCount('yc_import_batches'),
      headCount('product_stock_history'),
    ]);
    const prodRows = await selectAll(
      'products',
      'updated_at,price,old_price,stock_quantity,name,slug,is_active'
    );
    const maxUpdated = prodRows.map((r) => String(r.updated_at)).sort().at(-1);
    console.log(
      `\nСЕНТИНЕЛИ: products=${products}, product_images=${images}, yc_import_batches=${importBatches}, stock_history=${stockHistory}`
    );
    console.log(`products.max(updated_at)=${maxUpdated}`);
  })();
}

if (process.argv.includes('--sentinels')) {
  await printSentinels();
  process.exit(0);
}

console.log('== STAGING VERIFICATION (read-only) ==\n');
let fails = 0;

// ---- staging content ---------------------------------------------------------
const goods = await selectAll(
  'yc_content_goods',
  'yugcontract_id,category_id,name,description,pictures,params'
);
console.log(`записів у yc_content_goods: ${fmtInt(goods.length)}`);

const ids = goods.map((g) => String(g.yugcontract_id));
const uniqueIds = new Set(ids).size;
if (uniqueIds === ids.length)
  console.log(`PASS  дублів yugcontract_id немає (${fmtInt(uniqueIds)} унікальних)`);
else {
  fails += 1;
  console.log(`FAIL  ДУБЛІ yugcontract_id: ${ids.length - uniqueIds}`);
}

interface Param {
  name: string;
  value: string;
}
let badPictures = 0;
let badParams = 0;
let totalPictures = 0;
const pictureUrls = new Set<string>();
let foreignHost = 0;
let nonImageExt = 0;
let totalParams = 0;
const paramGoods: YcContentGood[] = [];
const descPairs: { externalId: string; description: string | null }[] = [];
const dangerSamples: string[] = [];
const DANGER: RegExp[] = [
  /<script/i,
  /\bon[a-z]+\s*=/i,
  /javascript:/i,
  /data:/i,
  /<iframe/i,
  /\bstyle\s*=/i,
];

for (const g of goods) {
  if (!Array.isArray(g.pictures)) badPictures += 1;
  else {
    for (const u of g.pictures as unknown[]) {
      if (typeof u !== 'string') continue;
      totalPictures += 1;
      pictureUrls.add(u);
      try {
        const parsed = new URL(u);
        if (parsed.host !== 'b2b.yugcontract.ua') foreignHost += 1;
        const ext = (parsed.pathname.split('/').pop() ?? '').split('.').pop()?.toLowerCase();
        if (!['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext ?? '')) nonImageExt += 1;
      } catch {
        foreignHost += 1;
      }
    }
  }

  if (!Array.isArray(g.params)) badParams += 1;
  else {
    const params = (g.params as unknown[]).filter(
      (p): p is Param =>
        typeof p === 'object' && p !== null &&
        typeof (p as Param).name === 'string' && typeof (p as Param).value === 'string'
    );
    totalParams += params.length;
    if (params.length > 0) {
      paramGoods.push({
        externalId: String(g.yugcontract_id),
        categoryId: null,
        name: null,
        brand: null,
        ean: null,
        artikul: null,
        description: null,
        pictures: [],
        params,
      });
    }
  }

  const d =
    typeof g.description === 'string' && g.description.trim() !== '' ? g.description : null;
  if (d !== null) {
    descPairs.push({ externalId: String(g.yugcontract_id), description: d });
    if (dangerSamples.length < 5 && DANGER.some((re) => re.test(d))) {
      dangerSamples.push(String(g.yugcontract_id));
    }
  }
}

if (badPictures === 0) console.log('PASS  pictures: JSONB-масиви скрізь');
else {
  fails += 1;
  console.log(`FAIL  pictures не-масивів: ${badPictures}`);
}
if (badParams === 0) console.log('PASS  params: JSONB-масиви скрізь');
else {
  fails += 1;
  console.log(`FAIL  params не-масивів: ${badParams}`);
}
console.log(
  `картинки: всього ${fmtInt(totalPictures)}, унікальних ${fmtInt(pictureUrls.size)}, чужих host: ${foreignHost}, не-image розширень: ${nonImageExt}`
);
if (foreignHost === 0 && nonImageExt === 0)
  console.log('PASS  валідація URL у staging чиста (pdf/чужі host відсутні)');
else {
  fails += 1;
  console.log('FAIL  у staging потрапили невалідні URL!');
}

const descStats = buildDescriptionStats(descPairs);
console.log(
  `описи: ${fmtInt(descPairs.length)} з ${fmtInt(goods.length)} непорожніх; HTML ${fmtInt(descStats.htmlCount)} / plain ${fmtInt(descStats.plainTextCount)}; avg ${descStats.avgDescriptionLength}, max ${descStats.maxDescriptionLength}`
);
if (dangerSamples.length === 0)
  console.log(
    'PASS  небезпечного/несанитизированного HTML у staging НЕМАЄ (script/on*/js:/data:/iframe/style=)'
  );
else {
  fails += 1;
  console.log(`FAIL  знайдено небезпечні конструкції в описах: ${dangerSamples.join(', ')}`);
}
void totalPictures;

const paramsStats = buildParamsStats(paramGoods, 5);
console.log(
  `параметри: ${fmtInt(totalParams)} у ${fmtInt(paramsStats.withParams)} товарів; унікальних назв ${fmtInt(paramsStats.uniqueParamNames)}; конфліктів name→різні values: ${fmtInt(paramsStats.goodsWithConflictingValues)}`
);

// ---- matching vs products ------------------------------------------------------
const products = await selectAll('products', 'id,yugcontract_id,sku,description,specifications');
const byYc = new Map(products.map((p) => [String(p.yugcontract_id), p]));
const matchedIds = ids.filter((id) => byYc.has(id));
console.log(
  `\nmatched до products: ${fmtInt(matchedIds.length)} з ${fmtInt(goods.length)} (unmatched staged: ${fmtInt(goods.length - matchedIds.length)})`
);

await printSentinels();
console.log(`\n== ГОТОВО (read-only, нуль записів). FAIL=${fails} ==`);
process.exit(fails === 0 ? 0 : 1);

function fmtInt(n: number): string {
  return n.toLocaleString('uk-UA');
}
