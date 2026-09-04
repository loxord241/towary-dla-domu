/**
 * READ-ONLY Task #19 audit: `_du` content mapping identity verification.
 *
 * For ALL `_du` products: base id, base product existence, content under
 * base id (staging + fresh feed), and identity correspondence
 * (name / brand / images / category) between our `_du` product and the
 * base content row. ZERO writes. ONE get-content-goods call.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
const { getContentGoodsWithMeta, YugcontractError } = await import(
  '../app/lib/yugcontract/client.ts'
);
const { extractContentGoods, normalizeContentGood, dedupeContentGoods } = await import(
  '../app/lib/yugcontract/content-dry-run.ts'
);

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

function norm(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/["'`«»ʼ]/g, '')
    .replace(/[-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
console.log('== TASK #19 _du MAPPING AUDIT (READ-ONLY) ==');
console.log(`Старт: ${new Date().toISOString()}`);

// ---- 1) fresh feed ----------------------------------------------------------
let parsed: unknown;
try {
  ({ parsed } = await getContentGoodsWithMeta());
} catch (err) {
  console.error(err instanceof YugcontractError ? err.message : 'feed error');
  process.exit(1);
}
const { goods: rawGoods } = extractContentGoods(parsed);
const validGoods = [];
for (const raw of rawGoods) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
  const { good } = normalizeContentGood(raw as Record<string, unknown>);
  if (good) validGoods.push(good);
}
const deduped = dedupeContentGoods(validGoods);
const feedById = new Map(deduped.unique.map((g) => [g.externalId, g]));
console.log(`feed unique: ${fmtInt(deduped.unique.length)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// ---- 2) DB reads ------------------------------------------------------------
const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);

type ProductRow = {
  id: string;
  yugcontract_id: string | null;
  sku: string;
  name: string;
  brand_id: string | null;
  category_id: string | null;
  description: string | null;
  specifications: unknown;
  slug: string;
};
const products = (await pagedSelect(
  client,
  'products',
  'id,yugcontract_id,sku,name,brand_id,category_id,description,specifications,slug',
  'id'
)) as ProductRow[];
const brands = (await pagedSelect(client, 'brands', 'id,name', 'id')) as { id: string; name: string }[];
type StagingRow = {
  yugcontract_id: string;
  category_id: string | null;
  name: string | null;
  description: string | null;
  pictures: unknown;
  params: unknown;
};
const stagingDb = (await pagedSelect(
  client,
  'yc_content_goods',
  'yugcontract_id,category_id,name,description,pictures,params',
  'yugcontract_id'
)) as StagingRow[];
type ImageRow = { product_id: string; image_url: string };
const productImages = (await pagedSelect(
  client,
  'product_images',
  'product_id,image_url',
  'id'
)) as ImageRow[];

const productByYc = new Map(products.map((p) => [p.yugcontract_id ?? '', p]));
const stagingById = new Map(stagingDb.map((r) => [r.yugcontract_id, r]));
const brandName = new Map(brands.map((b) => [b.id, b.name]));
const imagesByProduct = new Map<string, Set<string>>();
for (const img of productImages) {
  const set = imagesByProduct.get(img.product_id) ?? new Set<string>();
  set.add(img.image_url);
  imagesByProduct.set(img.product_id, set);
}
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

// ---- 3) per-_du verification --------------------------------------------------
const duProducts = products.filter((p) => p.yugcontract_id?.endsWith('_du')) as (ProductRow & { yugcontract_id: string })[];
console.log(`_du товаров: ${fmtInt(duProducts.length)}`);

interface DuRow {
  duYc: string;
  baseYc: string;
  duSlug: string;
  baseProductExists: boolean;
  stagedBase: boolean;
  feedBase: boolean;
  stagedName: string | null;
  feedName: string | null;
  feedBrand: string | null;
  ourName: string;
  ourBrand: string | null;
  nameMatchStaged: boolean | null;
  nameMatchFeed: boolean | null;
  brandMatch: boolean | null;
  baseStagedDesc: boolean;
  baseFeedDesc: boolean;
  baseDescLen: number | null;
  paramsCount: number;
  picsStaged: number;
  picsFeed: number;
  ourImages: number;
  imagesMatchStaged: boolean | null;
  imagesMatchFeed: boolean | null;
  sameCategoryAsBaseProduct: boolean | null;
  baseProductYcName: string | null;
  duEmptyDesc: boolean;
  specsWouldChange: boolean | null;
  verdict: string;
}

const rows: DuRow[] = [];
for (const du of duProducts) {
  const baseYc = du.yugcontract_id.replace(/_du$/, '');
  const baseProduct = productByYc.get(baseYc);
  const staged = stagingById.get(baseYc);
  const feed = feedById.get(baseYc);
  const ourImages = [...(imagesByProduct.get(du.id) ?? [])].filter((u) => u.startsWith('http'));
  const stagedPics = staged ? asStringArray(staged.pictures) : [];
  const feedPics = feed?.pictures ?? [];
  const stagedName = staged?.name ?? null;
  const feedName = feed?.name ?? null;
  const feedBrand = feed?.brand ?? null;
  const ourBrand = du.brand_id ? brandName.get(du.brand_id) ?? null : null;
  const duEmptyDesc = du.description === null || du.description.trim() === '';
  const stagedDesc = staged?.description ?? null;
  const params = staged ? asStringArray(staged.params) : (feed?.params ?? []).map((p) => p);

  const setEq = (a: string[], b: string[]): boolean => {
    if (a.length === 0 || b.length === 0) return false;
    const sa = new Set(a);
    if (sa.size !== b.length) return false;
    return b.every((u) => sa.has(u));
  };
  // category equality only measurable product↔product (our taxonomy)
  const sameCategory = baseProduct ? du.category_id === baseProduct.category_id : null;

  const nameMatchStaged = stagedName !== null ? norm(du.name) === norm(stagedName) : null;
  const nameMatchFeed = feedName !== null ? norm(du.name) === norm(feedName) : null;
  const brandMatch = feedBrand !== null ? norm(ourBrand) === norm(feedBrand) : null;
  const imagesMatchStaged = stagedPics.length > 0 ? setEq(ourImages, stagedPics) : null;
  const imagesMatchFeed = feedPics.length > 0 ? setEq(ourImages, feedPics) : null;

  // specs delta: would the base params change our _du specifications?
  const specsWouldChange =
    staged || feed
      ? JSON.stringify(du.specifications ?? null) !==
        JSON.stringify(((staged ? asStringArray(staged.params) : (feed?.params ?? []).map((x) => x)) as unknown))
      : null;

  let verdict: string;
  const hasContent = (stagedDesc !== null && stagedDesc.trim() !== '') || params.length > 0;
  const identityOk =
    (nameMatchStaged === true || nameMatchFeed === true) &&
    (brandMatch === null || brandMatch === true);
  const imagesOk =
    (imagesMatchStaged === null || imagesMatchStaged === true) &&
    (imagesMatchFeed === null || imagesMatchFeed === true);
  if (!staged && !feed) verdict = 'NO-CONTENT (base id відсутній і в staging, і у фіді)';
  else if (!identityOk) verdict = 'MISMATCH-IDENTITY (ім’я/бренд не збігаються)';
  else if (!imagesOk) verdict = 'MISMATCH-IMAGES (набір картинок не збігається)';
  else if (baseProduct !== undefined && sameCategory === false)
    verdict = 'MISMATCH-CATEGORY (base product в іншій категорії)';
  else if (!hasContent) verdict = 'NO-DESC (identity ок, але контент порожній)';
  else verdict = 'SAFE';

  rows.push({
    duYc: du.yugcontract_id,
    baseYc,
    duSlug: du.slug,
    baseProductExists: baseProduct !== undefined,
    stagedBase: staged !== undefined,
    feedBase: feed !== undefined,
    stagedName,
    feedName,
    feedBrand,
    ourName: du.name,
    ourBrand,
    nameMatchStaged,
    nameMatchFeed,
    brandMatch,
    baseStagedDesc: stagedDesc !== null && stagedDesc.trim() !== '',
    baseFeedDesc: (feed?.description ?? null) !== null,
    baseDescLen: stagedDesc !== null ? stagedDesc.length : (feed?.description?.length ?? null),
    paramsCount: Array.isArray(params) ? params.length : 0,
    picsStaged: stagedPics.length,
    picsFeed: feedPics.length,
    ourImages: ourImages.length,
    imagesMatchStaged,
    imagesMatchFeed,
    sameCategoryAsBaseProduct: sameCategory,
    baseProductYcName: baseProduct?.name ?? null,
    duEmptyDesc,
    specsWouldChange,
    verdict,
  });
}

const byVerdict = new Map<string, DuRow[]>();
for (const r of rows) {
  const key = r.verdict.split(' ')[0] ?? r.verdict;
  const arr = byVerdict.get(key) ?? [];
  arr.push(r);
  byVerdict.set(key, arr);
}
console.log('\n== VERDICTS ==');
for (const [k, arr] of [...byVerdict.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${k}: ${fmtInt(arr.length)}`);
}

// summary numbers
const safe = rows.filter((r) => r.verdict.startsWith('SAFE'));
console.log(`\nbase product exists в БД:     ${fmtInt(rows.filter((r) => r.baseProductExists).length)}`);
console.log(`base в staging:               ${fmtInt(rows.filter((r) => r.stagedBase).length)}`);
console.log(`base у фіді:                  ${fmtInt(rows.filter((r) => r.feedBase).length)}`);
console.log(`SAFE з staged description:    ${fmtInt(safe.filter((r) => r.baseStagedDesc).length)}`);
console.log(`SAFE з params:                ${fmtInt(safe.filter((r) => r.paramsCount > 0).length)}`);
console.log(`SAFE з pictures:              ${fmtInt(safe.filter((r) => r.picsStaged > 0 || r.picsFeed > 0).length)}`);
console.log(`SAFE, у яких опис порожній зараз: ${fmtInt(safe.filter((r) => r.duEmptyDesc).length)}`);
console.log(`SAFE зі змінами specifications: ${fmtInt(safe.filter((r) => r.specsWouldChange === true).length)}`);

const mismatchRows = rows.filter((r) => r.verdict.startsWith('MISMATCH') || r.verdict.startsWith('NO-CONTENT'));
console.log(`\n== НЕ-SAFE рядки (усі ${mismatchRows.length}) ==`);
for (const r of mismatchRows) {
  console.log(
    `[${r.verdict.split(' ')[0]}] ${r.duYc} base=${r.baseYc} staged=${r.stagedBase} feed=${r.feedBase} nameS=${r.nameMatchStaged} nameF=${r.nameMatchFeed} brand=${r.brandMatch} imgS=${r.imagesMatchStaged} imgF=${r.imagesMatchFeed} ourImg=${r.ourImages} stagedPics=${r.picsStaged} feedPics=${r.picsFeed} cat=${r.sameCategoryAsBaseProduct}`
  );
}

// name-mismatch detail for manual review
const nameBad = rows.filter((r) => r.nameMatchStaged === false || r.nameMatchFeed === false);
if (nameBad.length > 0) {
  console.log(`\n== NAME НЕЗБІГИ (детально) ==`);
  for (const r of nameBad.slice(0, 20)) {
    console.log(`  ${r.duYc}: our="${r.ourName}" staged="${r.stagedName}" feed="${r.feedName}"`);
  }
}

// non-du with _du-looking staged rows sanity
const stagedDuRows = stagingDb.filter((r) => r.yugcontract_id.endsWith('_du'));
console.log(`\nsanity: staging рядків із суфіксом _du: ${fmtInt(stagedDuRows.length)} (очікується 0)`);

writeFileSync('/tmp/opencode/du-mapping-audit.json', JSON.stringify(rows, null, 2));
console.log(`\nдеталі: /tmp/opencode/du-mapping-audit.json (${rows.length} рядків)`);
console.log(`Production writes: 0. Тривалість: ${((Date.now() - t0) / 1000).toFixed(0)} с`);
