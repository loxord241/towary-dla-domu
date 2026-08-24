/** READ-ONLY F6 PRE-MIGRATION scan + baseline fingerprint. SELECT only. */
import { readFileSync } from 'node:fs';
const root = '/home/loxord/projects/my-shop';
for (const line of readFileSync(root + '/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const { createClient } = await import('@supabase/supabase-js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false } });

const head = async (table: string, q = 'id') => {
  const r = await c.from(table).select(q, { count: 'exact', head: true });
  if (r.error) throw new Error(`${table}: ${r.error.message}`);
  return r.count as number;
};

// COUNT(*) vs COUNT(DISTINCT product_id, image_url)
// paged read — a single .range(0, 999999) would silently return only 1000
const rows: Record<string, unknown>[] = [];
{
  let from = 0;
  for (;;) {
    const PAGE = 1000;
    const r = await c.from('product_images').select('id,product_id,image_url,is_main').order('id').range(from, from + PAGE - 1);
    if (r.error) throw new Error(r.error.message);
    rows.push(...((r.data ?? []) as Record<string, unknown>[]));
    if ((r.data ?? []).length < PAGE) break;
    from += PAGE;
  }
}
const total = rows.length;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const distinctPairs = new Set(rows.map((r: any) => `${r.product_id}|${r.image_url}`)).size;
console.log(`COUNT(*)=${total}  COUNT(DISTINCT product_id,image_url)=${distinctPairs}  duplicates=${total - distinctPairs}`);

const ext = rows.filter((r: Record<string, unknown>) => /^https?:\/\//i.test(String(r.image_url))).length;
console.log(`external=${ext} manual=${total - ext}`);
const mainCnt = new Map<string, number>();
for (const r of rows as { is_main: unknown; product_id: unknown }[]) if (r.is_main === true) mainCnt.set(String(r.product_id), (mainCnt.get(String(r.product_id)) ?? 0) + 1);
let multiMain = 0;
for (const n of mainCnt.values()) if (n > 1) multiMain += 1;

// baseline fingerprints
const [products, orders, staging] = await Promise.all([head('products'), head('orders'), head('yc_content_goods', '*')]);
const upd = await c.from('products').select('updated_at').order('updated_at', { ascending: false }).limit(1);
console.log(`BASELINE: products=${products} product_images=${total} external=${ext} manual=${total - ext} orders=${orders} yc_content_goods=${staging} multiMain=${multiMain} max(products.updated_at)=${upd.data?.[0]?.updated_at}`);
