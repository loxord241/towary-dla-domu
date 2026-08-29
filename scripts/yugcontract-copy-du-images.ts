/**
 * ONE-OFF: copy native Yugcontract images to 18 `_du` products (A2 group).
 *
 * Business context (audit 2026-08-29): the supplier keeps these goods as
 * `_du` ids in the price feed but ONLY as base ids in the content feed, so
 * the regular images pipeline (joined by exact yugcontract_id) can never
 * match them. This script copies the BASE id's validated pictures[] from
 * the yc_content_goods staging into product_images for the `_du` product —
 * WITHOUT touching products.yugcontract_id (price/stock sync must keep
 * working against the `_du` price-feed positions).
 *
 * Scope is a HARD allowlist of exactly 18 (du → base) pairs. No wildcards,
 * no mass discovery, no copying for any other `_du` product (A1/A3/B are
 * explicitly out of scope).
 *
 * Safety model:
 *  - default mode is --plan (read-only, zero writes);
 *  - --run re-verifies EVERY guard immediately before the first INSERT and
 *    aborts on any deviation from the plan (counts, ids, URL hosts);
 *  - inserts use ON CONFLICT DO NOTHING against the existing
 *    UNIQUE (product_id, image_url) index → idempotent re-runs;
 *  - NO updates, NO deletes, NO products writes; existing images of any
 *    kind are never modified (a target that already has images is an
 *    unexpected state → hard STOP);
 *  - is_main=true is assigned only to the first picture and only when the
 *    target has zero images (partial unique main-per-product index holds).
 *
 * Modes:
 *   node scripts/yugcontract-copy-du-images.ts --plan      read-only report
 *   node scripts/yugcontract-copy-du-images.ts --run       guarded writes
 *   node scripts/yugcontract-copy-du-images.ts --postcheck read-only verify
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // env vars can come from the shell too
}

// Explicit .ts extension on value imports: required by node:test ESM
// resolution and allowed by allowImportingTsExtensions for the Next bundler.
const { createClient } = await import('@supabase/supabase-js');
const { revalidateStagedPictures } = await import('../app/lib/yugcontract/content-images.ts');

/** HARD allowlist: exactly the 18 A2 pairs (audit 2026-08-29).
 *  Key = product yugcontract_id, value = base content-feed id. */
const DU_TO_BASE: Record<string, string> = {
  '6348981_du': '6348981',
  '6352159_du': '6352159',
  '6409008_du': '6409008',
  '6542557_du': '6542557',
  '6839342_du': '6839342',
  '6881881_du': '6881881',
  '6935524_du': '6935524',
  '6965699_du': '6965699',
  '6983775_du': '6983775',
  '6996846_du': '6996846',
  '7051997_du': '7051997',
  '7094176_du': '7094176',
  '7096065_du': '7096065',
  '7161075_du': '7161075',
  '7163829_du': '7163829',
  '7204794_du': '7204794',
  '7220908_du': '7220908',
  '7232093_du': '7232093',
};
// product yugcontract_id values are "<base>_du"
const DU_IDS = Object.keys(DU_TO_BASE);
const EXPECTED_TARGETS = DU_IDS.length;

const mode = process.argv.includes('--run')
  ? 'run'
  : process.argv.includes('--postcheck')
    ? 'postcheck'
    : 'plan';

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!supabaseUrl || !serviceKey) fail('Немає SUPABASE env-змінних');
const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

interface TargetRow {
  id: string;
  yugcontract_id: string;
}

function fail(msg: string): never {
  console.error(`STOP: ${msg}`);
  process.exit(1);
}

async function loadTargets(): Promise<TargetRow[]> {
  const { data, error } = await client
    .from('products')
    .select('id,yugcontract_id,is_active,price,sku,slug')
    .in('yugcontract_id', DU_IDS);
  if (error) fail(`products SELECT: ${error.message}`);
  const rows = data ?? [];
  if (rows.length !== EXPECTED_TARGETS) {
    fail(`очікувано ${EXPECTED_TARGETS} target-товарів, знайдено ${rows.length}`);
  }
  for (const r of rows) {
    if (!r.yugcontract_id.endsWith('_du')) {
      fail(`target ${r.id}: yugcontract_id=${r.yugcontract_id} не закінчується на _du`);
    }
  }
  return rows;
}

async function loadStagedPictures(bases: string[]): Promise<Map<string, string[]>> {
  const { data, error } = await client
    .from('yc_content_goods')
    .select('yugcontract_id,pictures')
    .in('yugcontract_id', bases);
  if (error) fail(`staging SELECT: ${error.message}`);
  const byId = new Map<string, string[]>();
  for (const row of data ?? []) {
    // never trust staging JSONB blindly — reuse the pipeline validator
    const { urls, rejected } = revalidateStagedPictures(row.pictures);
    if (rejected > 0) {
      fail(`base ${row.yugcontract_id}: ${rejected} невалідних URL у staging`);
    }
    byId.set(String(row.yugcontract_id), urls);
  }
  for (const base of bases) {
    const urls = byId.get(base);
    if (!urls) fail(`staging запис для base ${base} відсутній`);
    if (urls.length === 0) fail(`pictures[] порожні для base ${base}`);
  }
  return byId;
}

async function loadExistingImages(productIds: string[]) {
  const { data, error } = await client
    .from('product_images')
    .select('id,product_id,image_url,is_main')
    .in('product_id', productIds);
  if (error) fail(`product_images SELECT: ${error.message}`);
  return data ?? [];
}

function buildOps(targets: TargetRow[], staged: Map<string, string[]>, existing: { product_id: string }[]) {
  const existingByProduct = new Map<string, number>();
  for (const e of existing) existingByProduct.set(e.product_id, (existingByProduct.get(e.product_id) ?? 0) + 1);
  const inserts: { product_id: string; image_url: string; alt: null; sort_order: number; is_main: boolean }[] = [];
  const perTarget: { du: string; base: string; product_id: string; pics: number; existing: number; inserts: number; main: boolean }[] = [];
  for (const t of targets) {
    const base = DU_TO_BASE[t.yugcontract_id];
    if (!base) fail(`target ${t.yugcontract_id} відсутній в allowlist`);
    const urls = staged.get(base);
    if (!urls || urls.length === 0) fail(`немає pictures для target ${t.yugcontract_id} (base ${base})`);
    const existingCount = existingByProduct.get(t.id) ?? 0;
    if (existingCount > 0) {
      fail(`target ${t.yugcontract_id} вже має ${existingCount} зображень — неочікуваний стан`);
    }
    const allowMain = existingCount === 0;
    let n = 0;
    urls.forEach((url, idx) => {
      inserts.push({
        product_id: t.id,
        image_url: url,
        alt: null,
        sort_order: idx,
        is_main: allowMain && idx === 0,
      });
      n++;
    });
    perTarget.push({ du: t.yugcontract_id, base, product_id: t.id, pics: urls.length, existing: existingCount, inserts: n, main: allowMain });
  }
  return { inserts, perTarget };
}

if (mode === 'plan') {
  const targets = await loadTargets();
  const staged = await loadStagedPictures([...new Set(Object.values(DU_TO_BASE))]);
  const existing = await loadExistingImages(targets.map((t) => t.id));
  const { inserts, perTarget } = buildOps(targets, staged, existing);
  const mains = inserts.filter((i) => i.is_main).length;
  const hosts = new Set(inserts.map((i) => new URL(i.image_url).host));
  console.log('== YC COPY DU IMAGES (plan, READ-ONLY) ==');
  console.log(`targets:            ${fmtInt(perTarget.length)} (очікувано ${EXPECTED_TARGETS})`);
  for (const t of perTarget) {
    console.log(`  ${t.du} → ${t.base}  pics=${t.pics} inserts=${t.inserts} main=${t.main} product=${t.product_id}`);
  }
  console.log(`INSERT:             ${fmtInt(inserts.length)}`);
  console.log(`main assignments:   ${fmtInt(mains)}`);
  console.log(`UPDATE:             0`);
  console.log(`DELETE:             0`);
  console.log(`existing touched:   ${fmtInt(existing.length)}`);
  console.log(`hosts:              ${[...hosts].join(', ')}`);
  console.log('\n--plan: жодних записів. Для виконання: --run (окремий GO).');
  process.exit(0);
}

if (mode === 'postcheck') {
  const targets = await loadTargets();
  const ids = targets.map((t) => t.id);
  const { data: imgs } = await client
    .from('product_images')
    .select('product_id,is_main,image_url')
    .in('product_id', ids);
  const byProduct = new Map<string, { total: number; mains: number }>();
  for (const i of imgs ?? []) {
    const e = byProduct.get(i.product_id) ?? { total: 0, mains: 0 };
    e.total++;
    if (i.is_main) e.mains++;
    byProduct.set(i.product_id, e);
  }
  const missing = targets.filter((t) => (byProduct.get(t.id)?.total ?? 0) === 0);
  const multiMain = [...byProduct.entries()].filter(([, v]) => v.mains > 1);
  const noMain = targets.filter((t) => (byProduct.get(t.id)?.mains ?? 0) === 0);
  const externalHosts = new Set((imgs ?? []).map((i) => new URL(i.image_url).host));
  // product snapshot invariants
  const { data: prods } = await client
    .from('products')
    .select('id,yugcontract_id,is_active,price,sku,slug')
    .in('id', ids);
  const duStill = (prods ?? []).every((p: { yugcontract_id: string }) => p.yugcontract_id.endsWith('_du'));
  const { count: productsTotal } = await client.from('products').select('id', { count: 'exact', head: true });
  console.log(JSON.stringify({
    targets: targets.length,
    products_with_images: byProduct.size,
    missing_images: missing.map((t) => t.yugcontract_id),
    products_with_exactly_one_main: targets.length - noMain.length - multiMain.length,
    no_main: noMain.map((t) => t.yugcontract_id),
    multi_main: multiMain.length,
    du_ids_unchanged: duStill,
    products_total: productsTotal,
    image_hosts: [...externalHosts],
  }, null, 2));
  process.exit(0);
}

// ---- run mode: re-verify every guard, then write -----------------------------
console.log('== YC COPY DU IMAGES (RUN) ==');
const targets = await loadTargets();
const staged = await loadStagedPictures([...new Set(Object.values(DU_TO_BASE))]);
const existing = await loadExistingImages(targets.map((t) => t.id));
if (existing.length > 0) {
  fail(`${existing.length} існуючих зображень у targets — неочікуваний стан`);
}
// base ids must still be absent from products (no sibling appeared)
const bases = [...new Set(Object.values(DU_TO_BASE))];
const { data: baseRows } = await client.from('products').select('yugcontract_id').in('yugcontract_id', bases);
if ((baseRows ?? []).length > 0) {
  fail(`базові id з'явилися в products: ${(baseRows ?? []).map((r: { yugcontract_id: string }) => r.yugcontract_id).join(', ')}`);
}
const { inserts, perTarget } = buildOps(targets, staged, existing);
if (perTarget.length !== EXPECTED_TARGETS) fail(`targets ${perTarget.length} <> ${EXPECTED_TARGETS}`);
const mains = inserts.filter((i) => i.is_main).length;
if (mains !== EXPECTED_TARGETS) fail(`main assignments ${mains} <> ${EXPECTED_TARGETS}`);
for (const i of inserts) {
  const host = new URL(i.image_url).host;
  if (host !== 'b2b.yugcontract.ua') fail(`заборонений host ${host}`);
}
console.log(`guards OK: targets=${perTarget.length}, INSERT=${inserts.length}, main=${mains}, hosts=b2b.yugcontract.ua`);

// ON CONFLICT DO NOTHING against UNIQUE (product_id, image_url) — idempotent.
const CHUNK = 200;
let written = 0;
for (let i = 0; i < inserts.length; i += CHUNK) {
  const part = inserts.slice(i, i + CHUNK);
  const { error } = await client
    .from('product_images')
    .upsert(part, { onConflict: 'product_id,image_url', ignoreDuplicates: true });
  if (error) fail(`product_images upsert chunk ${i / CHUNK}: ${error.message}`);
  written += part.length;
  console.log(`chunk ${i / CHUNK + 1}: +${part.length} (усього ${written}/${inserts.length})`);
}
console.log(`\nГотово: ${written} URL скопійовано (ON CONFLICT DO NOTHING). DELETE=0, UPDATE=0, products не змінено.`);
console.log('Наступний крок: --postcheck для верифікації.');
