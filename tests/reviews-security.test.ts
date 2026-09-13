/**
 * Security & contract pins for the product-reviews feature (Відгуки).
 * Static source invariants: node:test cannot execute JSX/TS routes directly,
 * mirroring tests/popular-products.test.ts and orders-revoke-migration.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// 2026-09 refactor: the catalog god-module was split into app/lib/catalog/* —
// the lib pins below read every fragment (original file order).
const CATALOG_LIB_FILES = [
  'app/lib/catalog/shared.ts',
  'app/lib/catalog/filters.ts',
  'app/lib/catalog/slug-lookup.ts',
  'app/lib/catalog/product-feed.ts',
  'app/lib/catalog/counts.ts',
  'app/lib/catalog/listing.ts',
  'app/lib/catalog/wallpaper-listing.ts',
  'app/lib/catalog/reviews.ts',
  'app/lib/catalog/shelves.ts',
  'app/lib/catalog/categories.ts',
  'app/lib/catalog/search.ts',
  'app/lib/catalog/product-card.ts',
  'app/lib/catalog/related.ts',
];
const catalogLib = (): string =>
  CATALOG_LIB_FILES.map((rel) => src(rel)).join('\n');

// ---- migration: table shape, RLS, no PII ----

test('REVIEWS MIGRATION: table exists with rating/text/status constraints', () => {
  const sql = src('database/migrations/015_product_reviews.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.product_reviews/);
  assert.match(sql, /rating smallint NOT NULL CHECK \(rating >= 1 AND rating <= 5\)/);
  assert.match(sql, /char_length\(text\) BETWEEN 10 AND 1000/);
  assert.match(sql, /char_length\(display_name\) BETWEEN 1 AND 40/);
  assert.match(sql, /status text NOT NULL DEFAULT 'pending'/);
  assert.match(sql, /CHECK \(status IN \('pending','published','rejected'\)\)/);
  assert.match(sql, /REFERENCES public\.products\(id\) ON DELETE CASCADE/);
});

test('REVIEWS MIGRATION: RLS enabled and public sees ONLY published rows', () => {
  const sql = src('database/migrations/015_product_reviews.sql');
  assert.match(sql, /ALTER TABLE public\.product_reviews ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FOR SELECT[\s\S]*USING \(status = 'published'\)/);
});

test('REVIEWS MIGRATION: no write policies — service-role writes only', () => {
  const sql = src('database/migrations/015_product_reviews.sql');
  assert.doesNotMatch(sql, /CREATE POLICY[\s\S]*?INSERT/i, 'no INSERT policy');
  assert.doesNotMatch(sql, /CREATE POLICY[\s\S]*?UPDATE/i, 'no UPDATE policy');
  assert.doesNotMatch(sql, /CREATE POLICY[\s\S]*?(DELETE|ALL)/i, 'no DELETE/ALL policy');
});

test('REVIEWS MIGRATION: zero customer PII columns', () => {
  const raw = src('database/migrations/015_product_reviews.sql');
  // Strip -- comments: the pin applies to the actual DDL, not the docs.
  const sql = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(
    sql,
    /\bemail\b|\bphone\b|\bip_address\b|\buser_agent\b|\bcustomer_id\b|\border_id\b/i,
    'no order/customer linkage columns may leak PII'
  );
});

test('REVIEWS MIGRATION: indexes for storefront + moderation reads', () => {
  const sql = src('database/migrations/015_product_reviews.sql');
  assert.match(
    sql,
    /idx_product_reviews_product_published[\s\S]*\(product_id, status, created_at DESC, id DESC\)/
  );
  assert.match(sql, /idx_product_reviews_moderation[\s\S]*\(status, created_at DESC, id DESC\)/);
});

// ---- public submission endpoint: rate-limit / honeypot / daily cap ----

test('REVIEWS API: dedicated rate-limit rule set exists', () => {
  const limiter = src('app/lib/rate-limit.ts');
  assert.match(
    limiter,
    /reviews:\s*\[\s*\{\s*max:\s*3,\s*windowMs:\s*60_000\s*\},\s*\{\s*max:\s*10,\s*windowMs:\s*60 \* 60_000\s*\},?\s*\]/
  );
});

// ---- storefront readers: published-only, bounded, tiebroken ----

test('REVIEWS CATALOG: public reader filters published and paginates deterministically', () => {
  const lib = catalogLib();
  const fn = lib.slice(
    lib.indexOf('async function fetchPublishedReviews'),
    lib.indexOf('export interface ReviewSummary')
  );
  assert.match(fn, /\.eq\('status', 'published'\)/, 'defense-in-depth status filter');
  assert.match(fn, /\.eq\('product_id', productId\)/);
  assert.match(fn, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(fn, /\.order\('id'/, 'id tiebreaker required');
  assert.match(fn, /\.range\(/, 'bounded window');
  assert.doesNotMatch(fn, /select\('\*'\)/, 'column whitelist only');
});

test('REVIEWS CATALOG: summary uses one aggregated read (no row payload)', () => {
  const lib = catalogLib();
  const fn = lib.slice(
    lib.indexOf('async function fetchReviewSummary'),
    lib.indexOf('export async function fetchFeaturedProducts')
  );
  // Perf audit Step 2 (migration 029): the five per-rating head-counts were
  // replaced by ONE SECURITY INVOKER group-by RPC — still no review rows
  // cross the wire, only ≤5 aggregated counts.
  assert.match(fn, /rpc\('product_review_summary'/);
  assert.doesNotMatch(fn, /\.from\('product_reviews'\)/, 'no direct row reads in summary');
  assert.doesNotMatch(fn, /for\s*\(\s*;;\)/, 'no unbounded loops');

  // Migration must keep the RPC read-only and RLS-safe (invoker role).
  const migration = readFileSync(
    'database/migrations/029_product_review_summary_rpc.sql',
    'utf8'
  );
  assert.match(migration, /security invoker/);
  assert.match(migration, /status = 'published'/);
  assert.match(migration, /grant execute on function public\.product_review_summary\(uuid\) to anon/);
});

test('REVIEWS CATALOG: page size constant is 10', () => {
  const lib = catalogLib();
  assert.match(lib, /export const REVIEWS_PAGE_SIZE = 10/);
});

// ---- public POST /api/reviews: spam layers + pending-by-default ----

test('REVIEWS SUBMIT: rate limit, honeypot, validator, product check, daily cap', () => {
  const route = src('app/api/reviews/route.ts');
  assert.match(route, /enforceRateLimit\(request, 'reviews'\)/);
  assert.match(route, /website/, 'honeypot field checked');
  assert.match(route, /validateReviewInput/);
  assert.match(route, /REVIEW_DAILY_CAP/, 'shared daily cap enforced');
  assert.match(route, /isUuid/);
  assert.match(
    route,
    /\.from\('products'\)[\s\S]*?is_active/,
    'target product must exist & be active'
  );
});

test('REVIEWS SUBMIT: inserts pending via service role, honest failure modes', () => {
  const route = src('app/api/reviews/route.ts');
  assert.match(route, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(route, /status: 'pending'/, 'never auto-publish');
  assert.match(route, /503/, 'storage-not-applied degrades honestly');
  assert.match(route, /429/, 'daily-cap overflow answers 429');
  assert.doesNotMatch(
    route,
    /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/,
    'anon key cannot insert'
  );
});

test('REVIEWS SUBMIT: response never echoes stored row internals', () => {
  const route = src('app/api/reviews/route.ts');
  assert.match(route, /Response\.json\(\{ ok: true \}, \{ status: 201 \}\)/);
});

// ---- admin moderation routes ----

test('REVIEWS ADMIN: both routes sit behind requireAdminApi', () => {
  const listRoute = src('app/api/admin/reviews/route.ts');
  const itemRoute = src('app/api/admin/reviews/[id]/route.ts');
  for (const [name, route] of [
    ['list', listRoute],
    ['item', itemRoute],
  ] as const) {
    assert.ok(route.includes('requireAdminApi()'), `${name} route must guard`);
    const parts = route
      .split(/export async function (?:GET|PATCH|POST|PUT|DELETE)/)
      .slice(1);
    assert.ok(parts.length >= 1, `${name}: expected handlers`);
    for (const part of parts) {
      const guardPos = part.indexOf('requireAdminApi()');
      assert.ok(guardPos >= 0, 'handler must call the guard');
      const dbPos = part.indexOf(".from('");
      if (dbPos >= 0) assert.ok(guardPos < dbPos, 'guard BEFORE any DB query');
    }
    assert.doesNotMatch(route, /select\('\*'\)/, 'column whitelist only');
  }
});

test('REVIEWS ADMIN LIST: whitelist filter, bounded page, deterministic order', () => {
  const route = src('app/api/admin/reviews/route.ts');
  assert.match(route, /\['pending', 'published', 'rejected', 'all'\]/);
  assert.match(route, /MAX_PAGE_SIZE = 100/, 'size hard-capped at 100');
  assert.match(route, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(route, /\.order\('id', \{ ascending: false \}\)/);
  assert.match(route, /\.range\(/);
  assert.match(route, /count: 'exact'/, 'total comes from COUNT, not rows.length');
  assert.match(
    route,
    /products\(name, slug\)/,
    'product context embedded with narrow columns'
  );
});

test('REVIEWS ADMIN ITEM: action whitelist maps onto status values', () => {
  const route = src('app/api/admin/reviews/[id]/route.ts');
  assert.match(route, /publish:\s*'published'/);
  assert.match(route, /reject:\s*'rejected'/);
  assert.match(route, /pending:\s*'pending'/, 'unpublish path exists');
  assert.match(route, /updated_at/, 'status transitions stamp updated_at');
  assert.match(route, /isUuid/);
});

// ---- storefront form island ----

test('REVIEWS FORM: stars/limits/honeypot/moderation messaging pinned', () => {
  const form = src('app/components/ReviewFormModal.tsx');
  assert.match(form, /'use client'/);
  assert.match(form, /StarIcon/);
  assert.match(form, /maxLength=\{REVIEW_MAX_LENGTH\}/);
  assert.match(form, /maxLength=\{REVIEW_NAME_MAX_LENGTH\}/);
  assert.match(form, /website/, 'honeypot present');
  assert.match(form, /модерац/, 'success copy promises moderation');
  assert.match(form, /api\/reviews/);
  assert.doesNotMatch(form, /dangerouslySetInnerHTML/);
});

test('ICONS: StarIcon supports filled variant like HeartIcon', () => {
  const icons = src('app/components/icons.tsx');
  assert.match(icons, /export function StarIcon\(\{[\s\S]*filled = false/);
});

// ---- product page section ----

test('REVIEWS SECTION: summary/distribution/list/pagination rendered safely', () => {
  const section = src('app/components/ProductReviews.tsx');
  assert.match(section, /Відгуки/);
  assert.match(section, /Залишити відгук/);
  assert.match(section, /Анонімний відгук/, 'missing display_name falls back');
  assert.match(section, /distribution/, 'star distribution bars rendered');
  assert.match(section, /reviews_page=/, 'pagination links preserve param');
  assert.match(section, /productId/, 'form receives explicit product id');
  assert.doesNotMatch(section, /dangerouslySetInnerHTML/, 'text children only');
});

test('PRODUCT PAGE: wires reviews section with SSR first page (Task #5B: ISR, no searchParams)', () => {
  const page = src('app/product/[slug]/page.tsx');
  assert.match(page, /fetchPublishedReviews/);
  assert.match(page, /fetchReviewSummary/);
  assert.match(page, /<ProductReviews/);
});

test('PRODUCT PAGE: unapplied migration degrades to empty reviews, never a broken page', () => {
  const page = src('app/product/[slug]/page.tsx');
  // Storage for reviews is applied via a manual migration; until then the
  // reads fail. Reviews are supplementary — the page must survive. Since the
  // perf-audit Step 2 the reads run under Promise.allSettled, so a rejection
  // degrades to the empty state instead of breaking the page.
  const guardPart = page.slice(
    page.indexOf('Promise.allSettled('),
    page.indexOf('const galleryUrls')
  );
  assert.ok(
    guardPart.includes("reviewsSettled.status === 'fulfilled'") &&
      guardPart.includes('reviews unavailable'),
    'allSettled-guarded reads with honest fallback'
  );
  assert.match(page, /console\.error\('reviews unavailable/, 'honest server log');
  assert.match(page, /EMPTY_REVIEW_SUMMARY|total: 0/, 'empty-state fallback');
});
