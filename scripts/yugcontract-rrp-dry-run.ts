/**
 * DRY-RUN (read-only): price = RRP migration preview.
 *
 * Fetches the LIVE get-price feed, joins it with our products table and
 * reports what a mass "products.price = rrp" update would do.
 * WRITES NOTHING to the database.
 *
 * Usage: node --experimental-strip-types scripts/yugcontract-rrp-dry-run.ts
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

const { createClient } = await import('@supabase/supabase-js');
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const yc = await import('../app/lib/yugcontract/client.ts');
const norm = await import('../app/lib/yugcontract/normalize.ts');

// ---- 1. live feed ----
console.log('Завантаження живого фіду get-price…');
const t0 = Date.now();
const parsed = await yc.getPriceCatalog();
const rawProducts = norm.extractRawProducts(parsed);
const feed = rawProducts.map(norm.normalizeYcProduct);
console.log(`Фід отримано: ${feed.length} рядків за ${Math.round((Date.now() - t0) / 1000)}с`);

// feed index by external id
interface FeedRow {
  rrp: number | null;
  price: number | null;
  qtyMain: number | null;
}
const feedById = new Map<string, FeedRow>();
let dupIds = 0;
for (const p of feed) {
  if (!p.externalId) continue;
  if (feedById.has(p.externalId)) {
    dupIds += 1;
    continue; // keep first occurrence
  }
  feedById.set(p.externalId, { rrp: p.rrp, price: p.price, qtyMain: p.qtyMain });
}

/** RRP validity rule: finite number > 0. */
function validRrp(v: number | null): v is number {
  return v !== null && Number.isFinite(v) && v > 0;
}

// ---- 2. our products ----
interface DbRow {
  id: string;
  yugcontract_id: string | null;
  sku: string;
  name: string;
  price: number | null;
  old_price: number | null;
}
const dbRows: DbRow[] = [];
{
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc
      .from('products')
      .select('id,yugcontract_id,sku,name,price,old_price')
      .not('yugcontract_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    dbRows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
}
console.log(`Товарів з yugcontract_id у БД: ${dbRows.length}\n`);

// ---- 3. join & classify ----
let noFeedRow = 0;
let hasRrp = 0;
let noRrpInFeed = 0; // row in feed but rrp null/invalid
let wouldChange = 0;
let unchanged = 0;
let priceBelowRrp = 0;
let priceAboveRrp = 0;
let priceEqualRrp = 0;

const rrps: number[] = [];
const examples: { sku: string; name: string; from: number | null; to: number | null; oldPriceNow: number | null }[] = [];
const noRrpExamples: { sku: string; name: string; currentPrice: number | null }[] = [];
let sumRrp = 0;

for (const row of dbRows) {
  const f = feedById.get(row.yugcontract_id!);
  if (!f) {
    noFeedRow += 1;
    continue;
  }
  if (!validRrp(f.rrp)) {
    noRrpInFeed += 1;
    if (noRrpExamples.length < 10) {
      noRrpExamples.push({ sku: row.sku, name: row.name, currentPrice: row.price });
    }
    continue;
  }
  hasRrp += 1;
  rrps.push(f.rrp);
  sumRrp += f.rrp;

  const cur = row.price ?? null;
  if (cur === null || Math.abs(cur - f.rrp) > 0.004) wouldChange += 1;
  else unchanged += 1;

  if (cur !== null) {
    if (cur < f.rrp) priceBelowRrp += 1;
    else if (cur > f.rrp) priceAboveRrp += 1;
    else priceEqualRrp += 1;
  }

  if (examples.length < 10) {
    examples.push({
      sku: row.sku,
      name: row.name.slice(0, 50),
      from: cur,
      to: Math.round(f.rrp * 100) / 100,
      oldPriceNow: row.old_price,
    });
  }
}

// stats over rrp values of AFFECTED products (would-change)
const changedRrps: number[] = [];
{
  for (const row of dbRows) {
    const f = feedById.get(row.yugcontract_id!);
    if (!f || !validRrp(f.rrp)) continue;
    const cur = row.price ?? null;
    if (cur !== null && Math.abs(cur - f.rrp) <= 0.004) continue;
    changedRrps.push(f.rrp);
  }
}
changedRrps.sort((a, b) => a - b);

const fmt = (n: number) => n.toLocaleString('uk-UA', { maximumFractionDigits: 2 });

console.log('================ DRY-RUN: ЦІНА = РРЦ ================');
console.log(`Товарів у БД (імпортовані):            ${dbRows.length}`);
console.log(`Немає в живому фіді (будуть не чиплені): ${noFeedRow}`);
console.log(`Мають коректний RRP:                   ${hasRrp}`);
console.log(`RRP відсутній/некоректний у фіді:       ${noRrpInFeed}`);
console.log('');
console.log(`БУДЕ ЗМІНЕНО (price ≠ rrp):            ${wouldChange}`);
console.log(`ЗАЛИШИТЬСЯ БЕЗ ЗМІН (price = rrp):     ${unchanged}`);
console.log('');
if (rrps.length > 0) {
  console.log(`RRP (всі валідні): min=${fmt(Math.min(...rrps))} max=${fmt(Math.max(...rrps))} avg=${fmt(sumRrp / rrps.length)}`);
}
if (changedRrps.length > 0) {
  const s = changedRrps.reduce((a, b) => a + b, 0);
  console.log(`RRP (лише ті, що зміняться): min=${fmt(changedRrps[0])} max=${fmt(changedRrps[changedRrps.length - 1])} avg=${fmt(s / changedRrps.length)}`);
}
console.log('');
console.log(`Зараз price < rrp:  ${priceBelowRrp}`);
console.log(`Зараз price > rrp:  ${priceAboveRrp}`);
console.log(`Зараз price = rrp:  ${priceEqualRrp}`);
console.log('');
console.log('Приклади price → rrp (перші 10):');
for (const e of examples) {
  console.log(`  ${e.sku} | ${e.from} → ${e.to} | (зараз old_price=${e.oldPriceNow}) | ${e.name}`);
}
if (noRrpExamples.length > 0) {
  console.log('\nПриклади БЕЗ RRP (ціну НЕ змінюємо, пишемо в отчёт):');
  for (const e of noRrpExamples) {
    console.log(`  ${e.sku} | price=${e.currentPrice} | ${e.name.slice(0, 50)}`);
  }
}
console.log('');
console.log('Додатково: дублікати id у фіді (ігноруються):', dupIds);
console.log('Старе значення old_price у всіх імпортованих буде NULL (знижки не показуємо).');
console.log('=====================================================');
console.log('READ-ONLY: жодних записів у БД не виконано.');
