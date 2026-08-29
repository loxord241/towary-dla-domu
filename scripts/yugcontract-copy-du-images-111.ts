/**
 * ONE-OFF (P2-2): copy native Yugcontract images to 111 `_du` products.
 *
 * Business context (audit 2026-08-29): the supplier keeps these goods as
 * `_du` ids in the price feed but ONLY as base ids in the content feed, so
 * the regular images pipeline (joined by exact yugcontract_id) can never
 * match them. This script copies the BASE id's validated pictures[] from
 * the yc_content_goods staging into product_images for the `_du` product —
 * WITHOUT touching products.yugcontract_id (price/stock sync must keep
 * working against the `_du` price-feed positions).
 *
 * Scope is a HARD allowlist of exactly 111 (du → base) pairs, fixed by the
 * read-only production audit of 2026-08-29 and mirrored in
 * scripts/yugcontract-copy-du-images-111-allowlist.csv. No wildcards, no
 * mass discovery, no mass UPDATE.
 *
 * Safety model:
 *  - default mode is --plan (read-only, zero writes);
 *  - --run re-verifies EVERY guard immediately before the first INSERT,
 *    prints a final READY TO INSERT confirmation and aborts on any
 *    deviation from the plan (counts, ids, URL hosts, activity);
 *  - inserts use ON CONFLICT DO NOTHING against the existing
 *    UNIQUE (product_id, image_url) index → idempotent re-runs;
 *  - NO updates, NO deletes, NO products writes, NO sync/import triggered;
 *    a target that already has images is an unexpected state → hard STOP;
 *  - is_main=true is assigned only to staging pictures[0] and only when
 *    the target has zero images (partial unique main-per-product index);
 *  - --run writes a baseline snapshot (products invariants + image counts)
 *    next to this script; --postcheck replays it read-only.
 *
 * Modes:
 *   node scripts/yugcontract-copy-du-images-111.ts --plan      read-only report (default)
 *   node scripts/yugcontract-copy-du-images-111.ts --run       guarded writes
 *   node scripts/yugcontract-copy-du-images-111.ts --postcheck read-only verify
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/** HARD allowlist: exactly the 111 audited pairs (audit 2026-08-29).
 *  Key = product yugcontract_id ("<base>_du"),
 *  value = base content-feed id + expected product_id (UUID). */
const DU_TO_BASE: Record<string, { base: string; productId: string }> = {
  '5924679_du': { base: '5924679', productId: 'b07fb4c6-fedb-4039-8f16-08cb3ce681be' },
  '5967725_du': { base: '5967725', productId: '5697bf58-ca11-4da9-98ea-4cb970b50d02' },
  '6241811_du': { base: '6241811', productId: '445cd827-a53c-45cd-b475-e9c7a77474fc' },
  '6284421_du': { base: '6284421', productId: '3dc52a09-f623-4a84-b15c-d1ae70af7798' },
  '6313699_du': { base: '6313699', productId: '9341bbac-d422-4403-b6d3-d53c9f158f0d' },
  '6349848_du': { base: '6349848', productId: 'e7618289-6f0c-4f83-be4d-fc9916e59c93' },
  '6376339_du': { base: '6376339', productId: 'f5b93a8f-9d10-4ed9-a49a-835aa2a7e64d' },
  '6398700_du': { base: '6398700', productId: '316976a8-beaf-4bcf-a1a2-4371888adfad' },
  '6446612_du': { base: '6446612', productId: '51fc603a-c08e-4eb5-8104-8b7c721dc050' },
  '6474753_du': { base: '6474753', productId: '2c798ae3-af9d-4a89-bac6-c72b26f8a5e6' },
  '6482008_du': { base: '6482008', productId: '4973dc0e-ed30-4c1b-a0ce-822667570c91' },
  '6489771_du': { base: '6489771', productId: '6af8b3ca-e281-4819-b064-5abc99a1997b' },
  '6496818_du': { base: '6496818', productId: '710691d0-47c7-46c1-b92e-5b3d7ed21be8' },
  '6521818_du': { base: '6521818', productId: '33193a17-1d29-49a7-ac90-86c12806a833' },
  '6527338_du': { base: '6527338', productId: 'fca44d64-c968-48e0-b6e0-53082eca8f82' },
  '6615810_du': { base: '6615810', productId: '73acd81b-4e5c-4582-9d55-a5c8b6f0f944' },
  '6629656_du': { base: '6629656', productId: 'b152af46-66a9-4fb6-9465-26e7b4f7b9f7' },
  '6651531_du': { base: '6651531', productId: 'c332218a-9be4-4b60-bcfe-48064d28f3b3' },
  '6655515_du': { base: '6655515', productId: '895aa41d-aa06-4e62-abb7-2443597df691' },
  '6661880_du': { base: '6661880', productId: 'a22d5de1-c362-44b0-ab80-94a54d1ad63a' },
  '6666894_du': { base: '6666894', productId: '293c09b5-1477-45b2-a89f-e4b54d9b14f5' },
  '6669622_du': { base: '6669622', productId: '723b874a-c8a5-4231-b3a9-613b68c073a5' },
  '6703011_du': { base: '6703011', productId: 'faf7c2de-5091-4627-befa-3fafe9aa1797' },
  '6711226_du': { base: '6711226', productId: '4ea8ac07-0561-4a26-b967-ea1b8cd12486' },
  '6720857_du': { base: '6720857', productId: 'aa587b48-b6c4-4275-b235-7f7268c833fb' },
  '6745446_du': { base: '6745446', productId: '51f2c0cb-f9c1-4bc7-accf-daf6a8a0e81b' },
  '6764593_du': { base: '6764593', productId: '92fd25d9-09bf-4248-a4b1-ac6cc690624d' },
  '6790006_du': { base: '6790006', productId: '3de99cda-3105-4bb9-93cb-ec63314430f1' },
  '6811303_du': { base: '6811303', productId: '411c485a-0d20-467e-93ab-700849aa8293' },
  '6821456_du': { base: '6821456', productId: '4111003f-3371-45ec-aabd-8db396b61b9a' },
  '6840744_du': { base: '6840744', productId: 'adbe765e-1ecf-42c6-aea1-f5d152fbd3d5' },
  '6849632_du': { base: '6849632', productId: '87134368-eac0-4c9e-9259-ccc7edaabab3' },
  '6871226_du': { base: '6871226', productId: '4e6f66a0-737e-4ee5-b767-eb482fcf5d4c' },
  '6873343_du': { base: '6873343', productId: 'fb12f9ad-35d8-428e-b310-102c183d08fa' },
  '6875715_du': { base: '6875715', productId: 'c7f3af04-cd81-4a90-91c9-ca6a5241c22f' },
  '6884549_du': { base: '6884549', productId: '52db0ea6-b163-4f23-9152-238ce21a3634' },
  '6885495_du': { base: '6885495', productId: '1ceaad92-d18e-4873-a6d4-242ec94ae06d' },
  '6906759_du': { base: '6906759', productId: '9fff1255-4c23-46d1-88a9-ffd4b232aac9' },
  '6924604_du': { base: '6924604', productId: '1add3584-d01a-4689-9dfc-f8091a1ca663' },
  '6932802_du': { base: '6932802', productId: '1175e7af-8c86-41e9-b7c6-1c82f49aaf82' },
  '6932803_du': { base: '6932803', productId: 'a5450cac-1dd4-4314-a11b-1a9d5868e807' },
  '6965981_du': { base: '6965981', productId: 'aea3da79-d245-4cc1-b888-7730358213e7' },
  '6966588_du': { base: '6966588', productId: '6fada6a2-3184-4503-a2fe-21f32526e109' },
  '6976884_du': { base: '6976884', productId: '33b81cd3-f13e-48f1-a630-e8a014380363' },
  '6984892_du': { base: '6984892', productId: '99f03704-3e57-4bbd-a834-4182b5577b89' },
  '6985231_du': { base: '6985231', productId: 'c118865f-11fb-49e8-8827-3f025a67a705' },
  '6988689_du': { base: '6988689', productId: 'b5d5b0c4-2788-4ff9-8175-dcedf3bcb83b' },
  '6988988_du': { base: '6988988', productId: '4d06f989-ac5e-4657-8b10-80e560558d4c' },
  '6990162_du': { base: '6990162', productId: '7a4dc61f-2499-47a7-928b-92749d5879c7' },
  '6992422_du': { base: '6992422', productId: '5da79f8b-bd7e-4f82-a2f7-19d2facc1db9' },
  '6993614_du': { base: '6993614', productId: '8935e3a5-e87d-4e0b-818b-899831c63767' },
  '6993837_du': { base: '6993837', productId: '2a4b54b1-1232-47ba-bf42-f7b80f5c6480' },
  '6996159_du': { base: '6996159', productId: 'a9a9909d-9399-42e5-b630-ff03f2368688' },
  '7007001_du': { base: '7007001', productId: '9e2b069f-88c9-4139-8576-051d1b0fc1b0' },
  '7019427_du': { base: '7019427', productId: '0c640846-8345-4747-b070-a93ce2d55768' },
  '7022284_du': { base: '7022284', productId: '03dca09f-6549-4304-b6bd-70fd77880042' },
  '7023706_du': { base: '7023706', productId: 'de8ee004-213d-472b-8b5f-27e37c1cbbab' },
  '7024506_du': { base: '7024506', productId: 'b76da1ed-3d71-48b7-b656-9f3a1173315d' },
  '7024832_du': { base: '7024832', productId: 'e067be73-c35d-45ba-bc39-8abd4ac05a57' },
  '7025027_du': { base: '7025027', productId: 'b2ef8b6f-4071-4815-af21-4d09ec4db196' },
  '7030819_du': { base: '7030819', productId: '20c993bf-b2f4-4fa4-bf0c-6fc695ec5de0' },
  '7051690_du': { base: '7051690', productId: '3b405860-c1f4-40ad-9de2-5bc8feecc33a' },
  '7053687_du': { base: '7053687', productId: '9af31558-8c61-4932-b0f2-6ebf008ee6dd' },
  '7056171_du': { base: '7056171', productId: 'c4a2be49-c7b9-4ded-8631-64f5340cca9f' },
  '7064284_du': { base: '7064284', productId: '442ad976-f31e-4038-b084-e2f5d4680f21' },
  '7067155_du': { base: '7067155', productId: '507d966e-5600-46ca-8c50-2388b2e591c6' },
  '7083113_du': { base: '7083113', productId: '5cc88a39-5a2e-4f72-b9ef-16aba5e2bc95' },
  '7086538_du': { base: '7086538', productId: '21d9a01d-de0d-42b8-9bc9-00f3757bcab9' },
  '7088394_du': { base: '7088394', productId: '06a7dbf1-9705-4a89-a934-594250c90bdc' },
  '7095348_du': { base: '7095348', productId: 'bd33b1d3-5872-48b8-a70a-bf52d238df4a' },
  '7109372_du': { base: '7109372', productId: '17e4045e-a66d-403f-9fb7-c461fd09874b' },
  '7120201_du': { base: '7120201', productId: '8ee22be4-fe57-4913-8ece-ca386c14a7f3' },
  '7138500_du': { base: '7138500', productId: '05d38056-6260-4e96-bd47-2e045452d73a' },
  '7153553_du': { base: '7153553', productId: 'eb3f31c5-83e0-4cc6-b125-b2fc65a18884' },
  '7163805_du': { base: '7163805', productId: 'b932ba3f-afe0-4793-aad9-db5283bbd239' },
  '7169040_du': { base: '7169040', productId: 'ebeeb021-d664-4631-9e7f-ea31192a72d6' },
  '7169071_du': { base: '7169071', productId: '71d5c218-596a-46e5-8d9c-8a571c9e02bc' },
  '7185654_du': { base: '7185654', productId: 'b73293a9-29cb-48ee-8dbb-5553fb70a043' },
  '7193446_du': { base: '7193446', productId: 'f1da589d-12ac-42f3-a545-9a3cda2646fc' },
  '7198084_du': { base: '7198084', productId: '443fed34-ed76-4d5c-989f-4f7c62719d49' },
  '7198085_du': { base: '7198085', productId: 'fcb11d67-01f9-4f5b-97da-d5957da8146b' },
  '7200561_du': { base: '7200561', productId: '037d0a7f-2e0e-412a-96cb-cffa94702872' },
  '7204300_du': { base: '7204300', productId: '134a9643-4e2c-4a1a-bc62-6002f79932f4' },
  '7205163_du': { base: '7205163', productId: '0c186880-415f-4ca7-beb7-6a5107e78794' },
  '7220881_du': { base: '7220881', productId: '633ff3c0-cd27-4d62-b3e8-6f51a6a6012a' },
  '7220882_du': { base: '7220882', productId: '0ed60444-b270-4dec-937f-e58ce6adcfe1' },
  '7220896_du': { base: '7220896', productId: '65cfd144-0d78-47ee-bf6d-3080c563d808' },
  '7220910_du': { base: '7220910', productId: '872cc282-cbc7-41db-992a-3deface1798f' },
  '7220911_du': { base: '7220911', productId: '7a93df03-7dd3-421d-915b-e40c2d3c4d2f' },
  '7221668_du': { base: '7221668', productId: '4cd84b8e-8de3-42ec-b994-f89e04d945d7' },
  '7224534_du': { base: '7224534', productId: '44cb4ca2-ed0b-4297-adb5-3044c0d60446' },
  '7229839_du': { base: '7229839', productId: '5aec43c5-3fff-40da-b087-c01a0c501380' },
  '7232191_du': { base: '7232191', productId: 'b4f20942-4be2-49ee-87f5-c7c326f38a6f' },
  '7232192_du': { base: '7232192', productId: 'd5eb2363-ca59-4469-a1a1-4bfffe3deeb2' },
  '7240037_du': { base: '7240037', productId: 'feedc968-40ed-4a67-a0bd-94b5c839adc5' },
  '7243919_du': { base: '7243919', productId: 'b2bbfa69-1fa3-4cc1-af4b-3cdfa818a8a4' },
  '7246355_du': { base: '7246355', productId: '6e03d53c-5c3c-40fd-817f-85e839b37317' },
  '7248612_du': { base: '7248612', productId: 'cb9ea3f0-4ef3-44db-8ed0-4d865c795284' },
  '7259030_du': { base: '7259030', productId: '2129c736-07b4-4871-99d3-70a19a11f89a' },
  '7262655_du': { base: '7262655', productId: '9c3e5544-c995-4b8c-8c3d-688322387de1' },
  '7264937_du': { base: '7264937', productId: '7dc9ab4d-2320-427a-a1fc-36f526578161' },
  '7269799_du': { base: '7269799', productId: '381508eb-67ef-4d56-8e56-37572af817ec' },
  '7270046_du': { base: '7270046', productId: 'a1c94e52-4e31-4d56-825a-5da587174a2a' },
  '7270074_du': { base: '7270074', productId: '4467832d-4937-489b-b06f-5b0765889366' },
  '7278766_du': { base: '7278766', productId: '4acada94-8933-4015-ab87-e83c654dc2fb' },
  '7282004_du': { base: '7282004', productId: '89dd08a2-0d05-47f9-a8ed-f6de93df5b6f' },
  '7283135_du': { base: '7283135', productId: '2dca1863-00f7-4280-aae8-bc428c6cac32' },
  '7290718_du': { base: '7290718', productId: 'ee3b607d-f6b8-43a1-ab5e-7d6bcd168f91' },
  '7290720_du': { base: '7290720', productId: '0bee88a8-4d0a-4e7f-a105-a2d3a101295c' },
  '7291169_du': { base: '7291169', productId: 'a7ec11dd-5615-4dce-89d8-15749be65840' },
  '7297145_du': { base: '7297145', productId: 'c3dd8e61-8f1e-4a29-b0cf-81516700e42c' },
};
const DU_IDS = Object.keys(DU_TO_BASE);
const EXPECTED_TARGETS = 111;
if (DU_IDS.length !== EXPECTED_TARGETS) {
  fail(`allowlist містить ${DU_IDS.length} пар замість ${EXPECTED_TARGETS}`);
}

const ALLOWED_HOST = 'b2b.yugcontract.ua';
const BASELINE_PATH = path.join(root, 'scripts', '.yugcontract-du-111-baseline.json');

const mode = process.argv.includes('--run')
  ? 'run'
  : process.argv.includes('--postcheck')
    ? 'postcheck'
    : 'plan';

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

function fail(msg: string): never {
  console.error(`STOP: ${msg}`);
  process.exit(1);
}

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  fail('Немає SUPABASE env-змінних');
}
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

interface ProductRow {
  id: string;
  yugcontract_id: string;
  is_active: boolean | null;
  sku: string | null;
  slug: string | null;
  price: number | null;
  stock_quantity: number | null;
}

interface StagedEntry {
  urls: string[];
  rejected: number;
  duplicates: number;
}

/** PostgREST caps a single response (db-max-rows, default 1000) — every
 *  potentially-large SELECT is paginated with .range(). */
const PAGE_SIZE = 1000;

/** Full pass over products: the ONLY discovery allowed — to prove that no
 *  unexpected active zero-image `_du` product exists outside the allowlist. */
async function scanProducts(): Promise<ProductRow[]> {
  const out: ProductRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from('products')
      .select('id,yugcontract_id,is_active,sku,slug,price,stock_quantity')
      .like('yugcontract_id', '%\\_du')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) fail(`products SELECT: ${error.message}`);
    const rows = (data ?? []) as ProductRow[];
    out.push(...rows.filter((p) => p.yugcontract_id.endsWith('_du')));
    if (rows.length < PAGE_SIZE) return out;
  }
}

async function loadImagesFor(productIds: string[]) {
  const out: { id: string; product_id: string; image_url: string; is_main: boolean | null }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from('product_images')
      .select('id,product_id,image_url,is_main')
      .in('product_id', productIds)
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) fail(`product_images SELECT: ${error.message}`);
    const rows = data ?? [];
    out.push(...(rows as typeof out));
    if (rows.length < PAGE_SIZE) return out;
  }
}

async function loadStaged(bases: string[]): Promise<Map<string, StagedEntry>> {
  const { data, error } = await client
    .from('yc_content_goods')
    .select('yugcontract_id,pictures')
    .in('yugcontract_id', bases);
  if (error) fail(`staging SELECT: ${error.message}`);
  const byId = new Map<string, StagedEntry>();
  for (const row of data ?? []) {
    const key = String(row.yugcontract_id);
    const prev = byId.get(key);
    const { urls, rejected } = revalidateStagedPictures(row.pictures);
    if (prev) {
      prev.duplicates += 1;
      prev.urls.push(...urls);
      prev.rejected += rejected;
    } else {
      byId.set(key, { urls, rejected, duplicates: 0 });
    }
  }
  return byId;
}

interface PerTarget {
  du: string;
  base: string;
  product_id: string;
  pics: number;
  rejected: number;
  existing: number;
  inserts: number;
  mainUrl: string | null;
  hostOk: boolean;
}

interface Plan {
  perTarget: PerTarget[];
  inserts: { product_id: string; image_url: string; alt: null; sort_order: number; is_main: boolean }[];
  existingTotal: number;
  invalidUrlTotal: number;
  noStaging: string[];
  emptyPics: string[];
  withExisting: string[];
  productMismatch: string[];
  badHost: string[];
  conflicts: string[];
}

function buildPlan(targets: ProductRow[], staged: Map<string, StagedEntry>, existing: { product_id: string }[]): Plan {
  const existingByProduct = new Map<string, number>();
  for (const e of existing) existingByProduct.set(e.product_id, (existingByProduct.get(e.product_id) ?? 0) + 1);

  const perTarget: PerTarget[] = [];
  const inserts: Plan['inserts'] = [];
  const noStaging: string[] = [];
  const emptyPics: string[] = [];
  const withExisting: string[] = [];
  const productMismatch: string[] = [];
  const badHost: string[] = [];
  const conflicts: string[] = [];
  let invalidUrlTotal = 0;

  for (const t of targets) {
    const entry = DU_TO_BASE[t.yugcontract_id];
    if (!entry) {
      conflicts.push(`${t.yugcontract_id}: відсутній в allowlist`);
      continue;
    }
    if (t.id !== entry.productId) {
      productMismatch.push(`${t.yugcontract_id}: product_id ${t.id} <> allowlist ${entry.productId}`);
      conflicts.push(`${t.yugcontract_id}: product_id не збігається з allowlist`);
    }
    const s = staged.get(entry.base);
    if (!s) {
      noStaging.push(t.yugcontract_id);
      continue;
    }
    if (s.duplicates > 0) {
      conflicts.push(`base ${entry.base}: ${s.duplicates} дублікатів рядків у yc_content_goods`);
    }
    if (s.urls.length === 0) {
      emptyPics.push(t.yugcontract_id);
    }
    invalidUrlTotal += s.rejected;
    const existingCount = existingByProduct.get(t.id) ?? 0;
    if (existingCount > 0) withExisting.push(`${t.yugcontract_id}: ${existingCount}`);
    let n = 0;
    let mainUrl: string | null = null;
    s.urls.forEach((url, idx) => {
      let hostOk = true;
      try {
        hostOk = new URL(url).host === ALLOWED_HOST;
      } catch {
        hostOk = false;
      }
      if (!hostOk) badHost.push(`${t.yugcontract_id}: ${url}`);
      if (existingCount === 0 && hostOk) {
        inserts.push({ product_id: t.id, image_url: url, alt: null, sort_order: idx, is_main: idx === 0 });
        if (idx === 0) mainUrl = url;
        n++;
      }
    });
    perTarget.push({
      du: t.yugcontract_id,
      base: entry.base,
      product_id: t.id,
      pics: s.urls.length,
      rejected: s.rejected,
      existing: existingCount,
      inserts: n,
      mainUrl,
      hostOk: badHost.length === 0,
    });
  }
  return {
    perTarget,
    inserts,
    existingTotal: existing.length,
    invalidUrlTotal,
    noStaging,
    emptyPics,
    withExisting,
    productMismatch,
    badHost,
    conflicts,
  };
}

/** Unexpected targets: active zero-image `_du` products NOT in the allowlist. */
function findUnexpected(all: ProductRow[], imageCounts: Map<string, number>): string[] {
  return all
    .filter((p) => p.is_active === true && p.yugcontract_id.endsWith('_du') && (imageCounts.get(p.id) ?? 0) === 0)
    .map((p) => p.yugcontract_id)
    .filter((du) => !DU_IDS.includes(du));
}

interface Baseline {
  at: string;
  plannedInserts: number;
  totalImagesBefore: number;
  targetImagesBefore: Record<string, number>;
  products: Record<string, Pick<ProductRow, 'yugcontract_id' | 'sku' | 'slug' | 'price' | 'stock_quantity' | 'is_active'>>;
}

async function totalImageCount(): Promise<number> {
  const { count, error } = await client.from('product_images').select('id', { count: 'exact', head: true });
  if (error) fail(`product_images COUNT: ${error.message}`);
  return count ?? 0;
}

// ---------------------------------------------------------------- PLAN ----
if (mode === 'plan') {
  const all = await scanProducts();
  const duRows = all.filter((p) => p.yugcontract_id.endsWith('_du'));
  const staged = await loadStaged([...new Set(Object.values(DU_TO_BASE).map((v) => v.base))]);
  const duImgRows = await loadImagesFor(duRows.map((p) => p.id));
  const imageCounts = new Map<string, number>();
  for (const r of duImgRows) imageCounts.set(r.product_id, (imageCounts.get(r.product_id) ?? 0) + 1);
  const targets = duRows.filter((p) => p.is_active === true && (imageCounts.get(p.id) ?? 0) === 0);
  const existing = await loadImagesFor(targets.map((t) => t.id));
  const plan = buildPlan(targets, staged, existing);
  const unexpected = findUnexpected(all, imageCounts);
  const mains = plan.inserts.filter((i) => i.is_main).length;
  const hosts = new Map<string, number>();
  for (const i of plan.inserts) hosts.set(new URL(i.image_url).host, (hosts.get(new URL(i.image_url).host) ?? 0) + 1);

  console.log('== YC COPY DU IMAGES 111 (plan, READ-ONLY) ==');
  console.log(`targets:              ${fmtInt(plan.perTarget.length)} (очікувано ${EXPECTED_TARGETS})`);
  for (const t of plan.perTarget) {
    console.log(`  ${t.du} → ${t.base}  product=${t.product_id} pics=${t.pics} inserts=${t.inserts} main=${t.mainUrl ? 'yes' : 'NO'}`);
  }
  console.log(`INSERT:               ${fmtInt(plan.inserts.length)}`);
  console.log(`main:                 ${fmtInt(mains)}`);
  console.log(`existing images:      ${fmtInt(plan.existingTotal)}`);
  console.log(`invalid URL:          ${fmtInt(plan.invalidUrlTotal)}`);
  console.log(`bad host entries:     ${fmtInt(plan.badHost.length)}`);
  console.log(`no staging pictures:  ${fmtInt(plan.noStaging.length)}${plan.noStaging.length ? ' → ' + plan.noStaging.join(', ') : ''}`);
  console.log(`empty pictures[]:     ${fmtInt(plan.emptyPics.length)}${plan.emptyPics.length ? ' → ' + plan.emptyPics.join(', ') : ''}`);
  console.log(`unexpected existing:  ${fmtInt(plan.withExisting.length)}${plan.withExisting.length ? ' → ' + plan.withExisting.join(', ') : ''}`);
  console.log(`product_id mismatch:  ${fmtInt(plan.productMismatch.length)}${plan.productMismatch.length ? ' → ' + plan.productMismatch.join('; ') : ''}`);
  console.log(`unexpected targets:   ${fmtInt(unexpected.length)}${unexpected.length ? ' → ' + unexpected.join(', ') : ''}`);
  console.log(`conflicts:            ${fmtInt(plan.conflicts.length)}${plan.conflicts.length ? ' → ' + plan.conflicts.join('; ') : ''}`);
  console.log(`hosts:                ${[...hosts.entries()].map(([h, c]) => `${h}=${c}`).join(', ') || '—'}`);
  console.log('UPDATE:               0');
  console.log('DELETE:               0');
  console.log('products UPDATE:      0');
  console.log('\n--plan: жодних записів. Для виконання: --run (окремий GO).');
  process.exit(0);
}

// ------------------------------------------------------------ POSTCHECK ----
if (mode === 'postcheck') {
  if (!existsSync(BASELINE_PATH)) {
    fail(`baseline ${BASELINE_PATH} відсутній — --postcheck виконується тільки після --run`);
  }
  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const targets = (await scanProducts()).filter((p) => DU_IDS.includes(p.yugcontract_id));
  if (targets.length !== EXPECTED_TARGETS) fail(`targets ${targets.length} <> ${EXPECTED_TARGETS}`);
  const imgs = await loadImagesFor(targets.map((t) => t.id));
  const byProduct = new Map<string, { total: number; mains: number }>();
  for (const i of imgs) {
    const e = byProduct.get(i.product_id) ?? { total: 0, mains: 0 };
    e.total++;
    if (i.is_main === true) e.mains++;
    byProduct.set(i.product_id, e);
  }
  const missing = targets.filter((t) => (byProduct.get(t.id)?.total ?? 0) === 0);
  const noMain = targets.filter((t) => (byProduct.get(t.id)?.mains ?? 0) === 0);
  const multiMain = targets.filter((t) => (byProduct.get(t.id)?.mains ?? 0) > 1);
  const targetImagesBefore = Object.values(baseline.targetImagesBefore).reduce((a, b) => a + b, 0);
  const totalAfter = await totalImageCount();
  const hostSet = new Set(imgs.map((i) => new URL(i.image_url).host));
  const changedProducts: string[] = [];
  for (const t of targets) {
    const b = baseline.products[t.id];
    if (!b) fail(`у baseline немає product ${t.id}`);
    const same =
      b.yugcontract_id === t.yugcontract_id &&
      b.sku === t.sku &&
      b.slug === t.slug &&
      b.price === t.price &&
      b.stock_quantity === t.stock_quantity &&
      b.is_active === t.is_active;
    if (!same) changedProducts.push(t.yugcontract_id);
  }
  console.log(JSON.stringify({
    targets: targets.length,
    targets_with_images: targets.length - missing.length,
    missing,
    planned_inserts: baseline.plannedInserts,
    target_images_before: targetImagesBefore,
    target_images_after: imgs.length,
    inserts_delta: imgs.length - targetImagesBefore,
    insert_delta_matches_plan: imgs.length - targetImagesBefore === baseline.plannedInserts,
    total_images_before: baseline.totalImagesBefore,
    total_images_after: totalAfter,
    total_delta_matches_plan: totalAfter - baseline.totalImagesBefore === baseline.plannedInserts,
    no_main: noMain.map((t) => t.yugcontract_id),
    multi_main: multiMain.map((t) => t.yugcontract_id),
    products_changed: changedProducts,
    du_ids_unchanged: targets.every((t) => t.yugcontract_id.endsWith('_du') && t.yugcontract_id === baseline.products[t.id]?.yugcontract_id),
    image_hosts: [...hostSet],
    hosts_ok: [...hostSet].every((h) => h === ALLOWED_HOST),
    delete_updated: 0,
  }, null, 2));
  process.exit(0);
}

// ------------------------------------------------------------- RUN ----
console.log('== YC COPY DU IMAGES 111 (RUN) ==');
const all = await scanProducts();
const duRows = all.filter((p) => p.yugcontract_id.endsWith('_du'));
const staged = await loadStaged([...new Set(Object.values(DU_TO_BASE).map((v) => v.base))]);
const duImgRows = await loadImagesFor(duRows.map((p) => p.id));
const imageCounts = new Map<string, number>();
for (const r of duImgRows) imageCounts.set(r.product_id, (imageCounts.get(r.product_id) ?? 0) + 1);
const targets = duRows.filter((p) => p.is_active === true && (imageCounts.get(p.id) ?? 0) === 0);
const existing = await loadImagesFor(targets.map((t) => t.id));
const plan = buildPlan(targets, staged, existing);
const unexpected = findUnexpected(all, imageCounts);
const mains = plan.inserts.filter((i) => i.is_main).length;

if (targets.length !== EXPECTED_TARGETS) fail(`targets ${targets.length} <> ${EXPECTED_TARGETS}`);
if (unexpected.length > 0) fail(`неочікувані targets: ${unexpected.join(', ')}`);
if (existing.length > 0) fail(`${existing.length} існуючих зображень у targets — неочікуваний стан`);
if (plan.noStaging.length > 0) fail(`без staging pictures: ${plan.noStaging.join(', ')}`);
if (plan.emptyPics.length > 0) fail(`порожні pictures[]: ${plan.emptyPics.join(', ')}`);
if (plan.invalidUrlTotal > 0) fail(`${plan.invalidUrlTotal} невалідних URL у staging`);
if (plan.badHost.length > 0) fail(`заборонені hosts: ${plan.badHost.slice(0, 5).join('; ')}…`);
if (plan.withExisting.length > 0) fail(`targets вже мають зображення: ${plan.withExisting.join(', ')}`);
if (plan.productMismatch.length > 0) fail(`product_id не збігається з allowlist: ${plan.productMismatch.join('; ')}`);
if (plan.conflicts.length > 0) fail(`конфлікти: ${plan.conflicts.join('; ')}`);
if (mains !== EXPECTED_TARGETS) fail(`main assignments ${mains} <> ${EXPECTED_TARGETS}`);
for (const du of DU_IDS) {
  if (!du.endsWith('_du')) fail(`allowlist key ${du} не закінчується на _du`);
  const t = targets.find((x) => x.yugcontract_id === du);
  if (!t) fail(`target ${du} відсутній у products`);
  if (t.is_active !== true) fail(`target ${du} неактивний`);
}
const insertHosts = new Set(plan.inserts.map((i) => new URL(i.image_url).host));
if (insertHosts.size !== 1 || !insertHosts.has(ALLOWED_HOST)) fail(`hosts: ${[...insertHosts].join(', ')}`);

const totalImagesBefore = await totalImageCount();
console.log(`guards OK: targets=${targets.length}, INSERT=${plan.inserts.length}, main=${mains}, hosts=${[...insertHosts].join(', ')}`);
console.log(`
READY TO INSERT:
targets: ${EXPECTED_TARGETS}
INSERT: ${plan.inserts.length}
UPDATE: 0
DELETE: 0
products writes: 0
hosts: b2b.yugcontract.ua only
`);

// ON CONFLICT DO NOTHING against UNIQUE (product_id, image_url) — idempotent.
const CHUNK = 200;
let written = 0;
for (let i = 0; i < plan.inserts.length; i += CHUNK) {
  const part = plan.inserts.slice(i, i + CHUNK);
  const { error } = await client
    .from('product_images')
    .upsert(part, { onConflict: 'product_id,image_url', ignoreDuplicates: true });
  if (error) fail(`product_images upsert chunk ${i / CHUNK}: ${error.message}`);
  written += part.length;
  console.log(`chunk ${i / CHUNK + 1}: +${part.length} (усього ${written}/${plan.inserts.length})`);
}

const baseline: Baseline = {
  at: new Date().toISOString(),
  plannedInserts: plan.inserts.length,
  totalImagesBefore,
  targetImagesBefore: {},
  products: {},
};
for (const t of targets) {
  baseline.targetImagesBefore[t.id] = 0;
  baseline.products[t.id] = {
    yugcontract_id: t.yugcontract_id,
    sku: t.sku,
    slug: t.slug,
    price: t.price,
    stock_quantity: t.stock_quantity,
    is_active: t.is_active,
  };
}
writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
console.log(`\nГотово: ${written} URL скопійовано (ON CONFLICT DO NOTHING). DELETE=0, UPDATE=0, products не змінено.`);
console.log('Baseline збережено. Наступний крок: --postcheck.');
