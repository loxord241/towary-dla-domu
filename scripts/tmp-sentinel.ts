/**
 * Read-only sentinels: cryptographic fingerprints of every field the
 * content run must NEVER touch. Zero writes.
 *   node scripts/tmp-sentinel.ts
 */
import { createHash } from 'node:crypto';
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
if (!url || !serviceKey) {
  console.error('Немає SUPABASE env-змінних');
  process.exit(1);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client: any = createClient(url, serviceKey, { auth: { persistSession: false } });

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

async function headCount(table: string): Promise<number | null> {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
  return error ? null : count ?? null;
}

function fingerprint(label: string, rows: Record<string, unknown>[]): string {
  const sorted = [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return `${label} sha256=${createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16)} rows=${sorted.length}`;
}

// PROTECTED products fields ONLY (description/specifications/updated_at intentionally excluded)
const products = await selectAll(
  'products',
  'id,price,old_price,stock_quantity,name,slug,is_active,is_featured,category_id,brand_id,sku,currency'
);
console.log(fingerprint('products(protected-fields)', products));
console.log(`products.max(updated_at)=${products.length ? '' : ''}${(
  await selectAll('products', 'updated_at')
).map((r) => String(r.updated_at)).sort().at(-1)}`);

const images = await selectAll('product_images', '*');
console.log(fingerprint('product_images', images));

const importBatches = await selectAll('yc_import_batches', '*');
console.log(fingerprint('yc_import_batches', importBatches));

const stockHistory = await selectAll('product_stock_history', '*');
console.log(fingerprint('product_stock_history', stockHistory));

for (const t of ['orders', 'order_items', 'customers']) {
  console.log(`${t}: count=${await headCount(t)}`);
}

const staging = await selectAll('yc_content_goods', 'yugcontract_id');
console.log(fingerprint('yc_content_goods(ids)', staging));

const contentBatches =
  (await headCount('yc_content_batches')) === null
    ? 'недоступна'
    : String(await headCount('yc_content_batches'));
console.log(`yc_content_batches: count=${contentBatches}`);
