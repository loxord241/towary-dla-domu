/**
 * APPLY: products.price = RRP for all imported Yugcontract products.
 *
 * Business rules (2026-08):
 *  - storefront price = supplier RRP;
 *  - NO discount display → old_price forced to NULL on YC rows;
 *  - rows without a valid RRP in the live feed keep their current price
 *    and are reported;
 *  - historical data (orders, order_items, snapshots) is never touched.
 *
 * Idempotent: re-running performs only the writes that still differ.
 * Usage: node --experimental-strip-types scripts/yugcontract-rrp-apply.ts [--yes]
 *   without --yes prints the plan summary and exits (extra safety).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const CONFIRMED = process.argv.includes('--yes');

const { createClient } = await import('@supabase/supabase-js');
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const yc = await import('../app/lib/yugcontract/client.ts');
const norm = await import('../app/lib/yugcontract/normalize.ts');

console.log('Завантаження живого фіду get-price…');
const parsed = await yc.getPriceCatalog();
const feed = norm.extractRawProducts(parsed).map(norm.normalizeYcProduct);

function validRrp(v: number | null): v is number {
  return v !== null && Number.isFinite(v) && v > 0;
}

interface FeedRow { rrp: number | null }
const feedById = new Map<string, FeedRow>();
for (const p of feed) {
  if (!p.externalId || feedById.has(p.externalId)) continue;
  feedById.set(p.externalId, { rrp: p.rrp });
}
console.log(`Фід: ${feed.length} рядків, унікальних id: ${feedById.size}`);

// ---- our products ----
interface DbRow {
  id: string;
  yugcontract_id: string | null;
  sku: string;
  price: number | null;
  old_price: number | null;
}
const dbRows: DbRow[] = [];
{
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc
      .from('products')
      .select('id,yugcontract_id,sku,price,old_price')
      .not('yugcontract_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    dbRows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
}

// ---- build per-row patches (only what actually differs) ----
interface Patch {
  id: string;
  sku: string;
  fields: Record<string, unknown>;
}
const patches: Patch[] = [];
let keptPrice = 0;
let alreadyOk = 0;
let noRrp = 0;
let notInFeed = 0;

for (const row of dbRows) {
  const f = feedById.get(row.yugcontract_id!);
  if (!f) {
    notInFeed += 1;
    continue;
  }
  if (!validRrp(f.rrp)) {
    noRrp += 1;
    console.error(`[RRP-ВІДСУТНІЙ] ${row.sku} — ціну не змінено (${row.price})`);
    continue;
  }
  const target = Math.round(f.rrp * 100) / 100;
  const fields: Record<string, unknown> = {};
  const priceDiffers = row.price === null || Math.abs(row.price - target) > 0.004;
  if (priceDiffers) fields.price = target;
  if ((row.old_price ?? null) !== null) fields.old_price = null;
  if (Object.keys(fields).length === 0) {
    alreadyOk += 1;
    continue;
  }
  patches.push({ id: row.id, sku: row.sku, fields });
  if (priceDiffers) keptPrice += 0; // counting below
}

const priceChanges = patches.filter((p) => p.fields.price !== undefined).length;
const oldPriceClears = patches.filter((p) => 'old_price' in p.fields).length;

console.log('\n================ ПЛАН ЗАСТОСУВАННЯ ================');
console.log(`Всього імпортованих товарів у БД: ${dbRows.length}`);
console.log(`Буде оновлено рядків (будь-яке поле): ${patches.length}`);
console.log(`  - зміна price на RRP:              ${priceChanges}`);
console.log(`  - очищення old_price → NULL:       ${oldPriceClears}`);
console.log(`Вже відповідає правилам (без запису): ${alreadyOk}`);
console.log(`Без коректного RRP (ціну не чіпаємо): ${noRrp}`);
console.log(`Немає у фіді (не чіпаємо):            ${notInFeed}`);
console.log('====================================================\n');

if (!CONFIRMED) {
  console.log('READ-ONLY прогін: додайте --yes для реального застосування.');
  process.exit(0);
}

// ---- apply with bounded concurrency ----
const CONCURRENCY = 8;
let applied = 0;
let errors = 0;
const failedSkus: string[] = [];

async function applyOne(p: Patch): Promise<void> {
  const { error } = await svc.from('products').update(p.fields).eq('id', p.id);
  if (error) {
    errors += 1;
    failedSkus.push(p.sku);
    return;
  }
  applied += 1;
  if (applied % 250 === 0) {
    console.log(`…застосовано ${applied}/${patches.length}`);
  }
}

const queue = [...patches];
const workers = Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const p = queue.shift();
    if (!p) break;
    await applyOne(p);
  }
});
await Promise.all(workers);

console.log(`\nГОТОВО: успішно=${applied}, помилок=${errors}`);
if (failedSkus.length > 0) {
  console.log('Помилкові SKU:', failedSkus.slice(0, 20).join(', '));
  process.exitCode = 1;
}
