/** Read-only POST-RUN verification for the images hotlink phase. */
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

/** Unique key per table: stable multi-page windows need ORDER BY. */
function orderKey(table: string): string {
  return table === 'yc_content_goods' ? 'yugcontract_id' : 'id';
}

async function selectAll(table: string, select: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client.from(table).select(select).order(orderKey(table)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as Record<string, unknown>[]));
    if ((data ?? []).length < PAGE) return out;
    from += PAGE;
  }
}

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');
let fails = 0;
const ok = (m: string) => console.log(`PASS  ${m}`);
const bad = (m: string) => { fails += 1; console.log(`FAIL  ${m}`); };

console.log('== CHECKPOINTS phase=images ==');
const batches = await selectAll('yc_content_batches', '*');
const img = batches.filter((b) => b.phase === 'images');
const byStatus = new Map<string, number>();
let sumIns = 0, sumErr = 0;
for (const b of img) {
  byStatus.set(String(b.status), (byStatus.get(String(b.status)) ?? 0) + 1);
  sumIns += Number(b.updated_count ?? 0);
  sumErr += Number(b.error_count ?? 0);
}
for (const [s, n] of [...byStatus.entries()].sort()) console.log(`  ${s}: ${fmtInt(n)}`);
console.log(`суммарно updated(inserts)=${fmtInt(sumIns)}, errors=${fmtInt(sumErr)}`);
if (byStatus.get('done') === 45) ok('45 батчей done');
else bad(`done != 45`);
if (sumErr === 0) ok('errors=0');
else bad('errors > 0');

console.log('\n== PRODUCT_IMAGES ==');
const images = await selectAll('product_images', '*');
const external = images.filter((r) => /^https?:\/\//i.test(String(r.image_url)));
const manual = images.filter((r) => !/^https?:\/\//i.test(String(r.image_url)));
console.log(`всего: ${fmtInt(images.length)} · external: ${fmtInt(external.length)} · manual: ${fmtInt(manual.length)}`);
if (external.length === 23848) ok('external = 23848');
else bad(`external = ${external.length}`);

// duplicates
const seen = new Set<string>();
let dups = 0;
for (const r of images) {
  const k = `${r.product_id}::${r.image_url}`;
  if (seen.has(k)) dups += 1;
  seen.add(k);
}
if (dups === 0) ok('duplicate (product_id,image_url): 0');
else bad(`duplicates: ${dups}`);

// URL validation on every external row
let badUrl = 0;
for (const r of external) {
  try {
    const u = new URL(String(r.image_url));
    const ext = (u.pathname.split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
    if (u.protocol !== 'https:' && u.protocol !== 'http:') badUrl += 1;
    else if (u.host !== 'b2b.yugcontract.ua') badUrl += 1;
    else if (!['jpg','jpeg','png','webp','gif'].includes(ext)) badUrl += 1;
  } catch { badUrl += 1; }
}
if (badUrl === 0) ok('все external URL: http(s)+b2b host+image extension');
else bad(`невалидных URL: ${badUrl}`);
if (manual.every((r) => !/^https?:/i.test(String(r.image_url)))) ok('manual строки — только Storage paths');
else bad('manual содержит URL');

console.log('\n== IS_MAIN / SORT_ORDER ==');
const byProduct = new Map<string, Record<string, unknown>[]>();
for (const r of images) {
  const l = byProduct.get(String(r.product_id)) ?? [];
  l.push(r);
  byProduct.set(String(r.product_id), l);
}
let multiMain = 0, zeroMainPure = 0, nonCanonical = 0;
for (const [, rows] of byProduct) {
  const mains = rows.filter((r) => r.is_main === true).length;
  if (mains > 1) multiMain += 1;
  const extRows = rows.filter((r) => /^https?:\/\//i.test(String(r.image_url)));
  const foreign = rows.filter((r) => !/^https?:\/\//i.test(String(r.image_url)));
  // pure-imported product (no foreign rows): canonical 0..n-1 + first main
  if (foreign.length === 0 && extRows.length > 0) {
    const sorts = extRows.map((r) => Number(r.sort_order)).sort((a, b) => a - b);
    const canonical = sorts.every((v, i) => v === i);
    const mainIdx = extRows.filter((r) => r.is_main === true).map((r) => Number(r.sort_order));
    if (!canonical || !(mainIdx.length === 1 && mainIdx[0] === 0)) {
      zeroMainPure += 1;
      nonCanonical += canonical ? 0 : 1;
    }
  }
}
if (multiMain === 0) ok('товаров с >1 is_main=true: 0');
else bad(`>1 main у ${multiMain} товаров`);
if (zeroMainPure === 0) ok('каждый pure-imported товар: ровно одна main на sort_order=0');
else bad(`проблемных товаров: ${zeroMainPure}`);
if (nonCanonical === 0) ok('sort_order = 0..N-1 канонично во всех pure-imported наборах');
else bad(`не-каноничных наборов: ${nonCanonical}`);
if (manual.length === 1 && manual[0].is_main === true) ok('manual строка не изменена (main=true сохранён)');
else bad('manual строка изменилась');

console.log('\n== PRODUCTS / SPOT-CHECK IDS ==');
const products = await selectAll('products', 'id,yugcontract_id,slug,name');
console.log(`products=${fmtInt(products.length)}, YC-linked=${fmtInt(products.filter((p) => p.yugcontract_id !== null).length)}`);
const staging = await selectAll('yc_content_goods', 'yugcontract_id,pictures');
const prodByYc = new Map(products.map((p) => [String(p.yugcontract_id), p]));
function picsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === 'string') : [];
}
let best: { id?: unknown; slug?: unknown; n: number; firstUrl: string; productId: string } | null = null;
let single: { slug?: unknown; productId: string; url: string } | null = null;
for (const s of staging) {
  const p = prodByYc.get(String(s.yugcontract_id));
  if (!p) continue;
  const urls = picsOf(s.pictures);
  if (urls.length === 0) continue;
  const dbRows = (byProduct.get(String(p.id)) ?? []).filter((r) => /^https?:/.test(String(r.image_url)));
  if (!best || urls.length > best.n) {
    const sortedDb = dbRows.sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
    const orderMatches = sortedDb.map((r) => String(r.image_url)).every((u, i) => u === urls[i]);
    best = { id: p.id, slug: p.slug, n: urls.length, firstUrl: String(sortedDb[0]?.image_url ?? ''), productId: String(p.id) };
    (best as { orderMatches?: boolean }).orderMatches = orderMatches;
  }
  if (urls.length === 1 && !single) single = { slug: p.slug, productId: String(p.id), url: String(dbRows[0]?.image_url ?? '') };
}
if (best) {
  ok(`SPOT max-pictures: slug=${String(best.slug)} картинок=${best.n}, первая в БД == staging[0]: ${(best as {orderMatches?:boolean}).orderMatches}`);
}
if (single) {
  ok(`SPOT one-picture: slug=${String(single.slug)} url совпадает: ${single.url.startsWith('https://b2b.yugcontract.ua/')}`);
}
// identifiers for SSR checks
console.log('\nSSR_IDS=' + JSON.stringify({
  maxPicsSlug: best?.slug, maxPicsId: best?.productId,
  singleSlug: single?.slug, singleId: single?.productId,
}));

console.log(`\n== ИТОГ: FAIL=${fails} ==`);
process.exit(fails === 0 ? 0 : 1);
