/**
 * READ-ONLY probe for the «Популярні товари» + category hierarchy design.
 * Anonymous (publishable) key only — mirrors the storefront access path.
 * SELECT only, no writes of any kind.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
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
const client: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  { auth: { persistSession: false } }
);

// 1. is_featured reality check
const { count: featuredCount, error: featuredErr } = await client
  .from('products')
  .select('id', { count: 'exact', head: true })
  .eq('is_featured', true)
  .eq('is_active', true);
console.log('featured(active):', featuredErr ? `ERR ${featuredErr.message}` : featuredCount);

// 2. anonymous read on order_items / product_stock_history must be blocked
const oi = await client.from('order_items').select('quantity').limit(1);
console.log('order_items anon read:', oi.error ? `blocked (${oi.error.code ?? 'error'})` : `ALLOWED rows=${oi.data?.length}`);
const psh = await client.from('product_stock_history').select('id').limit(1);
console.log('stock_history anon read:', psh.error ? `blocked (${psh.error.code ?? 'error'})` : `ALLOWED rows=${psh.data?.length}`);

// 3. categories structure
const cats = await client.from('categories').select('id,parent_id,name,slug,is_active').limit(1000);
if (cats.error) {
  console.log('categories ERR', cats.error.message);
} else {
  const all = cats.data ?? [];
  const active = all.filter((c: any) => c.is_active);
  const byId = new Map(all.map((c: any) => [c.id, c]));
  const roots = active.filter((c: any) => !c.parent_id || !byId.has(c.parent_id));
  const depthOf = (c: any): number => {
    let d = 0;
    let cur = c;
    while (cur.parent_id && byId.has(cur.parent_id)) {
      cur = byId.get(cur.parent_id);
      d += 1;
      if (d > 10) break;
    }
    return d;
  };
  const depths: Record<number, number> = {};
  for (const c of active) depths[depthOf(c)] = (depths[depthOf(c)] ?? 0) + 1;
  console.log('categories total:', all.length, 'active:', active.length);
  console.log('active roots:', roots.length, 'depth histogram:', JSON.stringify(depths));
  // duplicate names among active
  const nameCounts = new Map<string, number>();
  for (const c of active as any[]) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
  const dupes = [...nameCounts.entries()].filter(([, n]) => n > 1);
  console.log('duplicate active names:', dupes.length);
  console.log('sample dupes:', JSON.stringify(dupes.slice(0, 5)));
  // sample root names
  console.log('root sample:', JSON.stringify(roots.slice(0, 11).map((r: any) => r.name)));
}

// 4. total visible products (eligibility = has images)
const vis = await client
  .from('products')
  .select('id, images:product_images!inner(id)', { count: 'exact', head: true })
  .eq('is_active', true);
console.log('visible products (has images):', vis.error ? `ERR ${vis.error.message}` : vis.count);

process.exit(0);
