/**
 * READ-ONLY RLS audit probes for order tables (GO 2026-08).
 *
 * Anon/public key for all access simulations. Service key used ONCE at the
 * end for reference metadata (row counts only — no PII rows retrieved).
 * Absolutely no INSERT/UPDATE/DELETE/RPC-execution anywhere in this script.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, writeFileSync } from 'node:fs';
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
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const anon: any = createClient(URL, ANON, { auth: { persistSession: false } });
const service: any = createClient(URL, SERVICE, { auth: { persistSession: false } });

const out: string[] = [];
const log = (s: string) => { out.push(s); console.log(s); };

// ---------- 0. OpenAPI surface exposed to anon ----------
try {
  const res = await fetch(`${URL}/rest/v1/`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  const spec: any = await res.json();
  const defs = Object.keys(spec?.definitions ?? {});
  const orderish = defs.filter((d) =>
    /order|customer|stock_history/i.test(d)
  );
  log(`OPENAPI: exposed table definitions (${defs.length} total): ${JSON.stringify(defs)}`);
  log(`OPENAPI: order-related definitions: ${JSON.stringify(orderish)}`);
  const orderCols = spec?.definitions?.orders?.properties
    ? Object.keys(spec.definitions.orders.properties) : null;
  const itemCols = spec?.definitions?.order_items?.properties
    ? Object.keys(spec.definitions.order_items.properties) : null;
  const custCols = spec?.definitions?.customers?.properties
    ? Object.keys(spec.definitions.customers.properties) : null;
  log(`OPENAPI orders columns visible to anon: ${JSON.stringify(orderCols)}`);
  log(`OPENAPI order_items columns visible to anon: ${JSON.stringify(itemCols)}`);
  log(`OPENAPI customers columns visible to anon: ${JSON.stringify(custCols)}`);
  const paths = Object.keys(spec?.paths ?? {});
  const rpcPaths = paths.filter((p) => p.startsWith('/rpc/'));
  log(`OPENAPI rpc paths executable/listed for anon: ${JSON.stringify(rpcPaths)}`);
} catch (e: any) {
  log(`OPENAPI: failed — ${e.message}`);
}

const FAKE_UUID = '00000000-0000-4000-8000-000000000000';
const FAKE_NUM = 'ORD-20260101-AAAAAA';

async function probe(label: string, fn: () => Promise<any>): Promise<void> {
  try {
    const r = await fn();
    if (r.error) {
      log(`${label}: BLOCKED/ERROR code=${r.error.code} hint=${r.error.message?.slice(0, 80)}`);
    } else {
      const rows = Array.isArray(r.data) ? r.data.length : (r.data ? 1 : 0);
      log(`${label}: ALLOWED rows=${rows}${r.count !== null && r.count !== undefined ? ` count=${r.count}` : ''}`);
    }
  } catch (e: any) {
    log(`${label}: EXCEPTION ${e.message?.slice(0, 100)}`);
  }
}

log('\n--- BASELINES ---');
await probe('BASELINE products SELECT (expected ALLOWED)', () => anon.from('products').select('id').limit(1));
await probe('BASELINE product_stock_history SELECT (expected BLOCKED)', () => anon.from('product_stock_history').select('id').limit(1));

log('\n--- ORDERS via anon ---');
await probe('orders SELECT * LIMIT 1', () => anon.from('orders').select('*').limit(1));
await probe('orders head COUNT exact', () => anon.from('orders').select('id', { count: 'exact', head: true }));
await probe('orders select order_number,email only', () => anon.from('orders').select('order_number,email').limit(5));
await probe('orders filter by fake order_number', () => anon.from('orders').select('*').eq('order_number', FAKE_NUM));
await probe('orders filter by fake UUID id', () => anon.from('orders').select('*').eq('id', FAKE_UUID));
await probe('orders ORDER BY created_at enumeration window', () => anon.from('orders').select('id').order('created_at').range(0, 99));
await probe('orders ilike prefix enumeration ORD-%', () => anon.from('orders').select('order_number').ilike('order_number', 'ORD-%'));
await probe('orders EMBED items:order_items(*)', () => anon.from('orders').select('*,items:order_items(*)').limit(1));
await probe('orders EMBED customer:customers(email,phone)', () => anon.from('orders').select('*,customer:customers(email,phone)').limit(1));

log('\n--- ORDER_ITEMS via anon ---');
await probe('order_items SELECT * LIMIT 1', () => anon.from('order_items').select('*').limit(1));
await probe('order_items head COUNT exact', () => anon.from('order_items').select('id', { count: 'exact', head: true }));
await probe('order_items select price/sku/sku columns', () => anon.from('order_items').select('price,total,sku').limit(5));
await probe('order_items filter fake order_id UUID', () => anon.from('order_items').select('*').eq('order_id', FAKE_UUID));
await probe('order_items OFFSET enumeration range(0,999)', () => anon.from('order_items').select('id').range(0, 999));
await probe('order_items EMBED orders(order_number,email)', () => anon.from('order_items').select('*,orders(order_number,email)').limit(1));
await probe('order_items EMBED products(name,sku)', () => anon.from('order_items').select('*,products(name,sku)').limit(1));

log('\n--- CUSTOMERS via anon (PII) ---');
await probe('customers SELECT email,phone LIMIT 1', () => anon.from('customers').select('email,phone,first_name,last_name').limit(1));
await probe('customers head COUNT exact', () => anon.from('customers').select('id', { count: 'exact', head: true }));
await probe('customers ilike email domain scan', () => anon.from('customers').select('email').ilike('email', '%@%'));

log('\n--- WRITE-PATH sanity via anon (must be blocked, no writes attempted) ---');
// We do NOT run writes; instead verify the RPC surface only via OpenAPI listing above.
// Direct table insert is probed with an EMPTY abort-style payload that cannot
// validate: we send nothing — checking policy existence requires a real attempt,
// which this GO forbids. Documented as not-tested-by-request-of-GO.
log('WRITE PROBES: skipped by GO mandate (no data creation of any kind)');

log('\n--- SERVICE-ROLE REFERENCE METADATA (counts only, no PII) ---');
for (const t of ['orders', 'order_items', 'customers']) {
  try {
    const { count, error } = await service.from(t).select('id', { count: 'exact', head: true });
    log(`SERVICE count ${t}: ${error ? `ERR ${error.message}` : count}`);
  } catch (e: any) {
    log(`SERVICE count ${t}: EXCEPTION ${e.message}`);
  }
}

writeFileSync('/tmp/opencode/rls-audit-out.txt', out.join('\n'));
