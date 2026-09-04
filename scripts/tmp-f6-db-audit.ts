/** READ-ONLY F6 audit: product_images duplicates/NULLs/volumes + OpenAPI schema. SELECT only. */
import { readFileSync } from 'node:fs';
const root = '/home/loxord/projects/my-shop';
for (const line of readFileSync(root + '/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const { createClient } = await import('@supabase/supabase-js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false } });

async function paged(table: string, select: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const PAGE = 1000;
    const r = await c.from(table).select(select).order('id').range(from, from + PAGE - 1);
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < PAGE) return out;
    from += PAGE;
  }
}

// ---- OpenAPI introspection (columns, nullability, PK) ----
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const specRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}/rest/v1/?apikey=${encodeURIComponent(KEY)}`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spec: any = await specRes.json();
const def = spec?.definitions?.product_images;
console.log('== OpenAPI product_images ==');
console.log('PK:', JSON.stringify(def?.primary_key ?? []));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const [col, meta] of Object.entries<any>(def?.properties ?? {})) {
  console.log(`  ${col}: ${meta.format ?? meta.type}${def.required?.includes(col) ? ' NOT NULL' : ''} ${meta.description ? `[desc]` : ''}`);
}

// ---- data load ----
console.log('\n== DATA ==');
const imgs = await paged('product_images', '*');
console.log(`total rows: ${imgs.length}`);

// A. duplicates
const pair = new Map<string, number>();
for (const r of imgs) {
  const k = `${r.product_id}::${r.image_url}`;
  pair.set(k, (pair.get(k) ?? 0) + 1);
}
const dups = [...pair.entries()].filter(([, n]) => n > 1);
console.log(`unique (product_id,image_url): ${pair.size}; duplicates: ${imgs.length - pair.size}`);
for (const [k, n] of dups.slice(0, 5)) console.log(`  DUP ${k} ×${n}`);

// B. NULLs
const nullProduct = imgs.filter((r) => r.product_id === null || r.product_id === undefined);
const nullUrl = imgs.filter((r) => r.image_url === null || r.image_url === '');
console.log(`product_id IS NULL: ${nullProduct.length}; image_url IS NULL/'': ${nullUrl.length}`);

// C. manual vs imported
const ext = imgs.filter((r) => /^https?:\/\//i.test(String(r.image_url)));
const man = imgs.filter((r) => !/^https?:\/\//i.test(String(r.image_url)));
console.log(`external hotlink: ${ext.length}; manual storage: ${man.length}`);
// identical pair across classes impossible by construction; verify no shared url string anyway
const extUrls = new Set(ext.map((r) => String(r.image_url)));
const cross = man.filter((r) => extUrls.has(String(r.image_url))).length;
console.log(`url-строки, совпадающие между manual и external: ${cross}`);
// manual duplicates among themselves
const manPairs = new Map<string, number>();
for (const r of man) { const k = `${r.product_id}::${r.image_url}`; manPairs.set(k, (manPairs.get(k) ?? 0) + 1); }
console.log(`manual duplicate pairs: ${[...manPairs.values()].filter((n) => n > 1).length}`);
// manual row details
for (const r of man) console.log(`  manual row: pid=${r.product_id} url=${String(r.image_url).slice(0,50)} main=${r.is_main} sort=${r.sort_order}`);

// E. volumes
const perProduct = new Map<string, number>();
for (const r of imgs) perProduct.set(String(r.product_id), (perProduct.get(String(r.product_id)) ?? 0) + 1);
const counts = [...perProduct.values()].sort((a, b) => b - a);
const hist = new Map<number, number>();
for (const n of counts) hist.set(n, (hist.get(n) ?? 0) + 1);
console.log(`products with images: ${perProduct.size}; max/product: ${counts[0]}; median≈${counts[Math.floor(counts.length / 2)]}`);
console.log(`histogram top: ${[...hist.entries()].sort((a, b) => a[0] - b[0]).slice(0, 6).map(([n, c]) => `${n}фото×${c}`).join(', ')}`);
// top products need slug
const prods = await paged('products', 'id,slug');
const slugById = new Map(prods.map((p) => [String(p.id), String(p.slug)]));
const top = [...perProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`top-5: ${top.map(([pid, n]) => `${slugById.get(pid)?.slice(0, 30)}×${n}`).join(' | ')}`);

// mains
let multiMain = 0, zeroMain = 0;
const mainCnt = new Map<string, number>();
for (const r of imgs) if (r.is_main === true) mainCnt.set(String(r.product_id), (mainCnt.get(String(r.product_id)) ?? 0) + 1);
for (const [pid] of perProduct) { const n = mainCnt.get(pid) ?? 0; if (n > 1) multiMain += 1; if (n === 0) zeroMain += 1; }
console.log(`>1 is_main: ${multiMain}; with-images but 0 main: ${zeroMain}`);

// index-size estimation inputs: avg image_url length
const avgLen = ext.reduce((a, r) => a + String(r.image_url).length, 0) / Math.max(ext.length, 1);
console.log(`avg image_url length: ${avgLen.toFixed(0)} chars`);
