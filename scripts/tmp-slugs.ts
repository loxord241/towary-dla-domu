/**
 * Read-only helper: slugs/description shapes for the three REAL spot-check
 * products required by the product-page stage (YC-40360, YC-5969101, manual).
 * Zero writes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) {
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

async function pick(yugcontractId: string): Promise<Record<string, unknown> | null> {
  const { data } = await client
    .from('products')
    .select('sku,slug,name,description,short_description')
    .eq('yugcontract_id', yugcontractId)
    .limit(1);
  return (data ?? [])[0] ?? null;
}

const a = await pick('40360');
const b = await pick('5969101');

let manual: Record<string, unknown> | null = null;
{
  const { data } = await client
    .from('products')
    .select('sku,slug,name,description,yugcontract_id')
    .is('yugcontract_id', null)
    .range(0, 999);
  manual = ((data ?? []) as Record<string, unknown>[])[0] ?? null;
}

function brief(row: Record<string, unknown> | null): unknown {
  if (!row) return null;
  const d = typeof row.description === 'string' ? row.description : '';
  return {
    sku: row.sku,
    slug: row.slug,
    descLength: d.length,
    descStartsWithTag: /^\s*<[a-z!]/i.test(d),
    descSample: d.slice(0, 60),
  };
}

console.log(
  JSON.stringify({ yc40360: brief(a), yc5969101: brief(b), manual: brief(manual) }, null, 2)
);
