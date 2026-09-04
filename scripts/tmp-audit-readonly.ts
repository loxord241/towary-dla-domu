/**
 * READ-ONLY production audit (content/images import stage).
 * SELECT queries ONLY — no INSERT/UPDATE/DELETE/RPC anywhere.
 * Sections: A products, B content, C images, G-anon RLS probes.
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

const { createClient } = await import('@supabase/supabase-js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anonClient: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  { auth: { persistSession: false } }
);

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

async function selectAll(table: string, select: string): Promise<Record<string, unknown>[]> {
  // Stable multi-page windows: OFFSET paging without ORDER BY returns
  // overlapping/gapped pages on live Supabase (see pagination-hardening
  // invariant test). Order by each table's unique key.
  const orderCol =
    table === 'yc_content_goods'
      ? 'yugcontract_id'
      : 'id';
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(select)
      .order(orderCol)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as Record<string, unknown>[]));
    if ((data ?? []).length < PAGE) return out;
    from += PAGE;
  }
}

const isExt = (u: unknown): boolean => /^https?:\/\//i.test(String(u));
function urlOk(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.host !== 'b2b.yugcontract.ua') return false;
    const file = u.pathname.split('/').pop() ?? '';
    const dot = file.lastIndexOf('.');
    if (dot <= 0) return false;
    const ext = file.slice(dot + 1).toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
  } catch {
    return false;
  }
}
function picsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === 'string') : [];
}
function paramsOf(raw: unknown): { name: string; value: string }[] {
  if (!Array.isArray(raw)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (raw as any[]).flatMap((e) =>
    e && typeof e === 'object' && typeof e.name === 'string' && typeof e.value === 'string' ? [{ name: e.name, value: e.value }] : []
  );
}

console.log('== LOAD (paged ≤1000) ==');
const t0 = Date.now();
const [products, staging, images] = await Promise.all([
  selectAll('products', 'id,yugcontract_id,slug,name,sku,is_active,is_featured,description,specifications,price,old_price'),
  selectAll('yc_content_goods', 'yugcontract_id,category_id,name,description,pictures,params,fetched_at'),
  selectAll('product_images', '*'),
]);
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ============================== A. PRODUCTS ==============================
console.log('\n================ A. PRODUCT/CATALOG INTEGRITY ================');
const ycLinked = products.filter((p) => p.yugcontract_id !== null);
const manual = products.filter((p) => p.yugcontract_id === null);
console.log(`products total:            ${fmtInt(products.length)}`);
console.log(`YC-linked:                 ${fmtInt(ycLinked.length)} | manual: ${fmtInt(manual.length)}`);
console.log(`inactive total:            ${fmtInt(products.filter((p) => p.is_active === false).length)} (yc ${fmtInt(ycLinked.filter((p) => p.is_active === false).length)}, manual ${fmtInt(manual.filter((p) => p.is_active === false).length)})`);
console.log(`featured:                  ${fmtInt(products.filter((p) => p.is_featured === true).length)}`);

const noDesc = products.filter((p) => !p.description || String(p.description).trim() === '');
console.log(`без description:           ${fmtInt(noDesc.length)} (yc ${fmtInt(noDesc.filter((p) => p.yugcontract_id !== null).length)}, manual ${fmtInt(manual.filter((p) => noDesc.includes(p)).length)})`);
const noSpecs = products.filter((p) => p.specifications === null || p.specifications === undefined);
console.log(`без specifications:        ${fmtInt(noSpecs.length)} (yc ${fmtInt(noSpecs.filter((p) => p.yugcontract_id !== null).length)}, manual ${fmtInt(noSpecs.filter((p) => p.yugcontract_id === null).length)})`);
const specsEmptyArr = products.filter((p) => Array.isArray(p.specifications) && (p.specifications as unknown[]).length === 0);
console.log(`specifications=[] (порожній array): ${fmtInt(specsEmptyArr.length)}`);
const specsNonArray = products.filter((p) => p.specifications != null && !Array.isArray(p.specifications));
console.log(`specifications НЕ-array:   ${fmtInt(specsNonArray.length)} (CHECK мав би заборонити)`);

const imagesByProduct = new Map<string, Record<string, unknown>[]>();
for (const r of images) {
  const k = String(r.product_id);
  const l = imagesByProduct.get(k) ?? [];
  l.push(r);
  imagesByProduct.set(k, l);
}
const noImages = products.filter((p) => (imagesByProduct.get(String(p.id)) ?? []).length === 0);
console.log(`без зображень взагалі:     ${fmtInt(noImages.length)} (yc ${fmtInt(noImages.filter((p) => p.yugcontract_id !== null).length)}, manual ${fmtInt(noImages.filter((p) => p.yugcontract_id === null).length)})`);
const noImgActiveSample = noImages.filter((p) => p.is_active === true).slice(0, 5).map((p) => `${String(p.slug)} (${p.yugcontract_id ?? 'manual'})`);
if (noImgActiveSample.length > 0) console.log(`  приклади активних без фото: ${noImgActiveSample.join('; ')}`);

// staging coverage
const stagedIds = new Set(staging.map((s) => String(s.yugcontract_id)));
const notInStaging = ycLinked.filter((p) => !stagedIds.has(String(p.yugcontract_id)));
console.log(`YC-linked відсутні в staging (feed dump): ${fmtInt(notInStaging.length)}`);
const notInStagingActive = notInStaging.filter((p) => p.is_active === true);
console.log(`  з них АКТИВНИХ:          ${fmtInt(notInStagingActive.length)} ${notInStagingActive.slice(0, 3).map((p) => String(p.yugcontract_id)).join(',')}`);
const productYcSet = new Set(ycLinked.map((p) => String(p.yugcontract_id)));
const unmatchedStagedRows = staging.filter((s) => {
  // product exists?
  return !productYcSet.has(String(s.yugcontract_id));
});
console.log(`staging рядків без нашого товару: ${fmtInt(unmatchedStagedRows.length)} (очікувано ~4697)`);

// multi/zero main
let multiMain = 0;
let zeroMainWithImages = 0;
const zeroMainSamples: string[] = [];
for (const [pid, rows] of imagesByProduct) {
  const mains = rows.filter((r) => r.is_main === true).length;
  if (mains > 1) {
    multiMain += 1;
    if (zeroMainSamples.length < 3) zeroMainSamples.push(`multi-main pid=${pid} mains=${mains}`);
  }
  if (rows.length > 0 && mains === 0) {
    zeroMainWithImages += 1;
    if (zeroMainSamples.length < 6) zeroMainSamples.push(`zero-main pid=${pid} rows=${rows.length}`);
  }
}
console.log(`товарів з >1 is_main:      ${fmtInt(multiMain)}`);
console.log(`товарів з зображеннями, але 0 main: ${fmtInt(zeroMainWithImages)}${zeroMainSamples.length ? '\n  ' + zeroMainSamples.join('\n  ') : ''}`);

// duplicates
{
  const seen = new Set<string>();
  let dups = 0;
  for (const r of images) {
    const k = `${r.product_id}::${r.image_url}`;
    if (seen.has(k)) dups += 1;
    seen.add(k);
  }
  console.log(`duplicate (product_id,image_url): ${fmtInt(dups)}`);
}

// ============================== B. CONTENT ==============================
console.log('\n================ B. CONTENT CONSISTENCY ================');
const stagingById = new Map(staging.map((s) => [String(s.yugcontract_id), s]));
let descMatch = 0, descDiffers = 0, descLocalOnly = 0, descStagedOnlyMissingLocal = 0;
const diffSamples: string[] = [];
let specsMatch = 0, specsDiffer = 0, specsLocalNullStagedHas = 0;
const specDiffSamples: string[] = [];
let dupNamePreserved = 0;
let dupNameLost = 0;

for (const p of ycLinked) {
  const s = stagingById.get(String(p.yugcontract_id));
  if (!s) continue;
  const stagedDesc = s.description != null && String(s.description).trim() !== '' ? String(s.description).trim() : null;
  const localDesc = p.description != null && String(p.description).trim() !== '' ? String(p.description).trim() : null;
  if (stagedDesc !== null && localDesc === stagedDesc) descMatch += 1;
  else if (stagedDesc !== null && localDesc !== null && localDesc !== stagedDesc) {
    descDiffers += 1;
    if (diffSamples.length < 3) diffSamples.push(`${String(p.slug)}: len(local)=${localDesc.length} len(staged)=${stagedDesc.length} prefix_local="${localDesc.slice(0, 40)}"`);
  } else if (localDesc !== null && stagedDesc === null) descLocalOnly += 1;
  else if (localDesc === null && stagedDesc !== null) descStagedOnlyMissingLocal += 1;

  const stagedParams = paramsOf(s.params);
  const localSpecs = Array.isArray(p.specifications) ? (p.specifications as unknown[]) : null;
  const localNorm = localSpecs === null ? null : JSON.stringify(p.specifications);
  const stagedNorm = JSON.stringify(stagedParams);
  if (localSpecs === null) {
    if (stagedParams.length > 0) specsLocalNullStagedHas += 1;
  } else if (localNorm === stagedNorm) specsMatch += 1;
  else {
    specsDiffer += 1;
    if (specDiffSamples.length < 3) specDiffSamples.push(`${String(p.slug)}: local=${localSpecs.length} items, staged=${stagedParams.length} items`);
  }

  if (localSpecs) {
    const names = new Map<string, number>();
    for (const e of localSpecs as { name?: unknown }[]) {
      if (e && typeof e.name === 'string') names.set(e.name, (names.get(e.name) ?? 0) + 1);
    }
    const dups = [...names.values()].filter((c) => c > 1).length;
    if (dups > 0) dupNamePreserved += 1;
    const stNames = new Map<string, number>();
    for (const e of stagedParams) stNames.set(e.name, (stNames.get(e.name) ?? 0) + 1);
    const stDups = [...stNames.values()].filter((c) => c > 1).length;
    if (dups === 0 && stDups > 0) dupNameLost += 1;
  }
}
console.log(`desc: match=${fmtInt(descMatch)}, differs=${fmtInt(descDiffers)}, local-only(стейдж порожній)=${fmtInt(descLocalOnly)}, staged-має/local-немає=${fmtInt(descStagedOnlyMissingLocal)}`);
if (diffSamples.length) console.log('  приклади differs:\n  ' + diffSamples.join('\n  '));
console.log(`specs: match=${fmtInt(specsMatch)}, differ=${fmtInt(specsDiffer)}, local=null&staged>0=${fmtInt(specsLocalNullStagedHas)}`);
if (specDiffSamples.length) console.log('  приклади differ:\n  ' + specDiffSamples.join('\n  '));
console.log(`duplicate param names ЗБЕРЕЖЕНО у specs: ${fmtInt(dupNamePreserved)} товарів | втрачено (staged dup→local немає): ${fmtInt(dupNameLost)}`);

// dangerous HTML global scan over ALL stored descriptions
const dangerPatterns: [string, RegExp][] = [
  ['<script', /<script/i],
  ['on*= handlers', /\son[a-z]+\s*=/i],
  ['javascript:', /javascript:/i],
  ['data:', /data:/i],
  ['<iframe', /<iframe/i],
  ['style attr/tag', /(<style|\bstyle\s*=)/i],
];
const dangerCounts = new Map(dangerPatterns.map(([k]) => [k, 0]));
const dangerSamples = new Map<string, string>();
let descScanned = 0;
const imgSrcHosts = new Map<string, number>();
for (const p of products) {
  const d = p.description ? String(p.description) : '';
  if (!d) continue;
  descScanned += 1;
  for (const [k, re] of dangerPatterns) {
    if (re.test(d)) {
      dangerCounts.set(k, (dangerCounts.get(k) ?? 0) + 1);
      if (!dangerSamples.has(k)) dangerSamples.set(k, `${String(p.slug)}: …${d.slice(Math.max(0, d.search(re) - 30), d.search(re) + 50)}…`);
    }
  }
  for (const m of d.matchAll(/<img[^>]*?\ssrc=["']?([^"'\s>]+)/gi)) {
    try {
      const host = new URL(m[1] ?? '').host;
      imgSrcHosts.set(host, (imgSrcHosts.get(host) ?? 0) + 1);
    } catch {
      imgSrcHosts.set('<unparseable>', (imgSrcHosts.get('<unparseable>') ?? 0) + 1);
    }
  }
}
console.log(`HTML-скан проведено на ${fmtInt(descScanned)} описах:`);
for (const [k, v] of dangerCounts) console.log(`  ${k}: ${fmtInt(v)}${v > 0 && dangerSamples.has(k) ? `\n    приклад: ${dangerSamples.get(k)}` : ''}`);
const topHosts = [...imgSrcHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`img-src hosts всередині description HTML: ${topHosts.map(([h, c]) => `${h}×${fmtInt(c)}`).join(', ') || '—'}`);

// staging internal sanity
let stagingBadUrls = 0;
for (const s of staging) {
  for (const u of picsOf(s.pictures)) if (!urlOk(u)) stagingBadUrls += 1;
}
console.log(`staging pictures невалідних URL: ${fmtInt(stagingBadUrls)}`);

// ============================== C. IMAGES ==============================
console.log('\n================ C. IMAGE CONSISTENCY ================');
const external = images.filter((r) => isExt(r.image_url));
const manualImgs = images.filter((r) => !isExt(r.image_url));
console.log(`product_images: total=${fmtInt(images.length)}, external(hotlink)=${fmtInt(external.length)}, manual(storage)=${fmtInt(manualImgs.length)}`);
let invalidDbUrl = 0;
for (const r of external) if (!urlOk(String(r.image_url))) invalidDbUrl += 1;
console.log(`невалідних external URL у БД: ${fmtInt(invalidDbUrl)}`);
const manualHttp = manualImgs.filter((r) => isExt(r.image_url));
console.log(`manual-рядків із http(s) URL (мусор для дискримінатора): ${fmtInt(manualHttp.length)}`);
const manualNotRelPath = manualImgs.filter((r) => !/^[\w\-/.]+$/.test(String(r.image_url)));
console.log(`manual-рядків не зі схемою relative-path: ${fmtInt(manualNotRelPath.length)}`);

let missingUrls = 0, staleUrls = 0, orderMismatches = 0, mainAnomalies = 0, mixedProducts = 0, manualMainPreservedCount = 0;
const staleSamples: string[] = [];
const missingSamples: string[] = [];
const orderSamples: string[] = [];
let crossProductDupUrls = 0;
{
  const urlOwners = new Map<string, Set<string>>();
  for (const r of external) {
    const k = String(r.image_url);
    const set = urlOwners.get(k) ?? new Set<string>();
    set.add(String(r.product_id));
    urlOwners.set(k, set);
  }
  for (const [, owners] of urlOwners) if (owners.size > 1) crossProductDupUrls += 1;
  console.log(`однаковий URL у різних товарів: ${fmtInt(crossProductDupUrls)} URL`);

  for (const p of ycLinked) {
    const s = stagingById.get(String(p.yugcontract_id));
    const dbRows = imagesByProduct.get(String(p.id)) ?? [];
    const dbExt = dbRows.filter((r) => isExt(r.image_url));
    const dbForeign = dbRows.filter((r) => !isExt(r.image_url));
    if (dbForeign.length > 0) mixedProducts += 1;
    if (!s) continue;
    const desired = picsOf(s.pictures).filter(urlOk);
    const dbUrls = new Set(dbExt.map((r) => String(r.image_url)));
    for (const u of desired) {
      if (!dbUrls.has(u)) {
        missingUrls += 1;
        if (missingSamples.length < 3) missingSamples.push(`${String(p.slug)} ← ${u.slice(0, 70)}`);
      }
    }
    for (const r of dbExt) {
      if (!desired.includes(String(r.image_url))) {
        staleUrls += 1;
        if (staleSamples.length < 3) staleSamples.push(`${String(p.slug)} → ${String(r.image_url).slice(0, 70)}`);
      }
    }
    // order & main checks only when sets fully align
    if (dbForeign.length === 0 && dbExt.length > 0 && dbExt.length === desired.length) {
      const sorted = [...dbExt].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
      const seqOk = sorted.every((r, i) => String(r.image_url) === desired[i]);
      if (!seqOk) {
        orderMismatches += 1;
        if (orderSamples.length < 3) orderSamples.push(String(p.slug));
      }
      const sorts = sorted.map((r) => Number(r.sort_order ?? 0)).sort((a, b) => a - b);
      const canonical = sorts.every((v, i) => v === i);
      const mainsAt = sorted.map((r, i) => (r.is_main === true ? i : -1)).filter((i) => i >= 0);
      if (!canonical || mainsAt.length !== 1 || mainsAt[0] !== 0) mainAnomalies += 1;
    }
    if (dbForeign.length > 0) {
      const foreignMain = dbForeign.some((r) => r.is_main === true);
      const importedMain = dbExt.some((r) => r.is_main === true);
      if (foreignMain) {
        manualMainPreservedCount += 1;
        if (importedMain) mainAnomalies += 1;
      } else if (dbExt.length > 0) {
        const importedMains = dbExt.filter((r) => r.is_main === true).length;
        if (importedMains !== 1) mainAnomalies += 1;
      }
    }
  }
}
console.log(`mixed (manual+imported) товарів: ${fmtInt(mixedProducts)} | manual-main збережено: ${fmtInt(manualMainPreservedCount)}`);
console.log(`ВІДСУТНІ imported images (у staging, нема в БД): ${fmtInt(missingUrls)}${missingSamples.length ? '\n  ' + missingSamples.join('\n  ') : ''}`);
console.log(`STALE imported images (у БД, нема в staging): ${fmtInt(staleUrls)}${staleSamples.length ? '\n  ' + staleSamples.join('\n  ') : ''}`);
console.log(`порядок (sequence за staging) не збігається: ${fmtInt(orderMismatches)}${orderSamples.length ? ' (' + orderSamples.join(',') + ')' : ''}`);
console.log(`main/sort_order аномалій в imported наборах: ${fmtInt(mainAnomalies)}`);

// negative/huge sort orders among manual
const weirdManualSort = manualImgs.filter((r) => Number(r.sort_order ?? 0) < 0 || Number(r.sort_order ?? 0) > 10000);
console.log(`manual sort_order підозрілі: ${fmtInt(weirdManualSort.length)}`);

// ============================== G. ANON RLS PROBES ==============================
console.log('\n================ G. ANON RLS PROBES (read-only) ================');
for (const table of ['yc_content_goods', 'yc_content_batches', 'yc_import_batches']) {
  const { data, error } = await anonClient.from(table).select('*').limit(1);
  const rows = (data ?? []).length;
  console.log(`anon → ${table}: rows=${rows}${error ? ` error=${error.code}` : ''} → ${rows === 0 ? 'BLOCKED ✓' : 'READABLE ⚠'}`);
}
const { count: anonProdCount } = await anonClient.from('products').select('id', { count: 'exact', head: true });
console.log(`anon → products head-count: ${fmtInt(anonProdCount ?? -1)} (service бачить ${fmtInt(products.length)}; різниця = inactive, приховано RLS)`);

console.log(`\n== AUDIT SCAN DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s ==`);
