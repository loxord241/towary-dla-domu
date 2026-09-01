/**
 * ONE-OFF GENERATOR (read-only DB): rebuild app/lib/du-redirects.ts from the
 * live audit data. Writes ONLY the generated module — never touches products,
 * importer tables, or any DB row.
 *
 * Safety gates (hard fail, exit 1) — the module is regenerated ONLY when the
 * DB still matches the audit this script was written against:
 *   - exactly 106 `_du` products with an existing base;
 *   - exactly 24 `_du` orphans without a base;
 *   - 106/106 base_slug === du_slug minus the `_du` suffix;
 *   - exactly 10 pairs with differing price (fixed id set).
 *
 * Task #26 audit 2026-09-01 (regeneration after price drift):
 *   - 2 documented orphans gained bases on the 2026-08-31 16:00 import run:
 *     6985231_du (SW383D10, price-equal → NEW redirect),
 *     7083113_du (DT9814F0, price-diff → price-diff list);
 *   - 1 brand-new _du row appeared: 3047192_du (UFO album, price-equal,
 *     name/brand/category equal, du side has 0 images — the feed itself has
 *     no pictures for this variant, so the du page is imageless; the base
 *     carries the 2 images) → NEW redirect with documented image gap;
 *   - 3 former redirect pairs drifted to differing prices and move to the
 *     price-diff list (no more 301, both pages stay visible pending the
 *     business price decision): 6711226_du, 6871226_du, 7022284_du;
 *   - the 6 documented price-diff pairs all still differ (amounts drifted).
 *
 * Usage: node --experimental-strip-types scripts/yugcontract-du-redirect-allowlist.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
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

const AUDIT_DATE = '2026-09-01';
const PRICE_DIFF_YC = new Set([
  // 6 documented by the 2026-08-31 audit (still differ on 2026-09-01)
  '6241811_du', '6849632_du', '6873343_du', '6988988_du', '7204300_du', '7270074_du',
  // drifted from the redirect set (prices changed since 2026-08-31)
  '6711226_du', '6871226_du', '7022284_du',
  // new pair with a differing price (orphan 7083113_du gained its base)
  '7083113_du',
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
if (pairs.length !== 106) fail(`pairs ${pairs.length} !== 106`);
if (orphans.length !== 24) fail(`orphans ${orphans.length} !== 24`);
if (pairs.some((p) => p.baseSlug !== stripDu(p.duSlug))) fail('slug derivation changed');
const priceDiff = pairs.filter((p) => p.duPrice !== undefined);
if (priceDiff.length !== 10) fail(`price-diff ${priceDiff.length} !== 10`);
if (priceDiff.some((p) => !PRICE_DIFF_YC.has(p.duYc))) fail('price-diff set changed');

// 3. Emit the module (96 redirect pairs = pairs minus 10 price-diff).
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
 * GENERATED by scripts/yugcontract-du-redirect-allowlist.ts on audit ${AUDIT_DATE}.
 * DO NOT EDIT BY HAND — regenerate instead. Read-only audit source:
 * 106 verified _du↔base pairs (name/brand/category 100% equal; slug derivation
 * verified 106/106; prices equal at audit time EXCEPT the price-diff list).
 * One pair (3047192_du) has an empty du-side image set (the supplier feed has
 * no pictures for that variant; the base carries the images) — the du page
 * is imageless either way, the redirect only improves it.
 * ${redirect.length} same-price pairs -> permanent redirect to base.
 * ${diff.length} price-diff pairs -> documented here ONLY, never redirected
 * (business decision pending; both prices kept for the decision).
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
writeFileSync(path.join(root, 'app/lib/du-redirects.ts'), out);

// 4. Emit the JSON consumed by next.config.ts redirects() — the same 96
// same-price pairs (same duYc-ascending order), slugs only.
const json = {
  generatedAt: AUDIT_DATE,
  redirect: redirect.map((p) => ({ duSlug: p.duSlug, baseSlug: p.baseSlug })),
};
writeFileSync(path.join(root, 'app/lib/du-redirects.json'), JSON.stringify(json, null, 2) + '\n');

console.log(`OK: wrote app/lib/du-redirects.ts (${redirect.length} redirect, ${diff.length} price-diff, ${orphans.length} orphans untouched)`);
console.log(`OK: wrote app/lib/du-redirects.json (${json.redirect.length} redirect pairs for next.config redirects())`);
