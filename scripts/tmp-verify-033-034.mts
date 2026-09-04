/**
 * Post-apply verification for migrations 033 (catalog write revokes) and
 * 034 (unique partial index on orders.liqpay_payment_id).
 * READ-ONLY. Run AFTER applying 033/034:
 *
 *   node scripts/tmp-verify-033-034.mts
 *
 * NOTE: information_schema / pg_catalog are NOT exposed via PostgREST
 * (PGRST106), so the catalog queries from the plan are printed at the end
 * for the Supabase SQL Editor; everything the REST surface can verify is
 * verified here, with zero write requests.
 *
 * Checks:
 *   1. anon SELECT still ALLOWED on all 15 catalog tables (033 must not
 *      have over-revoked the public read surface);
 *   2. orders.liqpay_payment_id: no duplicate non-null values in the live
 *      data (the 034 unique invariant, verified over the table contents);
 *   3. catalog SQL (information_schema.role_table_grants / pg_indexes)
 *      printed for SQL-Editor confirmation.
 */
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

// fail-fast: no clear env — nothing can be verified
const missing = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
  .filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`ENV MISSING: ${missing.join(', ')} — set them in .env.local first`);
  process.exit(1);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const { createClient } = await import('@supabase/supabase-js');
const anon: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  { auth: { persistSession: false } }
);
const service: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const CATALOG_TABLES = [
  'products',
  'product_variants',
  'product_images',
  'categories',
  'brands',
  'attributes',
  'attribute_values',
  'attribute_values_translations',
  'products_translations',
  'categories_translations',
  'brands_translations',
  'attributes_translations',
  'product_categories',
  'product_reviews',
  'store_announcements',
];

// 1. SELECT surface intact (033 revoked INSERT/UPDATE/DELETE only)
for (const t of CATALOG_TABLES) {
  const { error } = await anon.from(t).select('*').limit(1);
  check(`anon ${t} still readable`, !error, error ? `code=${error.code} — 033 over-revoked?` : '');
}

// 2. 034 invariant over live data: one liqpay payment id → at most one order
{
  const PAGE = 1000;
  const counts = new Map<string, number>();
  let from = 0;
  for (;;) {
    const { data, error } = await service
      .from('orders')
      .select('liqpay_payment_id')
      .not('liqpay_payment_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) {
      check('orders liqpay_payment_id scan', false, error.message);
      break;
    }
    for (const row of data as { liqpay_payment_id: string | number }[]) {
      counts.set(String(row.liqpay_payment_id), (counts.get(String(row.liqpay_payment_id)) ?? 0) + 1);
    }
    if ((data ?? []).length < PAGE) break;
    from += PAGE;
  }
  const dups = [...counts.entries()].filter(([, c]) => c > 1);
  check(
    `orders liqpay_payment_id duplicates (scanned ${counts.size} distinct ids)`,
    dups.length === 0,
    dups.length > 0 ? dups.slice(0, 5).map(([id, c]) => `${id}×${c}`).join(', ') : 'unique invariant holds'
  );
}

// 3. Catalog SQL for the SQL Editor (PostgREST does not expose catalogs)
console.log(`
-- Run in Supabase SQL Editor to confirm the catalog end-state:
-- (a) 033: expect 0 rows
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN (${CATALOG_TABLES.map((t) => `'${t}'`).join(',')})
  AND grantee IN ('anon','authenticated')
  AND privilege_type IN ('INSERT','UPDATE','DELETE');
-- (b) 034: expect exactly idx_orders_liqpay_payment_id_unique, UNIQUE + partial
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND indexname LIKE '%liqpay_payment_id%';`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
