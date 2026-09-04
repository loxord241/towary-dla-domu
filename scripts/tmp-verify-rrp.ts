/** Read-only: post-apply verification of price=RRP migration. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const { createClient } = await import('@supabase/supabase-js');
const anon = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { persistSession: false } }
);

let fails = 0;
const check = (l: string, ok: boolean, d = '') => { if (!ok) fails++; console.log(`${ok ? '✓' : '✗'} ${l}${d ? ' — ' + d : ''}`); };

// scan all YC products via ANON (storefront view)
interface Row { price: number; old_price: number | null; availability_status: string }
const rows: Row[] = [];
{
  for (let from = 0; ; from += 1000) {
    const { data, error } = await anon
      .from('products')
      .select('price,old_price,availability_status')
      .not('yugcontract_id', 'is', null)
      .order('id')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
}
const withOldPrice = rows.filter((r) => r.old_price !== null).length;
const prices = rows.map((r) => r.price);
check('все YC-товары видимы на витрине', rows.length === 4322, String(rows.length));
check('old_price = NULL у всех YC-товаров (нет скидок)', withOldPrice === 0, `с old_price: ${withOldPrice}`);
check('цены > 0', prices.every((p) => p > 0));
console.log(`min=${Math.min(...prices)} max=${Math.max(...prices)} avg=${(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)}`);

// spot-check the user's example pattern: no strikethrough on product page HTML
{
  const res = await fetch('http://127.0.0.1:3311/product/albom-ufo-10x15x200-pp-46200');
  const html = await res.text();
  const hasStrike = html.includes('line-through');
  const m = html.match(/text-lg font-bold text-blue-700\\",\\"children\\":\[(\d+)/);
  check('product page: цена 249 (RRP), без зачёркнутой цены', !hasStrike && m?.[1] === '249', `price=${m?.[1]}, strike=${hasStrike}`);
}

// historical orders untouched
{
  const svcMod = await import('@supabase/supabase-js');
  const svc = svcMod.createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: orders } = await svc.from('orders').select('id').limit(5);
  console.log(`~ исторические orders на месте: ${orders?.length ?? 0}+ записей видимо (SELECT ok)`);
}

console.log(fails === 0 ? '\nPOST-APPLY CHECKS PASSED' : `\nFAILURES: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
