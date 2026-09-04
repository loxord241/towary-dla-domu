/**
 * Post-apply verification for migration 014 (orders REVOKE SELECT).
 * READ-ONLY. Run AFTER applying 014 in the Supabase SQL Editor:
 *
 *   node scripts/tmp-verify-orders-revoke.mts
 *
 * Expected end-state:
 *   - anon SELECT on orders/order_items/customers → 42501 permission denied
 *     (previously: success + empty set);
 *   - baselines unchanged: products readable, product_stock_history blocked;
 *   - place_order still reachable through its EXECUTE grant (probe uses an
 *     invalid payload that the function itself rejects with P0400 — no write
 *     is possible or attempted);
 *   - service-role row counts unchanged (reference metadata only).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
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

// 1. The three order tables must now be privilege-blocked for anon.
for (const t of ['orders', 'order_items', 'customers']) {
  const { error } = await anon.from(t).select('id').limit(1);
  check(
    `anon ${t} blocked`,
    error?.code === '42501',
    error ? `code=${error.code}` : 'STILL ALLOWED — migration not applied?'
  );
}

// 2. Baselines must be untouched.
{
  const { error } = await anon.from('products').select('id').limit(1);
  check('baseline products still readable', !error, error?.code ?? '');
}
{
  const { error } = await anon.from('product_stock_history').select('id').limit(1);
  check('baseline stock_history still blocked', error?.code === '42501', error?.code ?? '');
}

// 3. Guest checkout path intact: place_order executes and rejects garbage.
{
  const { error } = await anon.rpc('place_order', { payload: 12345 });
  check(
    'place_order EXECUTE intact',
    !!error && String(error.message).includes('INVALID_PAYLOAD'),
    error ? `code=${error.code} ${error.message.slice(0, 40)}` : 'NO ERROR?!'
  );
}

// 4. Service-role reference counts must be unchanged (4/4/5 at audit time).
{
  const counts: Record<string, number | string> = {};
  for (const t of ['orders', 'order_items', 'customers']) {
    const { count, error } = await service
      .from(t)
      .select('id', { count: 'exact', head: true });
    counts[t] = error ? `ERR:${error.message}` : (count ?? -1);
  }
  console.log(`service reference counts: ${JSON.stringify(counts)} (audit baseline: 4/4/5)`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
