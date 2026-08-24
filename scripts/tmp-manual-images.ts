/** Read-only: JSON dump of manual (non-external) product_images rows. */
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);

const out: Record<string, unknown>[] = [];
let from = 0;
for (;;) {
  const PAGE = 1000;
  const { data, error } = await client
    .from('product_images')
    .select('*')
    .order('id')
    .range(from, from + PAGE - 1);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    if (!/^https?:\/\//i.test(String(r.image_url))) out.push(r);
  }
  if ((data ?? []).length < PAGE) break;
  from += PAGE;
}
console.log(JSON.stringify(out, null, 2));
