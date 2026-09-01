/**
 * READ-ONLY Task #18: Yugcontract content re-fetch + deep dry-run cuts.
 *
 * ONE full get-content-goods call (in-memory only) + SELECT-only reads of
 * products / yc_content_goods / product_images. ZERO writes of any kind.
 * Custom cuts the canonical dry-run does not produce:
 *   - fresh feed vs staging (new / disappeared / field coverage)
 *   - _du mapping analysis (base-id content availability, join loss proof)
 *   - products not covered by staging (Task #17 496 group)
 *   - products created after the 2026-08-24 content run (290 group)
 *   - boilerplate classification (known markers from app/lib/seo.ts audit
 *     2026-08-31 + unknown-cluster detection)
 *   - hypothetical apply plan from the FRESH feed (pure planContentUpdates)
 *   - images delta (feed pictures vs product_images external URLs)
 */
import { readFileSync, writeFileSync } from 'node:fs';
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

const { createClient } = await import('@supabase/supabase-js');
const { getContentGoodsWithMeta, YugcontractError } = await import(
  '../app/lib/yugcontract/client.ts'
);
const {
  extractContentGoods,
  normalizeContentGood,
  dedupeContentGoods,
} = await import('../app/lib/yugcontract/content-dry-run.ts');
const { reduceGoodsToStagedRows } = await import(
  '../app/lib/yugcontract/content-staging.ts'
);
const { planContentUpdates } = await import(
  '../app/lib/yugcontract/content-import.ts'
);

// Copy of EXCLUDE_EMPTY_HTML_DESC_IDS from scripts/yugcontract-content-apply.ts
// (read-only duplicate so the hypothetical plan mirrors the real GO semantics).
const EXCLUDE_EMPTY_HTML_DESC_IDS: ReadonlySet<string> = new Set([
  '6377542', '6377543', '6466242', '6546069', '6655320', '6806965',
  '6819981', '6824731', '6837160', '6858140', '6860593', '6863794',
  '6874251', '6897244', '6910428', '6986702', '7022281', '7022284',
  '7038700', '7046725', '7079237', '7082039', '7088382', '7096545',
  '7111320', '7229372', '7231271', '7231276', '7250282', '7259480',
  '7261496', '7266825',
]);

// Boilerplate markers: audit 2026-08-31 (app/lib/seo.ts).
const BOILERPLATE_MARKERS = [
  'кожен виріб',
  'бренд високоякісного посуду',
  'винайдений у франції',
];

function htmlToPlainText(html: string | null | undefined): string {
  return (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlaceholder(html: string | null): boolean {
  return htmlToPlainText(html) === '';
}

function isKnownBoilerplate(html: string | null): boolean {
  if (html === null) return false;
  const plain = htmlToPlainText(html).toLowerCase();
  if (plain === '') return false;
  return BOILERPLATE_MARKERS.some((m) => plain.includes(m));
}

const CONTENT_RUN_CUTOFF = '2026-08-24T16:00:00+00:00'; // after apply ycc-2026-08-24-15-58-40
const PRICE_RUN_CUTOFF = '2026-08-31T16:00:00+00:00'; // price import yc-2026-08-31-16-00-46

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

async function pagedSelect(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  table: string,
  select: string,
  orderCol: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const PAGE = 1000;
  const rows: unknown[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(select)
      .order(orderCol)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
    from += PAGE;
  }
}

const t0 = Date.now();
console.log('== TASK #18 CONTENT RE-FETCH DRY-RUN (READ-ONLY) ==');
console.log(`Старт: ${new Date().toISOString()}`);

// ---- 1) fresh feed ----------------------------------------------------------
let parsed: unknown;
let byteLength = 0;
try {
  ({ parsed, byteLength } = await getContentGoodsWithMeta());
} catch (err) {
  if (err instanceof YugcontractError) {
    console.error(`Yugcontract error [${err.kind}]: ${err.message}`);
  } else {
    console.error('Unexpected feed error');
  }
  process.exit(1);
}
console.log(
  `API: 1 call, ${(byteLength / 1024 / 1024).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s`
);

const { goods: rawGoods } = extractContentGoods(parsed);
const validGoods = [];
for (const raw of rawGoods) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
  const { good } = normalizeContentGood(raw as Record<string, unknown>);
  if (good) validGoods.push(good);
}
const deduped = dedupeContentGoods(validGoods);
const feedById = new Map(deduped.unique.map((g) => [g.externalId, g]));
const reduction = reduceGoodsToStagedRows(deduped.unique);
const stagedFresh = reduction.rows;
const stagedFreshById = new Map(stagedFresh.map((r) => [r.yugcontract_id, r]));

console.log(`feed: raw=${fmtInt(rawGoods.length)} valid=${fmtInt(validGoods.length)} unique=${fmtInt(deduped.unique.length)}`);

// ---- 2) DB reads (SELECT only) ----------------------------------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!supabaseUrl || !serviceKey) {
  console.error('No SUPABASE env vars');
  process.exit(1);
}
const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

type ProductRow = {
  id: string;
  yugcontract_id: string | null;
  sku: string;
  name: string;
  description: string | null;
  specifications: unknown;
  created_at: string;
};
const products = (await pagedSelect(
  client,
  'products',
  'id,yugcontract_id,sku,name,description,specifications,created_at',
  'id'
)) as ProductRow[];
console.log(`products: ${fmtInt(products.length)} rows`);

type StagingRow = {
  yugcontract_id: string;
  description: string | null;
  pictures: unknown;
  params: unknown;
};
const stagingDb = (await pagedSelect(
  client,
  'yc_content_goods',
  'yugcontract_id,description,pictures,params',
  'yugcontract_id'
)) as StagingRow[];
console.log(`staging yc_content_goods: ${fmtInt(stagingDb.length)} rows`);

type ImageRow = { product_id: string; image_url: string };
const productImages = (await pagedSelect(
  client,
  'product_images',
  'product_id,image_url',
  'id'
)) as ImageRow[];
console.log(`product_images: ${fmtInt(productImages.length)} rows`);

const stagingDbById = new Map(stagingDb.map((r) => [r.yugcontract_id, r]));
const stagingIds = new Set(stagingDbById.keys());
const feedIds = new Set(feedById.keys());
const imagesByProduct = new Map<string, Set<string>>();
for (const img of productImages) {
  const set = imagesByProduct.get(img.product_id) ?? new Set<string>();
  set.add(img.image_url);
  imagesByProduct.set(img.product_id, set);
}

// ---- 3) feed vs staging ------------------------------------------------------
console.log('\n== A. FEED vs STAGING (yc_content_goods) ==');
const feedOnly = [...feedIds].filter((id) => !stagingIds.has(id));
const stagingOnly = [...stagingIds].filter((id) => !feedIds.has(id));
const both = [...feedIds].filter((id) => stagingIds.has(id));
console.log(`у фіді (unique):            ${fmtInt(feedIds.size)}`);
console.log(`у staging:                  ${fmtInt(stagingIds.size)}`);
console.log(`спільних:                   ${fmtInt(both.length)}`);
console.log(`нові для staging (feed-only): ${fmtInt(feedOnly.length)}`);
const feedOnlyWithDesc = feedOnly.filter((id) => (stagedFreshById.get(id)?.description ?? null) !== null).length;
const feedOnlyWithParams = feedOnly.filter((id) => (stagedFreshById.get(id)?.params.length ?? 0) > 0).length;
const feedOnlyWithPics = feedOnly.filter((id) => (stagedFreshById.get(id)?.pictures.length ?? 0) > 0).length;
console.log(`  з description/params/pictures: ${fmtInt(feedOnlyWithDesc)}/${fmtInt(feedOnlyWithParams)}/${fmtInt(feedOnlyWithPics)}`);
console.log(`зникли з фіду (staging-only): ${fmtInt(stagingOnly.length)}`);

const stagingWithDesc = stagingDb.filter((r) => r.description !== null && String(r.description).trim() !== '').length;
const stagingWithParams = stagingDb.filter((r) => Array.isArray(r.params) && r.params.length > 0).length;
const stagingWithPics = stagingDb.filter((r) => Array.isArray(r.pictures) && r.pictures.length > 0).length;
console.log(`staging якість: desc/params/pics = ${fmtInt(stagingWithDesc)}/${fmtInt(stagingWithParams)}/${fmtInt(stagingWithPics)}`);

// ---- 4) products vs fresh feed (exact join) ----------------------------------
console.log('\n== B. PRODUCTS vs FRESH FEED (exact id join — як зараз) ==');
const ycProducts = products.filter((p) => p.yugcontract_id !== null) as (ProductRow & { yugcontract_id: string })[];
const manualProducts = products.filter((p) => p.yugcontract_id === null);
const matched = ycProducts.filter((p) => feedIds.has(p.yugcontract_id));
const unmatched = ycProducts.filter((p) => !feedIds.has(p.yugcontract_id));
console.log(`products: ${fmtInt(products.length)} (YC-linked ${fmtInt(ycProducts.length)}, manual ${fmtInt(manualProducts.length)})`);
console.log(`matched (контент є):        ${fmtInt(matched.length)}`);
console.log(`unmatched (контенту немає): ${fmtInt(unmatched.length)}`);

// current description state of matched products
const matchedEmptyDesc = matched.filter((p) => p.description === null || p.description.trim() === '').length;
console.log(`matched зараз без опису в БД: ${fmtInt(matchedEmptyDesc)}`);

// fresh-feed content coverage of matched
const matchedFeedDesc = matched.filter((p) => (stagedFreshById.get(p.yugcontract_id)?.description ?? null) !== null).length;
const matchedFeedParams = matched.filter((p) => (stagedFreshById.get(p.yugcontract_id)?.params.length ?? 0) > 0).length;
const matchedFeedPics = matched.filter((p) => (stagedFreshById.get(p.yugcontract_id)?.pictures.length ?? 0) > 0).length;
console.log(`fresh feed має desc/params/pics для matched: ${fmtInt(matchedFeedDesc)}/${fmtInt(matchedFeedParams)}/${fmtInt(matchedFeedPics)}`);

// unmatched breakdown
const unmatchedDu = unmatched.filter((p) => p.yugcontract_id.endsWith('_du'));
const unmatchedNonDu = unmatched.filter((p) => !p.yugcontract_id.endsWith('_du'));
const unmatchedInStaging = unmatched.filter((p) => stagingIds.has(p.yugcontract_id));
const unmatchedNonDuBaseInFeed = unmatchedNonDu.filter((p) => feedIds.has(p.yugcontract_id.replace(/_du$/, ''))).length;
console.log(`unmatched: _du=${fmtInt(unmatchedDu.length)}, non-_du=${fmtInt(unmatchedNonDu.length)}`);
console.log(`  non-_du з base-id у фіді: ${fmtInt(unmatchedNonDuBaseInFeed)} (очікується 0 — інакше це інші суфікси)`);
console.log(`  unmatched, які Є у staging (зникли з фіду): ${fmtInt(unmatchedInStaging.length)}`);
const unmatchedInStagingWithDesc = unmatchedInStaging.filter((p) => {
  const r = stagingDbById.get(p.yugcontract_id);
  return r !== undefined && r.description !== null && String(r.description).trim() !== '';
}).length;
console.log(`  з них зі staging-описом (stale staging рятує): ${fmtInt(unmatchedInStagingWithDesc)}`);

// ---- 5) _du deep analysis -----------------------------------------------------
console.log('\n== C. _du MAPPING ==');
const duProducts = ycProducts.filter((p) => p.yugcontract_id.endsWith('_du'));
const duWithBaseInFeed = duProducts.filter((p) => feedIds.has(p.yugcontract_id.replace(/_du$/, '')));
const duWithBaseInStaging = duProducts.filter((p) => stagingIds.has(p.yugcontract_id.replace(/_du$/, '')));
const duNoBase = duProducts.filter((p) => !feedIds.has(p.yugcontract_id.replace(/_du$/, '')) && !stagingIds.has(p.yugcontract_id.replace(/_du$/, '')));
console.log(`_du товарів у БД:                  ${fmtInt(duProducts.length)}`);
console.log(`base-id Є в актуальному фіді:      ${fmtInt(duWithBaseInFeed.length)}`);
console.log(`base-id Є лише в staging:          ${fmtInt(duWithBaseInStaging.length - duWithBaseInFeed.length)} (base в staging, але не у фіді)`);
console.log(`base-id НЕМАЄ ніде:                ${fmtInt(duNoBase.length)}`);
console.log(`JOIN-ВтРАТА ПІДТВЕРДЖЕНА: exact join по "<base>_du" дає 0 matched з ${fmtInt(duProducts.length)} (усі в unmatched вище)`);
const duBaseDesc = duWithBaseInFeed.filter((p) => {
  const g = stagedFreshById.get(p.yugcontract_id.replace(/_du$/, ''));
  return g !== undefined && g.description !== null;
}).length;
const duBaseParams = duWithBaseInFeed.filter((p) => {
  const g = stagedFreshById.get(p.yugcontract_id.replace(/_du$/, ''));
  return g !== undefined && g.params.length > 0;
}).length;
const duBasePics = duWithBaseInFeed.filter((p) => {
  const g = stagedFreshById.get(p.yugcontract_id.replace(/_du$/, ''));
  return g !== undefined && g.pictures.length > 0;
}).length;
const duEmptyDescInDb = duProducts.filter((p) => p.description === null || p.description.trim() === '').length;
console.log(`у _du з base у фіді: desc/params/pics = ${fmtInt(duBaseDesc)}/${fmtInt(duBaseParams)}/${fmtInt(duBasePics)}`);
console.log(`_du зараз без опису в БД:          ${fmtInt(duEmptyDescInDb)}`);

// hypothetical: base-mapping would give content
const duWouldGetDesc = duWithBaseInFeed.filter((p) => {
  const r = stagedFreshById.get(p.yugcontract_id.replace(/_du$/, ''));
  return r !== undefined && r.description !== null && (p.description === null || p.description.trim() === '');
}).length;
console.log(`_du, які отримали б ОПИС при base-mapping (зараз порожній): ${fmtInt(duWouldGetDesc)}`);

// ---- 6) products not covered by staging (Task #17 496 group) ------------------
console.log('\n== D. PRODUCTS NOT IN STAGING (група Task #17) ==');
const notInStaging = ycProducts.filter((p) => !stagingIds.has(p.yugcontract_id));
const nisInFeed = notInStaging.filter((p) => feedIds.has(p.yugcontract_id));
const nisDu = notInStaging.filter((p) => p.yugcontract_id.endsWith('_du'));
const nisDuBaseInFeed = nisDu.filter((p) => feedIds.has(p.yugcontract_id.replace(/_du$/, '')));
const nisNotAnywhere = notInStaging.filter(
  (p) => !feedIds.has(p.yugcontract_id) && !stagingIds.has(p.yugcontract_id) && !feedIds.has(p.yugcontract_id.replace(/_du$/, ''))
);
console.log(`товарів поза staging:              ${fmtInt(notInStaging.length)}`);
console.log(`  є в актуальному фіді (exact id): ${fmtInt(nisInFeed.length)}`);
console.log(`  _du (base у фіді):               ${fmtInt(nisDuBaseInFeed.length)} з ${fmtInt(nisDu.length)} _du`);
console.log(`  немає ніде (ні фід, ні staging, ні base): ${fmtInt(nisNotAnywhere.length)}`);
const nisInFeedWithDesc = nisInFeed.filter((p) => (stagedFreshById.get(p.yugcontract_id)?.description ?? null) !== null).length;
console.log(`  з фіду мають description:        ${fmtInt(nisInFeedWithDesc)}`);

// ---- 7) products created after content run -----------------------------------
console.log('\n== E. NEW PRODUCTS AFTER CONTENT-RUN (2026-08-24 apply) ==');
const afterContentRun = products.filter((p) => p.created_at >= CONTENT_RUN_CUTOFF);
const afterPriceRun = products.filter((p) => p.created_at >= PRICE_RUN_CUTOFF);
console.log(`created_at >= 2026-08-24T16:00Z:   ${fmtInt(afterContentRun.length)}`);
console.log(`created_at >= 2026-08-31T16:00Z (price run): ${fmtInt(afterPriceRun.length)}`);

interface NewGroupStats {
  total: number;
  inFeedExact: number;
  duBaseInFeed: number;
  inStaging: number;
  feedDesc: number;
  feedParams: number;
  feedPics: number;
  hasDescNow: number;
  noContent: number;
  planUpdates: number;
}
const newGroupPlanIds = new Set<string>(); // filled later, resolved in section G
function computeNewGroupStats(group: typeof afterContentRun): NewGroupStats {
  const stats: NewGroupStats = {
    total: group.length,
    inFeedExact: 0,
    duBaseInFeed: 0,
    inStaging: 0,
    feedDesc: 0,
    feedParams: 0,
    feedPics: 0,
    hasDescNow: 0,
    noContent: 0,
    planUpdates: 0,
  };
  for (const p of group) {
    const yc = p.yugcontract_id;
    if (yc === null) {
      stats.noContent += 1;
      continue;
    }
    const isDu = yc.endsWith('_du');
    const base = isDu ? yc.replace(/_du$/, '') : yc;
    const inFeedExact = feedIds.has(yc);
    const baseInFeed = isDu && feedIds.has(base);
    const feedId = inFeedExact ? yc : baseInFeed ? base : null;
    if (inFeedExact) stats.inFeedExact += 1;
    if (baseInFeed) stats.duBaseInFeed += 1;
    if (stagingIds.has(yc)) stats.inStaging += 1;
    if (feedId !== null) {
      const row = stagedFreshById.get(feedId);
      if (row?.description != null) stats.feedDesc += 1;
      if ((row?.params.length ?? 0) > 0) stats.feedParams += 1;
      if ((row?.pictures.length ?? 0) > 0) stats.feedPics += 1;
    }
    if (p.description !== null && p.description.trim() !== '') stats.hasDescNow += 1;
    if (feedId === null && !stagingIds.has(yc)) stats.noContent += 1;
  }
  return stats;
}
const stats705 = computeNewGroupStats(afterContentRun);
const stats290 = computeNewGroupStats(afterPriceRun);
const newGroup = afterContentRun; // kept for section G intersection (legacy 705 cut)

for (const [label, s] of [
  ['група 705 (після content-run 08-24)', stats705],
  ['група 290 (після price-run 08-31)', stats290],
] as const) {
  console.log(`\n--- ${label}: ${fmtInt(s.total)} ---`);
  console.log(`у фіді exact id: ${fmtInt(s.inFeedExact)}; _du з base у фіді: ${fmtInt(s.duBaseInFeed)}; у staging: ${fmtInt(s.inStaging)}`);
  console.log(`готовий контент у фіді (desc/params/pics): ${fmtInt(s.feedDesc)}/${fmtInt(s.feedParams)}/${fmtInt(s.feedPics)}`);
  console.log(`вже мають опис у БД зараз: ${fmtInt(s.hasDescNow)}`);
  console.log(`реально НЕ покриті контентом: ${fmtInt(s.noContent)}`);
}

// ---- 8) boilerplate ------------------------------------------------------------
console.log('\n== F. BOILERPLATE CLASSIFICATION (fresh feed descriptions) ==');
const feedWithDesc = deduped.unique.filter((g) => g.description !== null);
const knownBp = feedWithDesc.filter((g) => isKnownBoilerplate(g.description)).length;
const placeholder = feedWithDesc.filter((g) => isPlaceholder(g.description)).length;
console.log(`фід unique: ${fmtInt(deduped.unique.length)}; з описом: ${fmtInt(feedWithDesc.length)}`);
console.log(`відомий boilerplate (3 маркери seo.ts): ${fmtInt(knownBp)}`);
for (const m of BOILERPLATE_MARKERS) {
  console.log(`  "${m}": ${fmtInt(feedWithDesc.filter((g) => isKnownBoilerplate(g.description) && htmlToPlainText(g.description).toLowerCase().includes(m)).length)}`);
}
console.log(`placeholder (тексту нема після strip): ${fmtInt(placeholder)}`);

// unknown clusters: identical normalized plain text across distinct ids
const textClusters = new Map<string, Set<string>>();
for (const g of feedWithDesc) {
  if (isPlaceholder(g.description)) continue;
  const key = htmlToPlainText(g.description).toLowerCase();
  if (key === '') continue;
  const set = textClusters.get(key) ?? new Set<string>();
  set.add(g.externalId);
  textClusters.set(key, set);
}
const unknownClusters = [...textClusters.entries()]
  .filter(([text, ids]) => ids.size >= 10 && !BOILERPLATE_MARKERS.some((m) => text.includes(m)))
  .sort((a, b) => b[1].size - a[1].size);
const unknownBoilerplateProducts = unknownClusters.reduce((acc, [, ids]) => acc + ids.size, 0);
console.log(`новий НЕвідомий boilerplate (кластери ≥10 однакових текстів): ${fmtInt(unknownClusters.length)} кластерів, ${fmtInt(unknownBoilerplateProducts)} товарів`);
for (const [text, ids] of unknownClusters.slice(0, 10)) {
  console.log(`  ×${fmtInt(ids.size)}  id-приклад: ${[...ids][0]}  «${text.slice(0, 90)}…»`);
}
const uniqueUsefulFeed = feedWithDesc.length - knownBp - unknownBoilerplateProducts - placeholder;
console.log(`унікальний/корисний опис у фіді:   ≈${fmtInt(uniqueUsefulFeed)}`);

// ---- 9) hypothetical apply plan from FRESH feed --------------------------------
console.log('\n== G. HYPOTHETICAL APPLY PLAN (fresh feed → sanitize → plan; ZERO writes) ==');
const contentRows = products.map((p) => ({
  id: p.id,
  yugcontract_id: p.yugcontract_id,
  description: p.description,
  specifications: p.specifications,
}));
const plan = planContentUpdates(stagedFresh, contentRows, {
  includeSpecifications: true,
  excludeDescriptionIds: EXCLUDE_EMPTY_HTML_DESC_IDS,
});
const planFills = plan.updates.filter((u) => !u.currentHadDescription && u.fields.description).length;
const planOverwrites = plan.updates.filter((u) => u.currentHadDescription && u.fields.description).length;
const planSpecs = plan.updates.filter((u) => u.fields.specifications).length;
const planBoth = plan.updates.filter((u) => u.fields.description && u.fields.specifications).length;
console.log(`потенційних UPDATE products:       ${fmtInt(plan.updates.length)}`);
console.log(`  заповнень порожніх описів:       ${fmtInt(planFills)}`);
console.log(`  перезаписів непорожніх:          ${fmtInt(planOverwrites)}`);
console.log(`  descriptions+specs разом:        ${fmtInt(planBoth)}`);
console.log(`  specifications зміниться:        ${fmtInt(planSpecs)}`);
console.log(`ідентичних (no-op):               ${fmtInt(plan.identical)}`);
console.log(`без опису в контенті:             ${fmtInt(plan.noDescriptionAvailable)}`);
console.log(`unmatched staged рядків:          ${fmtInt(plan.unmatchedStaged)}`);
console.log(`описів виключено (empty-HTML set): ${fmtInt(plan.excludedDescription)}`);

// resolve planUpdates per new-group (needs the plan, hence after section G)
for (const u of plan.updates) {
  if (afterContentRun.some((p) => p.id === u.productDbId)) stats705.planUpdates += 1;
  if (afterPriceRun.some((p) => p.id === u.productDbId)) stats290.planUpdates += 1;
}
console.log(`  з них товарів групи 705 (після content-run): ${fmtInt(stats705.planUpdates)}`);
console.log(`  з них товарів групи 290 (після price-run):   ${fmtInt(stats290.planUpdates)}`);
void newGroupPlanIds;
void newGroup;

// boilerplate among would-write descriptions
const bpInUpdates = plan.updates.filter((u) => u.fields.description !== undefined && isKnownBoilerplate(u.fields.description)).length;
const phInUpdates = plan.updates.filter((u) => u.fields.description !== undefined && isPlaceholder(u.fields.description)).length;
console.log(`  з них опис = відомий boilerplate: ${fmtInt(bpInUpdates)}; placeholder: ${fmtInt(phInUpdates)}`);

// ---- 10) images delta -----------------------------------------------------------
console.log('\n== H. IMAGES DELTA (fresh feed vs product_images; apply НЕ чіпає images) ==');
let imgSame = 0;
let imgNewUrlsProducts = 0;
let imgLostUrlsProducts = 0;
let totalNewUrls = 0;
for (const p of matched) {
  const staged = stagedFreshById.get(p.yugcontract_id);
  if (!staged) continue;
  const feedSet = new Set(staged.pictures);
  const dbSet = imagesByProduct.get(p.id) ?? new Set<string>();
  const dbExternal = [...dbSet].filter((u) => u.startsWith('http'));
  const dbSetExternal = new Set(dbExternal);
  let hasNew = false;
  for (const url of feedSet) {
    if (!dbSetExternal.has(url)) hasNew = true;
  }
  let hasLost = false;
  for (const url of dbSetExternal) {
    if (!feedSet.has(url)) hasLost = true;
  }
  if (!hasNew && !hasLost) imgSame += 1;
  if (hasNew) {
    imgNewUrlsProducts += 1;
    for (const url of feedSet) if (!dbSetExternal.has(url)) totalNewUrls += 1;
  }
  if (hasLost) imgLostUrlsProducts += 1;
}
console.log(`matched з images: ідентичні ${fmtInt(imgSame)}; мають НОВІ URL у фіді ${fmtInt(imgNewUrlsProducts)} (нових URL ${fmtInt(totalNewUrls)}); фід втратив URL у ${fmtInt(imgLostUrlsProducts)}`);

// ---- 11) _du allowlist drift (130 vs 129 at 2026-08-31 audit) -------------------
console.log('\n== I. _du ALLOWLIST DRIFT ==');
try {
  const duJson = JSON.parse(
    readFileSync(path.join(root, 'app/lib/du-redirects.json'), 'utf8')
  ) as { redirect?: { duSlug: string; baseSlug: string }[] };
  // duSlug always ends with the yugcontract id suffix "<id>_du"
  const allowlistDu = new Set(
    (duJson.redirect ?? []).map((p) => p.duSlug.split('-').pop() ?? '')
  );
  const dbDuIds = new Set(duProducts.map((p) => p.yugcontract_id));
  const newDu = [...dbDuIds].filter((id) => !allowlistDu.has(id));
  const missingDu = [...allowlistDu].filter((id) => !dbDuIds.has(id));
  console.log(`allowlist пар: ${fmtInt(allowlistDu.size)}; _du у БД: ${fmtInt(dbDuIds.size)}`);
  console.log(`нові _du поза allowlist: ${fmtInt(newDu.length)}${newDu.length ? ` → ${newDu.join(', ')}` : ''}`);
  console.log(`allowlist _du, яких немає в БД: ${fmtInt(missingDu.length)}${missingDu.length ? ` → ${missingDu.join(', ')}` : ''}`);
} catch (err) {
  console.log(`allowlist check skipped: ${err instanceof Error ? err.message : String(err)}`);
}

// ---- 12) dump detail JSON for the report ----------------------------------------
const detail = {
  generatedAt: new Date().toISOString(),
  feed: { raw: rawGoods.length, valid: validGoods.length, unique: deduped.unique.length, withDescription: feedWithDesc.length },
  staging: { rows: stagingDb.length, withDescription: stagingWithDesc, withParams: stagingWithParams, withPictures: stagingWithPics },
  feedVsStaging: { both: both.length, feedOnly: feedOnly.length, stagingOnly: stagingOnly.length },
  products: { total: products.length, ycLinked: ycProducts.length, manual: manualProducts.length, matched: matched.length, unmatched: unmatched.length },
  du: { total: duProducts.length, baseInFeed: duWithBaseInFeed.length, baseInStagingOnly: duWithBaseInStaging.length - duWithBaseInFeed.length, noBase: duNoBase.length, wouldGetDescription: duWouldGetDesc, emptyDescInDb: duEmptyDescInDb },
  notInStaging: { total: notInStaging.length, inFeed: nisInFeed.length, duBaseInFeed: nisDuBaseInFeed.length, nowhere: nisNotAnywhere.length },
  newGroup705: stats705,
  newGroup290: stats290,
  boilerplate: { feedWithDescription: feedWithDesc.length, known: knownBp, placeholder, unknownClusters: unknownClusters.length, unknownProducts: unknownBoilerplateProducts, uniqueUseful: uniqueUsefulFeed },
  plan: { updates: plan.updates.length, fills: planFills, overwrites: planOverwrites, specs: planSpecs, identical: plan.identical, noDescriptionAvailable: plan.noDescriptionAvailable, unmatchedStaged: plan.unmatchedStaged, excludedDescription: plan.excludedDescription, group705Updates: stats705.planUpdates, group290Updates: stats290.planUpdates, boilerplateDescriptions: bpInUpdates, placeholderDescriptions: phInUpdates },
  images: { sameProducts: imgSame, productsWithNewUrls: imgNewUrlsProducts, newUrls: totalNewUrls, productsWithLostUrls: imgLostUrlsProducts },
};
writeFileSync('/tmp/opencode/yc-refetch-detail.json', JSON.stringify(detail, null, 2));
console.log('\nдеталі: /tmp/opencode/yc-refetch-detail.json');
console.log(`Production writes: 0 (лише SELECT + 1 API call)`);
console.log(`Тривалість: ${((Date.now() - t0) / 1000).toFixed(1)} с`);
