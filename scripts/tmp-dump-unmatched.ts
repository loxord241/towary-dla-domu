import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const withPhotos = new Set<string>();
let from = 0;
for (;;) {
  const { data } = await client.from('products').select('id,sku').like('sku', 'wc-%').order('id').range(from, from + 999);
  if (!data || data.length === 0) break;
  const ids = data.map((p) => p.id);
  for (const c of chunk(ids, 200)) {
    const { data: imgs } = await client.from('product_images').select('product_id').in('product_id', c);
    for (const im of imgs ?? []) withPhotos.add(im.product_id);
  }
  for (const p of data) if (withPhotos.has(p.id)) withPhotos.add(p.sku);
  from += 1000;
  if (data.length < 1000) break;
}
function chunk<T>(arr: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
const items = JSON.parse(readFileSync('data/wallpaper-items-20260910.json', 'utf8')) as Array<{code: string; name: string; article: string}>;
const unmatched = items.filter((it) => {
  const sku = it.article ? 'wc-' + it.article.toLowerCase().replace(/\s+/g, '') : 'wc-x' + it.code;
  return !withPhotos.has(sku);
});
writeFileSync('data/wallpaper-unmatched-now.json', JSON.stringify(unmatched, null, 1));
console.log('unmatched now:', unmatched.length);
