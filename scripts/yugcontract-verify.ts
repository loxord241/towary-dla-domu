/**
 * Yugcontract post-import verification (reusable regression tool).
 *
 * DB part: service-role SELECTs only, plus one place_order() round-trip
 * through the REAL public checkout route and an admin_cancel_order()
 * restore — the exact flow customers use. The test order is cancelled
 * afterwards: stock is restored atomically, status='cancelled'.
 *
 * Usage:
 *   1. Start the app:  npx next dev -p 3311   (or next start -p 3311)
 *   2. Run:            node scripts/yugcontract-verify.ts
 */
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
const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const BASE = 'http://127.0.0.1:3311';
const out = (label: string, value: unknown) =>
  console.log(`${label}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);

// ---------- pick a sample imported product ----------
interface SampleRow {
  id: string;
  yugcontract_id: string;
  sku: string;
  name: string;
  slug: string;
  price: number;
  old_price: number | null;
  stock_quantity: number;
  availability_status: string;
  category_id: string | null;
  brand_id: string | null;
}
const { data: sampleRows } = await client
  .from('products')
  .select('id,yugcontract_id,sku,name,slug,price,old_price,stock_quantity,availability_status,category_id,brand_id')
  .not('yugcontract_id', 'is', null)
  .gte('stock_quantity', 5)
  .limit(1)
  .returns<SampleRow[]>();
const sample = sampleRows?.[0];
if (!sample) throw new Error('немає імпортованого товару для перевірки');

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1;
  out(`${ok ? '✓' : '✗'} ${label}`, detail);
};

// Supabase clamps ANY page to max_rows (default 1000) — window ≤1000.
const PAGE_WINDOW = 1000;
interface Pageable {
  range(from: number, to: number): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}
async function pageAll<T>(make: () => Pageable): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_WINDOW) {
    const res = (await make().range(from, from + PAGE_WINDOW - 1)) as {
      data: T[] | null;
      error: { message: string } | null;
    };
    if (res.error) throw new Error(res.error.message);
    const batch = res.data ?? [];
    all.push(...batch);
    if (batch.length < PAGE_WINDOW) return all;
  }
}

// ---------- DB integrity ----------
interface CountResult {
  count: number | null;
  error: { message: string } | null;
}
async function countRows(q: PromiseLike<unknown>): Promise<number> {
  const res = (await q) as CountResult;
  if (res.error) throw new Error(res.error.message);
  return res.count ?? 0;
}

const totalProducts = await countRows(
  client.from('products').select('*', { count: 'exact', head: true })
);
const ycProducts = await countRows(
  client
    .from('products')
    .select('*', { count: 'exact', head: true })
    .not('yugcontract_id', 'is', null)
);

check('products.total', totalProducts === 4323, `${totalProducts} (очікувано 4323 = 4322 YC + 1 ручний)`);
check('products.ycCount', ycProducts === 4322, String(ycProducts));

// uniqueness of yugcontract_id
// (.order('id') on every paged read: OFFSET windows without ORDER BY are
// unstable across requests — overlapping/gapped pages, live-verified.)
const ycIdRows = await pageAll<{ yugcontract_id: string }>(() =>
  client.from('products').select('yugcontract_id').not('yugcontract_id', 'is', null).order('id')
);
const idSet = new Set(ycIdRows.map((r) => r.yugcontract_id));
check('products.yugcontractIdUnique', idSet.size === ycProducts && ycIdRows.length === ycProducts, `${idSet.size}/${ycProducts}`);

const skuSample = await pageAll<{ sku: string; yugcontract_id: string }>(() =>
  client.from('products').select('sku,yugcontract_id').not('yugcontract_id', 'is', null).order('id')
);
const skuMismatched = skuSample.filter((r) => r.sku !== `YC-${r.yugcontract_id}`);
check('products.skuPatternYC-id', skuMismatched.length === 0, `невідповідностей: ${skuMismatched.length}`);

// slug uniqueness across ALL products
const slugs = await pageAll<{ slug: string }>(() => client.from('products').select('slug').order('id'));
check('products.slugUnique', new Set(slugs.map((s) => s.slug)).size === slugs.length, `${slugs.length} рядків`);

// manual product untouched
const { data: manual } = await client
  .from('products')
  .select('id,sku,name,yugcontract_id,is_active')
  .eq('sku', '67 mango')
  .returns<{ id: string; sku: string; name: string; yugcontract_id: string | null; is_active: boolean }[]>();
check(
  'manualProduct.intact',
  manual?.length === 1 && manual[0].yugcontract_id === null && manual[0].is_active === true,
  JSON.stringify(manual?.[0] ?? null)
);

// price/old_price/stock rules on yc rows (column-vs-column in JS:
// PostgREST or-expressions cannot compare two columns)
const moneyRows = await pageAll<{
  id: string;
  price: number | null;
  old_price: number | null;
  stock_quantity: number;
}>(() =>
  client
    .from('products')
    .select('id,price,old_price,stock_quantity')
    .not('yugcontract_id', 'is', null)
    .order('id')
);
const moneyBad = moneyRows.filter(
  (r) =>
    r.price === null ||
    r.price < 0 ||
    r.stock_quantity < 0 ||
    (r.old_price !== null && r.old_price <= r.price)
);
check('products.moneyRules', moneyBad.length === 0, `порушень: ${moneyBad.length}`);
const withOldPrice = moneyRows.filter((r) => r.old_price !== null).length;
out('products.withOldPrice(rrp>price)', withOldPrice);

const availBad = await pageAll<{ id: string; stock_quantity: number; availability_status: string }>(() =>
  client
    .from('products')
    .select('id,stock_quantity,availability_status')
    .not('yugcontract_id', 'is', null)
    .order('id')
);
const availViolations = availBad.filter(
  (r) => (r.stock_quantity > 0) !== (r.availability_status === 'in_stock')
);
check('products.availabilityConsistent', availViolations.length === 0, `порушень: ${availViolations.length}`);

// orphan references
const orphanCat = await pageAll<{ id: string }>(() =>
  client.from('products').select('id').not('yugcontract_id', 'is', null).is('category_id', null).order('id')
);
check('products.noOrphanCategory', orphanCat.length === 0, String(orphanCat.length));

const orphanBrand = await pageAll<{ id: string }>(() =>
  client.from('products').select('id').not('yugcontract_id', 'is', null).is('brand_id', null).order('id')
);
check('products.noOrphanBrand', orphanBrand.length === 0, String(orphanBrand.length));

// categories hierarchy
const cats = await (async () => {
  const rows: { id: string; parent_id: string | null; name: string; slug: string; yugcontract_id: string | null }[] = [];
  let from = 0;
  for (;;) {
    // PAGE must stay <=1000: PostgREST silently caps ANY response at
    // max_rows, so a wider window stops the loop after page 1 (the old
    // 4999/5000 literals truncated any table above 1000 rows). The chain
    // is rebuilt each iteration and ordered by the unique `id`.
    const PAGE = 1000;
    const { data, error } = await client
      .from('categories')
      .select('id,parent_id,name,slug,yugcontract_id')
      .order('id')
      .range(from, from + PAGE - 1)
      .returns<typeof rows>();
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return rows;
    from += PAGE;
  }
})();
const ycCats = cats.filter((c) => c.yugcontract_id !== null);
const byUuid = new Map(cats.map((c) => [c.id, c]));
const depthOf = (c: (typeof cats)[number]): number => {
  let d = 0;
  let cur = c;
  while (cur.parent_id !== null) {
    const p = byUuid.get(cur.parent_id);
    if (!p) break;
    cur = p;
    d += 1;
  }
  return d;
};
const rootless = ycCats.filter((c) => c.parent_id === null);
const childlessParents = ycCats.filter((c) => c.parent_id !== null && !byUuid.has(c.parent_id!));
const maxDepth = Math.max(...ycCats.map(depthOf));
check('categories.ycCount', ycCats.length === 205, String(ycCats.length));
check('categories.rootsHaveNoParent', rootless.length >= 1 && rootless.length <= 11, `коренів: ${rootless.length}`);
check('categories.parentsResolved', childlessParents.length === 0, `розірваних зв’язків: ${childlessParents.length}`);
check('categories.maxDepth>=3', maxDepth >= 3, `${maxDepth}`);
const catSlugDupes = cats.length - new Set(cats.map((c) => c.slug)).size;
check('categories.slugUnique', catSlugDupes === 0, `дублів: ${catSlugDupes}`);

// brands
const brands = await (async () => {
  const { data, error } = await client.from('brands').select('id,name,slug').returns<{ id: string; name: string; slug: string }[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
})();
check('brands.total', brands.length === 71, `${brands.length} (69 нових + 2 ручні)`);

// stock history untouched by import (only order/cancel writes below)
const historyBefore = await countRows(
  client.from('product_stock_history').select('*', { count: 'exact', head: true })
);
out('product_stock_history.rows(before order test)', historyBefore);

if (failures > 0) {
  console.log(`\nDB-перевірки провалені: ${failures}`);
  process.exit(1);
}
console.log('\n-- DB-перевірки пройшли --\n');

// ---------- runtime: dev server must already run on :3311 ----------
async function j(url: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${url}`, init);
  const text = await res.text();
  return { status: res.status, text };
}

{
  const { status, text } = await j('/');
  check('GET /', status === 200, String(status));
}
{
  const { status, text } = await j('/catalog?search=LUMINARC');
  const ok = status === 200 && text.includes('LUMINARC');
  check('GET /catalog?search=LUMINARC', ok, `status=${status}, згадок бренду: ${(text.match(/LUMINARC/g) ?? []).length}`);
}
{
  const { status, text } = await j(`/product/${sample.slug}`);
  const ok = status === 200 && text.includes(sample.name.slice(0, 20));
  check(`GET /product/<slug>`, ok, `status=${status}, назва присутня: ${text.includes(sample.name.slice(0, 20))}`);
}

// cart-preview with the sample product
{
  const res = await fetch(`${BASE}/api/cart-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: sample.id }] }),
  });
  const bodyText = await res.text();
  const ok = res.status === 200 && bodyText.includes(sample.id) && bodyText.includes('unitPrice') && bodyText.includes('"stock"');
  check('POST /api/cart-preview', ok, `status=${res.status}`);
}

// admin guard regression: no cookies -> 401/403
{
  const res = await fetch(`${BASE}/api/admin/yugcontract/import/status`);
  check('adminGuard.blocksAnonymous', res.status === 401 || res.status === 403, String(res.status));
}

// real checkout round-trip on the imported product
{
  const stockBeforeRes = await client
    .from('products')
    .select('stock_quantity')
    .eq('id', sample.id)
    .single();
  const before = (stockBeforeRes.data as { stock_quantity: number } | null)?.stock_quantity ?? -1;

  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contact: { name: 'Тест Імпорту', email: 'import-test@example.com', phone: '+380000000000' },
      shipping: { city: 'Київ', note: 'stage-2B verification' },
      items: [{ productId: sample.id, variantId: null, quantity: 1 }],
    }),
  });
  const body = (await res.json()) as { orderNumber?: string; accessToken?: string; total?: number; error?: string };
  check('POST /api/orders (place_order)', res.status === 201 && !!body.orderNumber, JSON.stringify(body));

  if (body.orderNumber) {
    const afterRes = await client.from('products').select('stock_quantity').eq('id', sample.id).single();
    const after = (afterRes.data as { stock_quantity: number } | null)?.stock_quantity ?? -1;
    check('checkout.stockDecremented', after === before - 1, `${before} → ${after}`);

    // guest order view via HMAC token works for the imported product line
    const view = await j(`/orders/${body.orderNumber}?token=${encodeURIComponent(body.accessToken ?? '')}`);
    check('GET /orders/<num>?token=', view.status === 200, String(view.status));

    // cancel via service-role RPC (atomic restock, double-restock safe)
    const { data: ordRow } = await client
      .from('orders')
      .select('id,status')
      .eq('order_number', body.orderNumber)
      .single<{ id: string; status: string }>();
    const cancel = await client.rpc('admin_cancel_order', { p_order_id: ordRow?.id });
    const cancelledOk = cancel.error === null;
    check('admin_cancel_order', cancelledOk, cancel.error ? cancel.error.message : 'ok');

    const restoredRes = await client.from('products').select('stock_quantity').eq('id', sample.id).single();
    const restored = (restoredRes.data as { stock_quantity: number } | null)?.stock_quantity ?? -1;
    check('cancel.stockRestored', restored === before, `${after} → ${restored}`);

    const historyAfterRows = await client
      .from('product_stock_history')
      .select('id,source,reason,old_quantity,new_quantity')
      .eq('product_id', sample.id)
      .order('created_at', { ascending: false })
      .returns<{ id: string; source: string; reason: string; old_quantity: number; new_quantity: number }[]>();
    const orderEntries = (historyAfterRows.data ?? []).filter((h) => h.reason === 'order' || h.reason === 'return');
    check(
      'stockHistory.orderEntries',
      historyAfterRows.data !== null && orderEntries.length >= 1,
      JSON.stringify((historyAfterRows.data ?? []).slice(0, 3))
    );
    out('тестове замовлення', `${body.orderNumber} → cancelled (snapshot у order_items не змінювався)`);
  }
}

console.log(failures === 0 ? '\nУСІ ПЕРЕВІРКИ ПРОЙДЕНО ✓' : `\nПРОВАЛЕНО ПЕРЕВІРОК: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
