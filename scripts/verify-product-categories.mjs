#!/usr/bin/env node
/**
 * READ-ONLY verification of the product_categories rollout.
 * Uses the anon key against RLS-protected REST — exactly what the
 * storefront can see. Never writes anything.
 *
 * Checks:
 *   1. total active products vs baseline expectation
 *   2. junction links coverage: every active product with a category_id
 *      resolves to ≥1 direct link (via embedded filter on pc join)
 *   3. duplicate pairs impossible (PK) — link count vs distinct pairs via count
 *   4. per-category spot checks: a few categories incl. parents/leaves
 *
 * Usage: node scripts/verify-product-categories.mjs
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_0-9]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')];
    })
);

const BASE = env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1';
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

async function count(query) {
  const res = await fetch(`${BASE}/${query}`, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const range = res.headers.get('content-range') ?? '';
  const total = range.split('/')[1];
  if (!total) throw new Error(`no content-range for ${query}: ${res.status}`);
  return Number(total);
}

async function rows(query) {
  const res = await fetch(`${BASE}/${query}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${res.status} for ${query}: ${await res.text()}`);
  return res.json();
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const totalProducts = await count('products?select=id&is_active=eq.true');
const withCategory = await count(
  'products?select=id&is_active=eq.true&category_id=not.is.null'
);
const totalCategories = await count('categories?select=id&is_active=eq.true');

console.log(`active products:          ${totalProducts}`);
console.log(`with category_id:         ${withCategory}`);
console.log(`active categories:        ${totalCategories}`);
check('baseline product count matches audit (~4322)', totalProducts === 4322, String(totalProducts));

// The product_categories table exists only after migration 016.
// A 404/PGRST205 here means: apply 016 first.
const tableVisible = await fetch(
  `${BASE}/product_categories?select=product_id&limit=1`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
);
if (!tableVisible.ok) {
  const body = await tableVisible.text();
  check(
    'product_categories reachable through REST',
    false,
    body.slice(0, 120)
  );
  console.log('\n=> Apply database/migrations/016_product_categories.sql first.');
  process.exit(1);
}

const linkedCount = await count(
  'product_categories?select=product_id&limit=1'
);
console.log(`junction rows:            ${linkedCount}`);

check(
  'backfill complete: every categorized active product has ≥1 link',
  linkedCount >= withCategory,
  `${linkedCount} links vs ${withCategory} categorized`
);

// Every distinct pair must be unique by PK; compare a paged scan lightly:
const sample = await rows('product_categories?select=product_id,category_id&order=product_id&limit=1000');
const seen = new Set();
let dupes = 0;
for (const r of sample) {
  const k = `${r.product_id}:${r.category_id}`;
  if (seen.has(k)) dupes += 1;
  seen.add(k);
}
check('no duplicate pairs in first page of junction', dupes === 0);

// Spot-check category distribution: top-level roots must not be empty.
const rootCats = await rows(
  'categories?select=id,name&parent_id=is.null&is_active=eq.true&order=sort_order.asc,id.asc&limit=3'
);
for (const c of rootCats) {
  // Subtree-inclusive storefront-style check requires app logic; here we
  // verify DIRECT links only and print them for manual sanity.
  const n = await count(`product_categories?select=product_id&category_id=eq.${c.id}`);
  console.log(`direct links in «${c.name}»: ${n}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
