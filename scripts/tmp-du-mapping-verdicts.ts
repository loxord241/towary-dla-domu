/**
 * READ-ONLY Task #19 verdict recompute (DB only, NO feed call).
 *
 * Fixes the tmp-du-mapping-audit.ts bugs (params are {name,value} objects,
 * not strings) and evaluates the proposed mapping gates against STAGING —
 * the only data source content-apply reads:
 *   1. content available: staged desc non-empty OR params > 0
 *   2. brand: du.brand === base-product.brand (DB); orphans → feedBrand
 *      from the saved audit JSON
 *   3. model-token: ≥1 shared model token between du.name and staged.name
 *   4. images: if du has external images AND staged has pictures → equal sets
 *   5. category: if base product exists → same category_id
 * ZERO writes.
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

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

/** Model tokens: alphanumeric chunks ≥3 chars containing a digit or a
 *  slash-pattern (e.g. QP6542/15, SIH3200WR, 30x40, SVC 45/52 → SVC45/52). */
function modelTokens(name: string | null | undefined): Set<string> {
  const out = new Set<string>();
  const cleaned = (name ?? '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}/\-.]/gu, ' ')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1/$2')
    .replace(/(\d)\s*[XХ]\s*(\d)/gi, '$1x$2');
  for (const raw of cleaned.split(/\s+/)) {
    const t = raw.replace(/^[-.]+|[-.]+$/g, '');
    if (t.length < 3) continue;
    if (/\d/.test(t) || /^[A-Z]{2,}\d/.test(t)) out.add(t);
  }
  return out;
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

interface AuditRow {
  duYc: string;
  baseYc: string;
  feedBrand: string | null;
}
const auditRows = JSON.parse(
  readFileSync('/tmp/opencode/du-mapping-audit.json', 'utf8')
) as AuditRow[];
const feedBrandByBase = new Map(auditRows.map((r) => [r.baseYc, r.feedBrand]));

const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);

type ProductRow = {
  id: string;
  yugcontract_id: string | null;
  name: string;
  brand_id: string | null;
  category_id: string | null;
  description: string | null;
  specifications: unknown;
};
const products = (await pagedSelect(
  client,
  'products',
  'id,yugcontract_id,name,brand_id,category_id,description,specifications',
  'id'
)) as ProductRow[];
type StagingRow = {
  yugcontract_id: string;
  name: string | null;
  description: string | null;
  pictures: unknown;
  params: unknown;
};
const stagingBase = (await pagedSelect(
  client,
  'yc_content_goods',
  'yugcontract_id,name,description,pictures,params',
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
const stagingById = new Map(stagingBase.map((r) => [r.yugcontract_id, r]));
const imagesByProduct = new Map<string, Set<string>>();
for (const img of productImages) {
  const set = imagesByProduct.get(img.product_id) ?? new Set<string>();
  set.add(img.image_url);
  imagesByProduct.set(img.product_id, set);
}
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
type ParamPair = { name: string; value: string };
const asParamPairs = (v: unknown): ParamPair[] =>
  Array.isArray(v)
    ? v.flatMap((e) =>
        typeof e === 'object' && e !== null && typeof (e as ParamPair).name === 'string' && typeof (e as ParamPair).value === 'string'
          ? [{ name: (e as ParamPair).name, value: (e as ParamPair).value }]
          : []
      )
    : [];

const duProducts = products.filter((p) => p.yugcontract_id?.endsWith('_du')) as (ProductRow & { yugcontract_id: string })[];

interface Verdict {
  duYc: string;
  baseYc: string;
  contentAvailable: boolean;
  stagedDesc: boolean;
  stagedParams: number;
  brandOk: boolean | null;
  brandSource: string;
  modelTokenOk: boolean | null;
  sharedTokens: string[];
  imagesOk: boolean | null;
  ourImages: number;
  stagedPics: number;
  categoryOk: boolean | null;
  baseProductExists: boolean;
  duDescEmpty: boolean;
  specsDiffer: boolean | null;
  verdict: string;
}

const verdicts: Verdict[] = [];
for (const du of duProducts) {
  const baseYc = du.yugcontract_id.replace(/_du$/, '');
  const staged = stagingById.get(baseYc);
  const baseProduct = productByYc.get(baseYc);
  const feedBrand = feedBrandByBase.get(baseYc) ?? null;
  const stagedPics = staged ? asStringArray(staged.pictures) : [];
  const stagedParams = staged ? asParamPairs(staged.params) : [];
  const ourImages = [...(imagesByProduct.get(du.id) ?? [])].filter((u) => u.startsWith('http'));

  // 1. content available
  const stagedDescOk = staged?.description != null && staged.description.trim() !== '';
  const contentAvailable = staged !== undefined && (stagedDescOk || stagedParams.length > 0);

  // 2. brand (du vs base product; orphans → feed brand from audit JSON)
  //    brand names are joined in DB terms: both products share brand_id.
  const brandOk = baseProduct !== undefined ? du.brand_id === baseProduct.brand_id : null;
  const brandSource =
    baseProduct !== undefined ? 'db-base-product' : feedBrand !== null ? `feed:${feedBrand}` : 'unknown';

  // 3. model tokens
  const duTokens = modelTokens(du.name);
  const stagedTokens = modelTokens(staged?.name ?? null);
  const shared = [...duTokens].filter((t) => stagedTokens.has(t));
  const modelTokenOk = staged !== undefined ? shared.length > 0 : null;

  // 4. images
  const imagesOk =
    ourImages.length > 0 && stagedPics.length > 0
      ? ourImages.length === stagedPics.length && stagedPics.every((u) => ourImages.includes(u))
      : null;

  // 5. category (only measurable when base product exists)
  const categoryOk = baseProduct !== undefined ? du.category_id === baseProduct.category_id : null;

  const duDescEmpty = du.description === null || du.description.trim() === '';
  const specsDiffer =
    staged !== undefined
      ? JSON.stringify(du.specifications ?? null) !== JSON.stringify(stagedParams)
      : null;

  let verdict: string;
  if (staged === undefined) verdict = 'NO-STAGED-BASE';
  else if (!contentAvailable) verdict = 'NO-CONTENT (staged desc+params порожні)';
  else if (brandOk === false) verdict = 'MISMATCH-BRAND';
  else if (categoryOk === false) verdict = 'MISMATCH-CATEGORY';
  else if (modelTokenOk === false) verdict = 'MISMATCH-MODEL';
  else if (imagesOk === false) verdict = 'MISMATCH-IMAGES';
  else verdict = 'SAFE';

  verdicts.push({
    duYc: du.yugcontract_id,
    baseYc,
    contentAvailable,
    stagedDesc: stagedDescOk,
    stagedParams: stagedParams.length,
    brandOk,
    brandSource,
    modelTokenOk,
    sharedTokens: shared.slice(0, 4),
    imagesOk,
    ourImages: ourImages.length,
    stagedPics: stagedPics.length,
    categoryOk,
    baseProductExists: baseProduct !== undefined,
    duDescEmpty,
    specsDiffer,
    verdict,
  });
}

const count = (pred: (v: Verdict) => boolean): number => verdicts.filter(pred).length;
console.log(`_du: ${fmtInt(verdicts.length)}`);
console.log(`SAFE:                          ${fmtInt(count((v) => v.verdict === 'SAFE'))}`);
console.log(`  з staged description:        ${fmtInt(count((v) => v.verdict === 'SAFE' && v.stagedDesc))}`);
console.log(`  з params:                    ${fmtInt(count((v) => v.verdict === 'SAFE' && v.stagedParams > 0))}`);
console.log(`  desc заповнень (порожній зараз): ${fmtInt(count((v) => v.verdict === 'SAFE' && v.stagedDesc && v.duDescEmpty))}`);
console.log(`  specifications зміниться:    ${fmtInt(count((v) => v.verdict === 'SAFE' && v.specsDiffer === true))}`);
console.log(`  images повний збіг:          ${fmtInt(count((v) => v.verdict === 'SAFE' && v.imagesOk === true))}`);
console.log(`  images відсутні (du без зовнішніх img): ${fmtInt(count((v) => v.verdict === 'SAFE' && v.imagesOk === null))}`);
console.log(`  без base product (сироти):   ${fmtInt(count((v) => v.verdict === 'SAFE' && !v.baseProductExists))}`);
for (const other of ['NO-STAGED-BASE', 'NO-CONTENT', 'MISMATCH-BRAND', 'MISMATCH-CATEGORY', 'MISMATCH-MODEL', 'MISMATCH-IMAGES']) {
  const rows = verdicts.filter((v) => v.verdict === other);
  if (rows.length === 0) continue;
  console.log(`\n${other}: ${fmtInt(rows.length)}`);
  for (const v of rows) {
    console.log(
      `  ${v.duYc} staged=${v.stagedDesc}/${v.stagedParams}p brand=${String(v.brandOk)}/${v.brandSource} model=${String(v.modelTokenOk)}[${v.sharedTokens.join(',')}] img=${String(v.imagesOk)}(${v.ourImages}/${v.stagedPics}) cat=${String(v.categoryOk)}`
    );
  }
}

// model-token gate coverage: how many of ALL staged-known du names share tokens
console.log(`\nmodel-token покриття по всіх 130: ok=${fmtInt(count((v) => v.modelTokenOk === true))}, fail=${fmtInt(count((v) => v.modelTokenOk === false))}, n/a=${fmtInt(count((v) => v.modelTokenOk === null))}`);

writeFileSync('/tmp/opencode/du-mapping-verdicts.json', JSON.stringify(verdicts, null, 2));
console.log(`\nдеталі: /tmp/opencode/du-mapping-verdicts.json`);
console.log('Production writes: 0 (лише SELECT).');
