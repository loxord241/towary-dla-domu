// One-off (2026-09-11): какие активные wc-* не получают калькулятор рулонов
// (parseRollSize(name) === null) и почему.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { parseRollSize } from '../app/lib/wallpapers/parse.ts';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
const { data, error } = await client
  .from('products')
  .select('sku, name, created_at')
  .like('sku', 'wc-%')
  .eq('is_active', true)
  .order('created_at', { ascending: false });
if (error !== null) throw new Error(error.message);
const rows = data ?? [];
const noCalc = rows.filter((r) => parseRollSize(r.name) === null);
console.log(`wc-* active: ${rows.length}, без калькулятора: ${noCalc.length}`);
for (const r of noCalc) console.log(`  ${r.sku} | ${r.name}`);
