/**
 * ONE-OFF GENERATOR (read-only DB): rebuild app/lib/du-redirects.ts from the
 * live audit data. Writes ONLY the generated module — never touches products,
 * importer tables, or any DB row.
 *
 * Safety gates (hard fail, exit 1) — the module is regenerated ONLY when the
 * DB still matches the audit this script was written against (2026-09-16):
 *   - exactly 293 `_du` products with an existing base;
 *   - exactly 38 `_du` orphans without a base;
 *   - every base_slug === du_slug minus the `_du` suffix;
 *   - exactly 19 pairs with differing price (fixed id set PRICE_DIFF_YC).
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
 *   - 2026-09-05 regeneration (supplier feed collapsed 2026-09-04/05, no
 *     sync ran — drift came from the 2026-09-03 sync settling): 1 net-new
 *     _du row 6381053_du found its base 6381053 (prices equal, slug
 *     derivation verified) -> 106 redirect + 17 price-diff, 25 orphans
 *     unchanged. Price-diff id set unchanged; no known pair broke.
 *   - 2026-09-16 regeneration (first after the 2026-09-14/15 syncs settled
 *     the post-incident feed): 10 allowlisted pairs (3047192, 6521818,
 *     6739520, 6884592, 6906759, 6923037, 6992422, 7119231, 7120201,
 *     7259417) are GONE from products entirely — both the _du and the base
 *     row deleted OUTSIDE the importer (importer never deletes; read-only
 *     probe scripts/tmp-probe-du-vanished.ts). 7220883_du drifted to equal
 *     prices (du = base = 32999) -> dropped from PRICE_DIFF_YC, redirects
 *     with all pairs under the 09-12 policy. Former orphan 6895802_du
 *     found its base 6895802 (prices equal 41499, slug verified) via the
 *     09-14/15 sync. Of the 40 expected orphans one row also vanished
 *     (id unrecorded — the audit tracks the count, not ids): 40 -> 38 =
 *     38 alive, 1 promoted, 1 deleted. Gates: pairs 302 -> 293,
 *     orphans 40 -> 38, price-diff 20 -> 19.
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
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const { createClient } = await import('@supabase/supabase-js');
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // service key OK: script-side only, read-only usage
  { auth: { persistSession: false } }
);

const AUDIT_DATE = '2026-09-16';
// 2026-09-12 POLICY CHANGE (owner audit fix «дві ціни на один товар»):
// ALL verified pairs redirect to base, including price-diff ones. Base is
// the canonical listing (it lives in categories/catalogs); a supplier _du
// shadow page with a second price on the storefront AND in the merchant
// feed is worse than showing the base price. PRICE_DIFF_YC is still gated
// 1:1 so any NEW drift fails the gate and forces a human look.
const PRICE_DIFF_YC = new Set([
  '6241811_du',
  '6482008_du',
  '6615810_du',
  '6711226_du',
  '6790006_du',
  '6873343_du',
  '6885495_du',
  '6895807_du',
  '6965695_du',
  '6990159_du',
  '7067155_du',
  '7083113_du',
  '7109372_du',
  '7111320_du',
  '7194071_du',
  '7204300_du',
  // 7220883_du removed 2026-09-16: prices equalized (du = base = 32999),
  // redirects with all pairs under the 09-12 all-pairs-redirect policy.
  '7232191_du',
  '7248827_du',
  '7270074_du',
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
  if (!base) return []; // orphan — gated below
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
if (pairs.length !== 293) fail(`pairs ${pairs.length} !== 293`);
if (orphans.length !== 38) fail(`orphans ${orphans.length} !== 38`);
if (pairs.some((p) => p.baseSlug !== stripDu(p.duSlug))) fail('slug derivation changed');
const priceDiff = pairs.filter((p) => p.duPrice !== undefined);
if (priceDiff.length !== 19) fail(`price-diff ${priceDiff.length} !== 19`);
if (priceDiff.some((p) => !PRICE_DIFF_YC.has(p.duYc))) fail('price-diff set changed');
if (PRICE_DIFF_YC.size !== 19) fail(`PRICE_DIFF_YC ${PRICE_DIFF_YC.size} !== 19`);

// 3. Emit the module: ALL 293 verified pairs redirect to base (policy
// change 2026-09-12); the price-diff subset stays documented with prices.
const redirect = [...pairs].sort((a, b) => a.duYc.localeCompare(b.duYc));
const diff = [...priceDiff].sort((a, b) => a.duYc.localeCompare(b.duYc));
const q = JSON.stringify;
const emit = (list: typeof redirect, withPrices: boolean) => list.map((p) => `  {
    duYc: ${q(p.duYc)}, duSlug: ${q(p.duSlug)},
    baseYc: ${q(p.baseYc)}, baseSlug: ${q(p.baseSlug)},${withPrices
      ? `\n    duPrice: ${q(p.duPrice!)}, basePrice: ${q(p.basePrice!)},` : ''}
  }`).join(',\n');

const out = `/**
 * GENERATED by scripts/yugcontract-du-redirect-allowlist.ts on audit ${AUDIT_DATE}
 * DO NOT EDIT BY HAND — regenerate instead. Read-only audit source:
 * ${pairs.length} verified _du↔base pairs (name 302/302 equal, slug derivation
 * verified ${pairs.length}/${pairs.length} live on ${AUDIT_DATE}).
 * ${redirect.length} pairs -> permanent redirect to base (ALL pairs — policy
 * change ${AUDIT_DATE}, owner audit fix «дві ціни на один товар»: a _du
 * shadow page with a second price must not be a live storefront/feed page;
 * the base listing is canonical). Prices of the ${diff.length} drifted pairs
 * are documented in DU_PRICE_DIFF_PAIRS for monitoring.
 * The ${orphans.length} _du orphans are intentionally absent (no verified
 * base — never redirected).
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
