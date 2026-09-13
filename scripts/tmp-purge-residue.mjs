import { readFileSync } from 'node:fs';
try { for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if(m&&process.env[m[1]]===undefined) process.env[m[1]]=m[2]; } } catch {}
const { createClient } = await import('@supabase/supabase-js');
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });

const backup = JSON.parse(readFileSync('data/removed-categories-2026-09-12/products-full.json','utf8'));
const doomedIds = backup.products.map(p=>p.id);
const PAGE=50;
let deleted=0, kept=0;
for (let i=0;i<doomedIds.length;i+=PAGE){
  const chunk = doomedIds.slice(i,i+PAGE);
  const { data: survivors, error } = await svc.from('products').select('id,sku,category_id,is_active').in('id', chunk);
  if (error) { console.error('READ ERR', JSON.stringify(error)); process.exit(1); }
  // только те, что действительно осиротели (NULL category, нет junction) —
  // не задеваем ничего, что к этому моменту переезжено в живую категорию
  const orphans = [];
  for (const s of survivors ?? []) {
    if (s.category_id !== null) { kept++; continue; }
    const { data: jc } = await svc.from('product_categories').select('product_id').eq('product_id', s.id).limit(1);
    if ((jc ?? []).length > 0) { kept++; continue; }
    orphans.push(s.id);
  }
  if (orphans.length > 0) {
    const { error: delErr } = await svc.from('products').delete().in('id', orphans);
    if (delErr) { console.error('DEL ERR', JSON.stringify(delErr)); process.exit(1); }
    deleted += orphans.length;
  }
}
console.log('deleted:', deleted, '| kept (re-homed/order-ref):', kept);
const { count } = await svc.from('products').select('*', { count:'exact', head:true });
console.log('total products now:', count);
