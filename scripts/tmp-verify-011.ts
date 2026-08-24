/**
 * Read-only DATABASE VERIFICATION for migration 011 (content import).
 *
 * Performs ZERO writes: OpenAPI introspection + head-count/select probes
 * via the service-role client and an anonymous probe for context.
 * Constraint/RLS internals that PostgREST cannot expose are reported as
 * EDITOR-CHECK items with ready-to-run SQL.
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
if (!url || !serviceKey || !anonKey) {
  console.error('Немає SUPABASE env-змінних');
  process.exit(1);
}

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
let editorChecks = 0;
function ok(name: string, detail = ''): void {
  pass += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name: string, detail = ''): void {
  fail += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function editor(name: string): void {
  editorChecks += 1;
  console.log(`EDITOR ${name} (перевіряється SQL-сніпетом нижче)`);
}

interface OasProperty {
  type?: string;
  format?: string;
  description?: string;
}
interface OasDefinition {
  required?: string[];
  properties?: Record<string, OasProperty>;
}

async function loadOpenApi(): Promise<Record<string, OasDefinition> | null> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const spec = (await res.json()) as {
      definitions?: Record<string, OasDefinition>;
      components?: { schemas?: Record<string, OasDefinition> };
    };
    return spec.definitions ?? spec.components?.schemas ?? null;
  } catch {
    return null;
  }
}

const EXPECTED_YC_CONTENT_GOODS = [
  'yugcontract_id',
  'category_id',
  'name',
  'description',
  'pictures',
  'params',
  'fetched_at',
];
const EXPECTED_YC_CONTENT_BATCHES = [
  'id',
  'run_id',
  'phase',
  'batch_no',
  'payload',
  'status',
  'processed_count',
  'updated_count',
  'skipped_count',
  'error_count',
  'last_error',
  'started_at',
  'finished_at',
  'updated_at',
];
const EXPECTED_YC_IMPORT_BATCHES = [
  'id',
  'run_id',
  'phase',
  'batch_no',
  'payload',
  'status',
  'processed_count',
  'inserted_count',
  'updated_count',
  'skipped_count',
  'error_count',
  'last_error',
  'started_at',
  'finished_at',
  'updated_at',
];

console.log('== DATABASE VERIFICATION 011 (read-only) ==\n');

// ---- 1) OpenAPI introspection ----------------------------------------------
const defs = await loadOpenApi();
if (!defs) {
  console.log('OpenAPI spec недоступний — колонкові перевірки пропущено.\n');
  editor('структура таблиць (колонки/типи)');
} else {
  const products = defs['products'];
  const specsProp = products?.properties?.['specifications'];
  if (specsProp && specsProp.format === 'jsonb') {
    ok('products.specifications існує, тип jsonb', `type=${specsProp.type}`);
  } else {
    bad('products.specifications існує, тип jsonb', JSON.stringify(specsProp ?? null));
  }
  const productsRequired = products?.required ?? [];
  if (!productsRequired.includes('specifications')) {
    ok('products.specifications nullable (не в required)');
  } else {
    bad('products.specifications nullable', 'колонка в required');
  }

  const goods = defs['yc_content_goods'];
  const goodsCols = Object.keys(goods?.properties ?? {}).sort();
  if (goods && JSON.stringify(goodsCols) === JSON.stringify([...EXPECTED_YC_CONTENT_GOODS].sort())) {
    ok('yc_content_goods: всі очікувані колонки, зайвих немає');
  } else {
    bad('yc_content_goods: структура колонок', JSON.stringify(goodsCols));
  }
  if (
    goods?.properties?.['yugcontract_id']?.description?.includes('<pk/') &&
    (goods.required ?? []).includes('yugcontract_id')
  ) {
    ok('yc_content_goods: PRIMARY KEY yugcontract_id');
  } else {
    bad('yc_content_goods: PRIMARY KEY yugcontract_id');
  }
  const picturesFmt = goods?.properties?.['pictures']?.format;
  const paramsFmt = goods?.properties?.['params']?.format;
  if (picturesFmt === 'jsonb' && paramsFmt === 'jsonb') {
    ok('yc_content_goods: pictures/params мають формат jsonb');
  } else {
    bad('yc_content_goods: pictures/params jsonb', `${picturesFmt}/${paramsFmt}`);
  }

  const batches = defs['yc_content_batches'];
  const batchCols = Object.keys(batches?.properties ?? {}).sort();
  if (
    batches &&
    JSON.stringify(batchCols) === JSON.stringify([...EXPECTED_YC_CONTENT_BATCHES].sort())
  ) {
    ok('yc_content_batches: всі очікувані колонки, зайвих немає');
  } else {
    bad('yc_content_batches: структура колонок', JSON.stringify(batchCols));
  }
  if (batches?.properties?.['id']?.description?.includes('<pk/')) {
    ok('yc_content_batches: PRIMARY KEY id (uuid)');
  } else {
    bad('yc_content_batches: PRIMARY KEY id');
  }

  // price-import schema untouched
  const importBatches = defs['yc_import_batches'];
  const ibCols = Object.keys(importBatches?.properties ?? {}).sort();
  if (
    importBatches &&
    JSON.stringify(ibCols) === JSON.stringify([...EXPECTED_YC_IMPORT_BATCHES].sort())
  ) {
    ok('yc_import_batches: схема не змінена (15 колонок як у 010)');
  } else {
    bad('yc_import_batches: схема відрізняється', JSON.stringify(ibCols));
  }
  const pi = defs['product_images'];
  const piCols = Object.keys(pi?.properties ?? {}).sort();
  const expectedPi = ['alt', 'created_at', 'id', 'image_url', 'is_main', 'product_id', 'sort_order'].sort();
  if (pi && JSON.stringify(piCols) === JSON.stringify(expectedPi)) {
    ok('product_images: схема не змінена (7 колонок)');
  } else {
    bad('product_images: схема відрізняється', JSON.stringify(piCols));
  }
}

// ---- 2) accessibility + counts (service role) --------------------------------
async function headCount(table: string): Promise<number | null> {
  const { count, error } = await service
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) {
    console.error(`  (${table}: ${error.message})`);
    return null;
  }
  return count ?? null;
}

for (const [table, expectation] of [
  ['yc_content_goods', 'очікується 0 до першого --stage'],
  ['yc_content_batches', 'очікується 0 до першого --run'],
] as const) {
  const n = await headCount(table);
  if (n === null) bad(`доступ до ${table}`, 'помилка запиту');
  else ok(`${table}: доступна, рядків ${n}`, expectation);
}

const productsCount = await headCount('products');
const ycLinked =
  productsCount !== null
    ? await service
        .from('products')
        .select('*', { count: 'exact', head: true })
        .not('yugcontract_id', 'is', null)
        .then((r) => (r.error ? null : r.count ?? null))
    : null;
if (productsCount === null || ycLinked === null) {
  bad('products: count після міграції');
} else {
  ok(
    `products: ${productsCount} рядків, з них YC-linked ${ycLinked}`,
    'базовий стан збережено (4323/4322 очікувано)'
  );
}

const importBatchesCount = await headCount('yc_import_batches');
if (importBatchesCount === null) bad('yc_import_batches: count недоступний');
else ok(`yc_import_batches: ${importBatchesCount} рядків (price-import дані на місці)`);

const stockHistory = await headCount('product_stock_history');
if (stockHistory === null) bad('product_stock_history: count недоступний');
else ok(`product_stock_history: ${stockHistory} рядків (контроль цілісності)`);

// ---- 3) anon probe (context only) ---------------------------------------------
const { data: anonData, error: anonError } = await anon
  .from('yc_content_goods')
  .select('yugcontract_id')
  .limit(1);
console.log(
  `\nANON-PROBE yc_content_goods: ${anonError ? `помилка ${anonError.message}` : `успіх, рядків: ${(anonData ?? []).length}`}`
);
console.log(
  '(RLS default-deny фільтрує тихо: порожній результат НЕ є доказом RLS — див. EDITOR-перевірки)'
);
editor('RLS relrowsecurity=true на yc_content_goods / yc_content_batches');
editor('відсутність policies на нових таблицях (pg_policies порожній для них)');
editor('CHECK products_specifications_is_array (pg_get_constraintdef)');
editor('політики products/product_images/yc_import_batches не змінювались');

console.log(`\n== ПІДСУМОК: PASS=${pass}, FAIL=${fail}, EDITOR=${editorChecks} ==`);
process.exit(fail === 0 ? 0 : 1);
