/**
 * ONE-OFF GENERATOR (read-only DB): rebuild app/lib/du-redirects.ts from the
 * live audit data. Writes ONLY the generated module — never touches products,
 * importer tables, or any DB row.
 *
 * Safety gates (hard fail, exit 1) — the module is regenerated ONLY when the
 * DB still matches the audit this script was written against:
 *   - exactly 122 `_du` products with an existing base;
 *   - exactly 25 `_du` orphans without a base;
 *   - 122/122 base_slug === du_slug minus the `_du` suffix;
 *   - exactly 17 pairs with differing price (fixed id set).
 *
 * Task #34 audit 2026-09-01 (regeneration after supplier catalog churn —
 * investigation in Task #33):
 *   - live state: 147 _du total = 122 paired + 25 orphan; slug derivation
 *     verified 122/122; 104 same-price pairs; 18 price-diff pairs.
 *   - 2026-09-02 regeneration: 7290720_du drifted back to equal prices
 *     (du 4999 -> 4799, base 4799) -> 105 same-price + 17 price-diff.
 *   - 9 former redirect pairs drifted to differing prices since the Task #26
 *     generation and move to the price-diff list (their 301s are removed —
 *     they were the mis-redirect risk identified in Task #33):
 *     6349848_du, 6482008_du, 6885495_du, 7067155_du, 7109372_du,
 *     7232191_du, 7264937_du, 7269797_du, 7290720_du.
 *   - the 10 Task #26 price-diff pairs all still differ (amounts drifted
 *     further); 6349848_du etc. were NOT previously allowlisted diffs.
 *   - 1 new orphan (25 vs 24) and 17 net-new _du rows from the supplier
 *     feed; new _du products are NOT redirected merely because a base
 *     exists — only verified same-price pairs redirect.
 *
 * Usage: node --experimental-strip-types scripts/yugcontract-du-redirect-allowlist.ts
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
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
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // service key OK: script-side only, read-only usage
  { auth: { persistSession: false } }
);

const AUDIT_DATE = '2026-09-02';
const PRICE_DIFF_YC = new Set([
  // 6 documented by the 2026-08-31 audit (still differ on 2026-09-01)
  '6241811_du', '6849632_du', '6873343_du', '6988988_du', '7204300_du', '7270074_du',
  // drifted from the redirect set (prices changed since 2026-08-31, Task #26)
  '6711226_du', '7022284_du',
  // new pair with a differing price (orphan 7083113_du gained its base)
  '7083113_du',
  // drifted from the redirect set since the Task #26 generation (supplier
  // price churn, Task #33/#34) — their stale 301s are removed by this run
  '6349848_du', '6482008_du', '6885495_du', '7067155_du', '7109372_du',
  '7232191_du', '7264937_du', '7269797_du',
  // notes:
  // - 6871226_du left this list on 2026-09-01 — its du and base prices are
  //   now equal (19499.00 both sides), so it qualifies as a verified
  //   same-price redirect;
  // - 7290720_du left this list on 2026-09-02 — same case (du 4999 -> 4799,
  //   base 4799; prices equal), flagged by catalog-health-check price-drift.
]);
const stripDu = (s: string) => s.replace(/_du$/, '');

interface YcRow {
  yugcontract_id: string;
  slug: string;
  price: number | null;
}

interface DuRedirectPair {
  duYc: string;
  duSlug: string;
  baseYc: string;
  baseSlug: string;
  duPrice?: string;
  basePrice?: string;
}

// 1. Load all du products, then all base products (self-join is not
// expressible in PostgREST — two reads, joined in JS).
// PostgREST caps a single response (default 1000 rows) — paginate with range.
const PAGE = 1000;
const readAll = async (filter: 'like' | 'not-like'): Promise<YcRow[]> => {
  const rows: YcRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = svc
      .from('products')
      .select('yugcontract_id, slug, price')
      .order('yugcontract_id')
      .range(from, from + PAGE - 1);
    q = filter === 'like'
      ? q.like('yugcontract_id', '%\\_du')
      : q.not('yugcontract_id', 'like', '%\\_du');
    const { data, error } = await q;
    if (error || !data) throw new Error(error?.message ?? `read failed (${filter})`);
    rows.push(...(data as YcRow[]));
    if (data.length < PAGE) return rows;
  }
};

const duRows = await readAll('like');
const baseRows = await readAll('not-like');

const bases = new Map<string, YcRow>(
  (baseRows as YcRow[]).map((b) => [b.yugcontract_id, b])
);

const pairs: DuRedirectPair[] = (duRows as YcRow[]).flatMap((du): DuRedirectPair[] => {
  const base = bases.get(stripDu(du.yugcontract_id));
  if (!base) return []; // orphan — 26 expected, gated below
  return [{
    duYc: du.yugcontract_id,
    duSlug: du.slug,
    baseYc: base.yugcontract_id,
    baseSlug: base.slug,
    ...(du.price !== base.price
      ? { duPrice: String(du.price), basePrice: String(base.price) }
      : {}),
  }];
});
const orphans = (duRows as YcRow[]).filter((du) => !bases.has(stripDu(du.yugcontract_id)));

// 2. Audit gates — every violation is a hard stop.
const fail = (msg: string) => { console.error('AUDIT GATE FAILED:', msg); process.exit(1); };
if (pairs.length !== 122) fail(`pairs ${pairs.length} !== 122`);
if (orphans.length !== 25) fail(`orphans ${orphans.length} !== 25`);
if (pairs.some((p) => p.baseSlug !== stripDu(p.duSlug))) fail('slug derivation changed');
const priceDiff = pairs.filter((p) => p.duPrice !== undefined);
if (priceDiff.length !== 17) fail(`price-diff ${priceDiff.length} !== 17`);
if (priceDiff.some((p) => !PRICE_DIFF_YC.has(p.duYc))) fail('price-diff set changed');
if (PRICE_DIFF_YC.size !== 17) fail(`PRICE_DIFF_YC ${PRICE_DIFF_YC.size} !== 17`);

// 3. Emit the module (104 redirect pairs = pairs minus 18 price-diff).
const redirect = pairs
  .filter((p) => p.duPrice === undefined)
  .sort((a, b) => a.duYc.localeCompare(b.duYc));
const diff = [...priceDiff].sort((a, b) => a.duYc.localeCompare(b.duYc));
const q = JSON.stringify;
const emit = (list: typeof redirect, withPrices: boolean) => list.map((p) => `  {
    duYc: ${q(p.duYc)}, duSlug: ${q(p.duSlug)},
    baseYc: ${q(p.baseYc)}, baseSlug: ${q(p.baseSlug)},${withPrices
      ? `\n    duPrice: ${q(p.duPrice!)}, basePrice: ${q(p.basePrice!)},` : ''}
  }`).join(',\n');

const out = `/**
 * GENERATED by scripts/yugcontract-du-redirect-allowlist.ts on audit ${AUDIT_DATE}
 * (Task #34 regeneration after supplier catalog churn — investigation Task #33).
 * DO NOT EDIT BY HAND — regenerate instead. Read-only audit source:
 * 122 verified _du↔base pairs (name/brand/category 100% equal; slug derivation
 * verified 122/122; prices equal at audit time EXCEPT the price-diff list).
 * One pair (3047192_du) has an empty du-side image set (the supplier feed has
 * no pictures for that variant; the base carries the images) — the du page
 * is imageless either way, the redirect only improves it.
 * ${redirect.length} same-price pairs -> permanent redirect to base.
 * ${diff.length} price-diff pairs -> documented here ONLY, never redirected
 * (business decision pending; both prices kept for the decision). 9 of these
 * were redirects in the previous allowlist and lost their 301 in this run.
 * The ${orphans.length} _du orphans are intentionally absent from both lists.
 */
export interface DuRedirectPair {
  duYc: string; duSlug: string; baseYc: string; baseSlug: string;
  duPrice?: string; basePrice?: string;
}

export const DU_ALLOWLIST_AUDIT_DATE = ${q(AUDIT_DATE)} as const;

export const DU_REDIRECT_PAIRS: readonly DuRedirectPair[] = [
${emit(redirect, false)},
];

export const DU_PRICE_DIFF_PAIRS: readonly DuRedirectPair[] = [
${emit(diff, true)},
];

export const DU_REDIRECT_BY_YC: ReadonlyMap<string, DuRedirectPair> = new Map(
  DU_REDIRECT_PAIRS.map((p) => [p.duYc, p])
);

export const DU_REDIRECT_SLUGS: ReadonlySet<string> = new Set(
  DU_REDIRECT_PAIRS.map((p) => p.duSlug)
);
`;
/**
 * Write via tmp-file + rename: a crash mid-write must not leave a truncated
 * du-redirects.ts/.json behind — next.config.ts imports the JSON at build
 * time, so a partial file breaks the next `next build`.
 */
function atomicWrite(target: string, data: string): void {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}
atomicWrite(path.join(root, 'app/lib/du-redirects.ts'), out);

// 4. Emit the JSON consumed by next.config.ts redirects() — the same
// same-price pairs (same duYc-ascending order), slugs only.
const json = {
  generatedAt: AUDIT_DATE,
  redirect: redirect.map((p) => ({ duSlug: p.duSlug, baseSlug: p.baseSlug })),
};
atomicWrite(path.join(root, 'app/lib/du-redirects.json'), JSON.stringify(json, null, 2) + '\n');

console.log(`OK: wrote app/lib/du-redirects.ts (${redirect.length} redirect, ${diff.length} price-diff, ${orphans.length} orphans untouched)`);
console.log(`OK: wrote app/lib/du-redirects.json (${json.redirect.length} redirect pairs for next.config redirects())`);
