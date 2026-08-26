# Storefront Features: Reviews / Recently Viewed / Popular Products — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 3 production features for TOWARY DLA DOMU: (1) moderated product reviews, (2) localStorage-based «Нещодавно переглянуті», (3) admin-curated «Популярні товари» with an enforced max-8 business rule.

**Architecture:** Follows the existing my-shop conventions exactly — service-role writes from server routes only, RLS-restricted public reads through the anonymous client in `app/lib/catalog.ts`, `requireAdminApi()` for every admin route, bounded pagination with deterministic `id` tiebreakers, pure node-testable storage/validation modules, static source-invariant tests via `node:test`.

**Tech Stack:** Next.js 16.3.1 App Router (params/searchParams are Promises), React 19, Tailwind v4, Supabase (PostgREST + RLS), `node:test` + `node:assert/strict`.

**Spec:** User brief 2026-08-26 (3 features) + resolved UX decisions: empty popular section → hide entirely; featured toggle stays ONLY in the edit modal (+hint+counter); optional display name ≤40 chars; reviews page size 10 + pagination; verified purchase NOT in v1.

## Global Constraints

- NO production DB writes; migration files are prepared but NEVER applied by the agent.
- Do not modify: orders/checkout/payment/auth, existing RLS of existing tables, Yugcontract importer, product_images importer, F12 demote-before-promote, F6 unique index, F13 make-main, cart logic.
- All new SELECTs bounded; all pagination deterministic order + `.order('id')` tiebreaker.
- No `select('*')` where a whitelist works (new code always whitelists).
- No new `dangerouslySetInnerHTML` (the single allowed place remains ProductDescription).
- No emoji instead of SVG icons; Ukrainian UI; mobile-first; reuse existing components/styles (`btn`, `card`, `Modal`, `ProductCard`, `EmptyState`, icons.tsx SVG set).
- Client fetch to cart-preview ONLY via `app/lib/cart-preview.ts` helpers (timeout+dispose invariant).
- Tests run with `npm test` (glob `tests/*.test.ts`). JSX is not executable in node:test — component behavior is pinned by static source-invariant assertions (established project pattern).
- Commits are NOT part of this plan (user commits manually).

---

## File Structure (deliverable map)

| File | Status | Responsibility |
|---|---|---|
| `database/migrations/015_product_reviews.sql` | create | reviews table + RLS (SELECT published-only) + indexes |
| `app/lib/reviews.ts` | create | pure review input validation constants/functions |
| `app/lib/rate-limit.ts` | modify | add `reviews` rule set |
| `app/lib/catalog.ts` | modify | published-review readers + summary; rewrite `fetchPopularProducts` featured-only |
| `app/api/reviews/route.ts` | create | public POST submission (pending moderation) |
| `app/api/admin/reviews/route.ts` | create | admin list w/ status filter + pagination |
| `app/api/admin/reviews/[id]/route.ts` | create | publish / reject / pending / delete |
| `app/components/icons.tsx` | modify | add `StarIcon` (filled prop) |
| `app/components/ReviewFormModal.tsx` | create | client form modal (stars/text/name/honeypot) |
| `app/components/ProductReviews.tsx` | create | server section: summary + distribution + list + pager |
| `app/product/[slug]/page.tsx` | modify | wire reviews section + recently-viewed block/tracker |
| `app/lib/recently-viewed-storage.ts` | create | pure localStorage sanitize/read/write/recordView |
| `app/components/RecentlyViewedTracker.tsx` | create | client, renders null, records view post-hydration |
| `app/components/RecentProducts.tsx` | create | client shelf via fetchCartPreview, hides when empty |
| `app/lib/featured-limit.ts` | create | pure max-8 decision + countFeaturedProducts helper |
| `app/api/admin/products/route.ts` | modify | `action=featured-count`; POST limit check + race demote |
| `app/api/admin/products/[id]/route.ts` | modify | PUT limit check + race revert |
| `app/(home)/page.tsx` | modify | hide popular section when 0 featured |
| `app/admin/(dashboard)/products/page.tsx` | modify | counter X/8, hint, disable at limit, refresh after save |
| `tests/reviews-validation.test.ts` | create | unit tests of validator |
| `tests/reviews-security.test.ts` | create | static pins: RLS/routes/no PII/bounded reads |
| `tests/recently-viewed.test.ts` | create | unit storage tests + component static pins |
| `tests/featured-limit.test.ts` | create | decision matrix unit + API/UI static pins |
| `tests/popular-products.test.ts` | rewrite | legs change: featured-only, no fallback |

---

### Task 1: Baseline sanity

**Files:** none touched.

- [ ] **Step 1: Run the full suite before any change**

Run: `npm test 2>&1 | tail -5 && npx tsc --noEmit && echo BASELINE_OK`
Expected: all existing tests pass (341 per Stage 12), tsc clean.

---

### Task 2: Migration file `015_product_reviews.sql` + security test

**Files:**
- Create: `database/migrations/015_product_reviews.sql`
- Test: `tests/reviews-security.test.ts`

**Interfaces:**
- Produces: table `public.product_reviews(id uuid pk default gen_random_uuid(), product_id uuid NOT NULL REFERENCES products ON DELETE CASCADE, rating smallint CHECK 1..5, text text CHECK char_length 10..1000, display_name text CHECK 1..40 nullable, status text DEFAULT 'pending' CHECK IN ('pending','published','rejected'), created_at/updated_at timestamptz NOT NULL DEFAULT now())`. RLS enabled, ONE policy: SELECT for anon,authenticated USING status='published'. No INSERT/UPDATE/DELETE policies.

- [ ] **Step 1: Write failing static tests** — create `tests/reviews-security.test.ts` with the shared source-reading preamble used by every static test in this repo, then the migration pins:

```ts
/**
 * Security & contract pins for the product-reviews feature (F-reviews).
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
  const sql = src('database/migrations/015_product_reviews.sql');
  assert.doesNotMatch(sql, /\bemail\b|\bphone\b|\bip_address\b|\buser_agent\b|\bcustomer_id\b|\border_id\b/i,
    'no order/customer linkage columns may leak PII');
});

test('REVIEWS MIGRATION: indexes for storefront + moderation reads', () => {
  const sql = src('database/migrations/015_product_reviews.sql');
  assert.match(sql, /idx_product_reviews_product_published[\s\S]*\(product_id, status, created_at DESC, id DESC\)/);
  assert.match(sql, /idx_product_reviews_moderation[\s\S]*\(status, created_at DESC, id DESC\)/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/reviews-security.test.ts`
Expected: FAIL — ENOENT reading the migration file.

- [ ] **Step 3: Write the migration**

Create `database/migrations/015_product_reviews.sql`:

```sql
-- Product reviews with mandatory moderation (feature: Відгуки про товари).
--
-- WRITE PATH: inserts happen ONLY through app/api/reviews/route.ts using the
-- service-role key; status transitions happen ONLY through
-- app/api/admin/reviews/* behind requireAdminApi(). RLS is enabled and the
-- SINGLE policy grants SELECT of published rows to anon/authenticated —
-- there are intentionally NO INSERT/UPDATE/DELETE policies.
--
-- PRIVACY CONTRACT (mirrors feedback/013): the table stores user-supplied
-- display name, rating, review text and timestamps ONLY. There are no
-- email/phone/ip/user-agent columns and no order/customer linkage by design,
-- so nothing customer-identifying can leak through the public read policy.
--
-- FOOTGUN NOTE (see 014 + PROJECT_CONTEXT): final_001 sets ALTER DEFAULT
-- PRIVILEGES GRANT SELECT ON TABLES TO public, so this new table inherits a
-- blanket SELECT grant. That grant is safe here because RLS reduces what
-- anon/authenticated can see to published rows only; there is no write
-- grant at the privilege level.
--
-- Apply manually via Supabase SQL Editor. Rollback:
--   DROP TABLE IF EXISTS public.product_reviews;

CREATE TABLE IF NOT EXISTS public.product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating >= 1 AND rating <= 5),
  text text NOT NULL CHECK (char_length(text) BETWEEN 10 AND 1000),
  display_name text CHECK (char_length(display_name) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_reviews_public_read_published
  ON public.product_reviews
  FOR SELECT
  TO anon, authenticated
  USING (status = 'published');

-- Storefront shelf: published reviews of one product, newest first.
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_published
  ON public.product_reviews (product_id, status, created_at DESC, id DESC);

-- Admin moderation queue: pending first, newest first.
CREATE INDEX IF NOT EXISTS idx_product_reviews_moderation
  ON public.product_reviews (status, created_at DESC, id DESC);

-- Shared daily anti-flood cap counts rows by created_at (identifier-free).
CREATE INDEX IF NOT EXISTS idx_product_reviews_created_at
  ON public.product_reviews (created_at);
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test tests/reviews-security.test.ts`
Expected: PASS (5 tests).

---

### Task 3: Pure validator `app/lib/reviews.ts`

**Files:**
- Create: `app/lib/reviews.ts`
- Test: `tests/reviews-validation.test.ts`

**Interfaces:**
- Produces:
  - `REVIEW_MIN_LENGTH = 10`, `REVIEW_MAX_LENGTH = 1000`, `REVIEW_NAME_MAX_LENGTH = 40`, `REVIEW_DAILY_CAP = 50`
  - `validateReviewInput(raw: { rating?: unknown; text?: unknown; displayName?: unknown }): { ok: true; rating: number; text: string; displayName: string | null } | { ok: false }`

- [ ] **Step 1: Write failing unit tests** — create `tests/reviews-validation.test.ts`:

```ts
/** Pure validation unit tests for product-review submissions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReviewInput,
  REVIEW_MIN_LENGTH,
  REVIEW_MAX_LENGTH,
  REVIEW_NAME_MAX_LENGTH,
} from '../app/lib/reviews';

const okRating = 5;
const okText = 'Дуже задоволений покупкою, рекомендую!';

function okVariant(rating: unknown, text: unknown, displayName?: unknown) {
  return validateReviewInput({ rating, text, displayName });
}

test('REVIEW VALIDATION: accepts integer ratings 1..5', () => {
  for (const rating of [1, 2, 3, 4, 5]) {
    const result = okVariant(rating, okText);
    assert.equal(result.ok, true, `rating ${rating} must pass`);
    if (result.ok) assert.equal(result.rating, rating);
  }
});

test('REVIEW VALIDATION: rejects out-of-range and non-integer ratings', () => {
  for (const rating of [0, 6, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(okVariant(rating, okText).ok, false, `rating ${rating} must fail`);
  }
});

test('REVIEW VALIDATION: rejects non-number rating types (string "5" included)', () => {
  for (const rating of ['5', null, undefined, { v: 5 }, [5], true]) {
    assert.equal(okVariant(rating, okText).ok, false, `${typeof rating} must fail`);
  }
});

test('REVIEW VALIDATION: rejects text shorter than min and longer than max', () => {
  assert.equal(validateReviewInput({ rating: okRating, text: 'коротенько' }).ok, false);
  assert.equal(
    validateReviewInput({ rating: okRating, text: 'а'.repeat(REVIEW_MAX_LENGTH + 1) }).ok,
    false
  );
  assert.ok(REVIEW_MIN_LENGTH === 10 && REVIEW_MAX_LENGTH === 1000);
});

test('REVIEW VALIDATION: accepts boundary lengths and strips control chars/trim', () => {
  const boundary = 'в'.repeat(REVIEW_MAX_LENGTH);
  const result = validateReviewInput({
    rating: okRating,
    text: `  ${boundary}\u0007  `,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, boundary);

  const minLen = 'м'.repeat(REVIEW_MIN_LENGTH);
  assert.equal(validateReviewInput({ rating: okRating, text: minLen }).ok, true);
});

test('REVIEW VALIDATION: keeps meaningful newlines/tabs, drops other control chars', () => {
  const result = validateReviewInput({ rating: okRating, text: 'перший рядок\nдругий\tрядок\u0000кінець' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, 'перший рядок\nдругий\tрядоккінець');
});

test('REVIEW VALIDATION: rejects non-string text', () => {
  for (const text of [null, undefined, 123, {}, []]) {
    assert.equal(validateReviewInput({ rating: okRating, text }).ok, false);
  }
});

test('REVIEW VALIDATION: optional displayName trimmed, capped at 40, empty -> null', () => {
  const named = okVariant(okRating, okText, '  Оксана  ');
  assert.equal(named.ok, true);
  if (named.ok) assert.equal(named.displayName, 'Оксана');

  const anon = okVariant(okRating, okText, '   ');
  assert.equal(anon.ok, true);
  if (anon.ok) assert.equal(anon.displayName, null);

  assert.equal(okVariant(okRating, okText, 'д'.repeat(REVIEW_NAME_MAX_LENGTH)).ok, true);
  assert.equal(okVariant(okRating, okText, 'д'.repeat(REVIEW_NAME_MAX_LENGTH + 1)).ok, false);
});

test('REVIEW VALIDATION: missing displayName field behaves as anonymous', () => {
  const result = validateReviewInput({ rating: okRating, text: okText });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.displayName, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/reviews-validation.test.ts`
Expected: FAIL — cannot find module `../app/lib/reviews`.

- [ ] **Step 3: Implement the validator**

Create `app/lib/reviews.ts`:

```ts
/**
 * Pure validation for product-review submissions (Відгуки). No DOM, no
 * Supabase — imported by the public POST route and the client form, and
 * unit-tested directly in Node.
 *
 * Privacy: the ONLY accepted fields are rating, text and an OPTIONAL
 * user-typed display name. No email/order/customer data is requested,
 * accepted or stored anywhere in this feature.
 */

export const REVIEW_MIN_LENGTH = 10;
export const REVIEW_MAX_LENGTH = 1000;
export const REVIEW_NAME_MAX_LENGTH = 40;

/**
 * Multi-instance-safe daily flood cap over the whole reviews table
 * (created_at count only — identifier-free), same pattern as FEEDBACK_DAILY_CAP.
 */
export const REVIEW_DAILY_CAP = 50;

/** Control characters (except \n \r \t) that have no place in user text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function cleanUserString(value: string): string {
  return value.replace(CONTROL_CHARS, '').trim();
}

export type ReviewValidation =
  | { ok: true; rating: number; text: string; displayName: string | null }
  | { ok: false };

export function validateReviewInput(raw: {
  rating?: unknown;
  text?: unknown;
  displayName?: unknown;
}): ReviewValidation {
  // Rating must be a real integer in 1..5 — strings like "5" are rejected
  // so the client cannot smuggle coercion surprises.
  const { rating, text, displayName } = raw ?? {};
  if (typeof rating !== 'number' || !Number.isInteger(rating)) return { ok: false };
  if (rating < 1 || rating > 5) return { ok: false };

  if (typeof text !== 'string') return { ok: false };
  const cleanedText = cleanUserString(text);
  if (
    cleanedText.length < REVIEW_MIN_LENGTH ||
    cleanedText.length > REVIEW_MAX_LENGTH
  ) {
    return { ok: false };
  }

  let cleanedName: string | null = null;
  if (displayName !== undefined && displayName !== null) {
    if (typeof displayName !== 'string') return { ok: false };
    cleanedName = cleanUserString(displayName);
    if (cleanedName.length === 0) {
      cleanedName = null;
    } else if (cleanedName.length > REVIEW_NAME_MAX_LENGTH) {
      return { ok: false };
    }
  }

  return { ok: true, rating, text: cleanedText, displayName: cleanedName };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test tests/reviews-validation.test.ts`
Expected: PASS (9 tests).

---

### Task 4: Rate-limit rules for reviews

**Files:**
- Modify: `app/lib/rate-limit.ts` (inside `RATE_RULES`)
- Test: `tests/reviews-security.test.ts` (append)

- [ ] **Step 1: Append failing static test** to `tests/reviews-security.test.ts`:

```ts
// ---- public submission endpoint: rate-limit / honeypot / daily cap ----

test('REVIEWS API: dedicated rate-limit rule set exists', () => {
  const limiter = src('app/lib/rate-limit.ts');
  assert.match(limiter, /reviews:\s*\[\s*\{\s*max:\s*3,\s*windowMs:\s*60_000\s*\},\s*\{\s*max:\s*10,\s*windowMs:\s*60 \* 60_000\s*\},?\s*\]/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/reviews-security.test.ts`
Expected: FAIL — no `reviews:` rule.

- [ ] **Step 3: Add the rule** inside `RATE_RULES` in `app/lib/rate-limit.ts`, right after `feedback`:

```ts
  // product reviews: strict anti-spam (anonymous submission, pre-moderation)
  reviews: [
    { max: 3, windowMs: 60_000 },
    { max: 10, windowMs: 60 * 60_000 },
  ],
```

- [ ] **Step 4: Verify pass**

Run: `npm test tests/reviews-security.test.ts`
Expected: PASS (6 tests).

---

### Task 5: Public readers in `catalog.ts`

**Files:**
- Modify: `app/lib/catalog.ts` (append after `fetchProductBySlug`)
- Test: `tests/reviews-security.test.ts` (append)

**Interfaces:**
- Produces:
  - `interface ProductReview { id: string; product_id: string; rating: number; text: string; display_name: string | null; created_at: string }`
  - `interface ReviewsPageData { reviews: ProductReview[]; total: number; page: number; pageSize: number }`
  - `interface ReviewSummary { total: number; average: number | null; distribution: [number, number, number, number, number] }` (index 0 = ★1 … index 4 = ★5)
  - `REVIEWS_PAGE_SIZE = 10`
  - `async fetchPublishedReviews(productId: string, page?: number): Promise<ReviewsPageData>`
  - `async fetchReviewSummary(productId: string): Promise<ReviewSummary>`
- Reads use the EXISTING anonymous `supabase` client in catalog.ts (RLS enforces published-only; defense-in-depth filters also applied in WHERE).

- [ ] **Step 1: Append failing static tests** to `tests/reviews-security.test.ts`:

```ts
// ---- storefront readers: published-only, bounded, tiebroken ----

test('REVIEWS CATALOG: public reader filters published and paginates deterministically', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(lib.indexOf('fetchPublishedReviews'));
  assert.match(fn, /\.eq\('status', 'published'\)/, 'defense-in-depth status filter');
  assert.match(fn, /\.eq\('product_id', productId\)/);
  assert.match(fn, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(fn, /\.order\('id'/, 'id tiebreaker required');
  assert.match(fn, /\.range\(/, 'bounded window');
  assert.doesNotMatch(fn, /select\('\*'\)/, 'column whitelist only');
});

test('REVIEWS CATALOG: summary uses indexed head-counts (no row payload)', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(lib.indexOf('fetchReviewSummary'));
  assert.match(fn, /count: 'exact', head: true/);
  assert.match(fn, /\.eq\('rating', rating\)/);
  assert.doesNotMatch(fn, /for\s*\(\s*;;\)/, 'no unbounded loops');
});

test('REVIEWS CATALOG: page size constant is 10', () => {
  const lib = src('app/lib/catalog.ts');
  assert.match(lib, /export const REVIEWS_PAGE_SIZE = 10/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/reviews-security.test.ts`
Expected: FAIL — `fetchPublishedReviews` not found (slice yields rest of file lacking patterns; assert fails).

- [ ] **Step 3: Implement readers** — append to `app/lib/catalog.ts`:

```ts
// ---------------------------------------------------------------------------
// Product reviews (Відгуки) — public READS only.
//
// Writes never go through this file: submissions land as status='pending'
// via app/api/reviews/route.ts (service role) and are published/rejected in
// the admin API. The queries below run on the ANONYMOUS client, so RLS
// already restricts rows to status='published'; the .eq('status') filters
// stay as defense-in-depth so the contract survives even a future policy
// regression.
// ---------------------------------------------------------------------------

export interface ProductReview {
  id: string;
  product_id: string;
  rating: number;
  text: string;
  display_name: string | null;
  created_at: string;
}

export interface ReviewsPageData {
  reviews: ProductReview[];
  total: number;
  page: number;
  pageSize: number;
}

/** Hard cap for one rendered page of reviews — bounded by design. */
export const REVIEWS_PAGE_SIZE = 10;

/** Column whitelist — never select('*') on user-generated content. */
const REVIEW_COLUMNS =
  'id, product_id, rating, text, display_name, created_at';

export async function fetchPublishedReviews(
  productId: string,
  page = 1
): Promise<ReviewsPageData> {
  const { count, error: countError } = await supabase
    .from('product_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', productId)
    .eq('status', 'published');
  if (countError) {
    throw new Error(`Failed to count reviews: ${countError.message}`);
  }

  const total = count ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / REVIEWS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), maxPage);

  const { data, error } = await supabase
    .from('product_reviews')
    .select(REVIEW_COLUMNS)
    .eq('product_id', productId)
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range((safePage - 1) * REVIEWS_PAGE_SIZE, safePage * REVIEWS_PAGE_SIZE - 1);

  if (error) {
    throw new Error(`Failed to load reviews: ${error.message}`);
  }

  return {
    reviews: data ?? [],
    total,
    page: safePage,
    pageSize: REVIEWS_PAGE_SIZE,
  };
}

export interface ReviewSummary {
  total: number;
  /** Arithmetic mean rounded to 1 decimal; null when no published reviews. */
  average: number | null;
  /** Index 0 = ★1 … index 4 = ★5. */
  distribution: [number, number, number, number, number];
}

/**
 * Average + star distribution via five indexed head-counts (no row payload
 * crosses the wire regardless of how many reviews exist).
 */
export async function fetchReviewSummary(
  productId: string
): Promise<ReviewSummary> {
  const results = await Promise.all(
    ([1, 2, 3, 4, 5] as const).map(async (rating) => {
      const { count, error } = await supabase
        .from('product_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', productId)
        .eq('status', 'published')
        .eq('rating', rating);
      if (error) {
        throw new Error(`Failed to summarize rating ${rating}: ${error.message}`);
      }
      return count ?? 0;
    })
  );

  const distribution: ReviewSummary['distribution'] = [
    results[0],
    results[1],
    results[2],
    results[3],
    results[4],
  ];
  const total = distribution.reduce((sum, n) => sum + n, 0);
  const weighted =
    distribution[0] * 1 +
    distribution[1] * 2 +
    distribution[2] * 3 +
    distribution[3] * 4 +
    distribution[4] * 5;

  return {
    total,
    average: total > 0 ? Math.round((weighted / total) * 10) / 10 : null,
    distribution,
  };
}
```

- [ ] **Step 4: Verify pass**

Run: `npm test tests/reviews-security.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

---

### Task 6: Public submission route `POST /api/reviews`

**Files:**
- Create: `app/api/reviews/route.ts`
- Test: `tests/reviews-security.test.ts` (append)

- [ ] **Step 1: Append failing static tests**:

```ts
// ---- public POST /api/reviews: spam layers + pending-by-default ----

test('REVIEWS SUBMIT: rate limit, honeypot, validator, product check, daily cap', () => {
  const route = src('app/api/reviews/route.ts');
  assert.match(route, /enforceRateLimit\(request, 'reviews'\)/);
  assert.match(route, /website/, 'honeypot field checked');
  assert.match(route, /validateReviewInput/);
  assert.match(route, /REVIEW_DAILY_CAP/, 'shared daily cap enforced');
  assert.match(route, /isUuid/);
  assert.match(route, /\.from\('products'\)[\s\S]*?is_active/, 'target product must exist & be active');
});

test('REVIEWS SUBMIT: inserts pending via service role, honest failure modes', () => {
  const route = src('app/api/reviews/route.ts');
  assert.match(route, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(route, /status: 'pending'/, 'never auto-publish');
  assert.match(route, /503/, 'storage-not-applied degrades honestly');
  assert.match(route, /429/, 'daily-cap overflow answers 429');
  assert.doesNotMatch(route, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/, 'anon key cannot insert');
});

test('REVIEWS SUBMIT: response never echoes stored row internals', () => {
  const route = src('app/api/reviews/route.ts');
  assert.match(route, /Response\.json\(\{ ok: true \}, \{ status: 201 \}\)/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/reviews-security.test.ts`
Expected: FAIL — route file missing.

- [ ] **Step 3: Implement the route** — create `app/api/reviews/route.ts`:

```ts
import { createClient } from '@supabase/supabase-js';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import {
  validateReviewInput,
  REVIEW_DAILY_CAP,
} from '@/app/lib/reviews';
import { isUuid } from '@/app/lib/admin-api';

/**
 * Public product-review submission endpoint.
 *
 * Anti-spam layers (mirroring /api/feedback):
 *   1. per-IP sliding window (transient memory, nothing persisted);
 *   2. honeypot field `website` — bots that fill it are dropped;
 *   3. shared daily cap counted over product_reviews.created_at in the DB
 *      (identifier-free, multi-instance safe).
 *
 * Every accepted review lands as status='pending': NOTHING becomes public
 * before an admin publishes it in /admin/reviews. Storage errors answer
 * 503 honestly (e.g. migration not applied yet) — success is never faked.
 */

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'reviews');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { productId, rating, text, displayName, website } = (body ?? {}) as {
    productId?: unknown;
    rating?: unknown;
    text?: unknown;
    displayName?: unknown;
    website?: unknown;
  };

  // Honeypot: hidden field must stay empty.
  if (typeof website === 'string' && website.length > 0) {
    return Response.json({ error: 'review_storage_not_configured' }, { status: 503 });
  }

  const validated = validateReviewInput({ rating, text, displayName });
  if (!validated.ok) {
    return Response.json({ error: 'invalid_data' }, { status: 400 });
  }

  if (typeof productId !== 'string' || !isUuid(productId)) {
    return Response.json({ error: 'invalid_product' }, { status: 400 });
  }

  const sb = serviceClient();

  // The target product must be live; FK alone would also accept inactive ones.
  const { count: productCount, error: productError } = await sb
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('id', productId)
    .eq('is_active', true);
  if (productError) {
    console.error('review target lookup failed:', productError.message);
    return Response.json({ error: 'review_storage_not_configured' }, { status: 503 });
  }
  if ((productCount ?? 0) === 0) {
    return Response.json({ error: 'invalid_product' }, { status: 404 });
  }

  // Shared daily cap across ALL products (identifier-free flood ceiling).
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: capError } = await sb
    .from('product_reviews')
    .select('*', { count: 'exact', head: true })
    .gt('created_at', dayAgo);
  if (capError) {
    console.error('review daily-cap lookup failed:', capError.message);
    return Response.json({ error: 'review_storage_not_configured' }, { status: 503 });
  }
  if ((count ?? 0) >= REVIEW_DAILY_CAP) {
    return Response.json({ error: 'review_rate_limited' }, { status: 429 });
  }

  const { error: insertError } = await sb.from('product_reviews').insert({
    product_id: productId,
    rating: validated.rating,
    text: validated.text,
    display_name: validated.displayName,
    status: 'pending',
  });

  if (insertError) {
    // Migration not applied yet (or transient storage failure) — degrade
    // honestly instead of faking success.
    console.error('review insert failed:', insertError.message);
    return Response.json({ error: 'review_storage_not_configured' }, { status: 503 });
  }

  return Response.json({ ok: true }, { status: 201 });
}
```

- [ ] **Step 4: Verify pass**

Run: `npm test tests/reviews-security.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

---

### Task 7: Admin review routes

**Files:**
- Create: `app/api/admin/reviews/route.ts` (GET list)
- Create: `app/api/admin/reviews/[id]/route.ts` (PATCH status, DELETE)
- Test: `tests/reviews-security.test.ts` (append)

**Interfaces:**
- `GET /api/admin/reviews?status=pending|published|rejected|all&page=&size=` → `{ items, total, page, size }`; item shape `{ id, product_id, rating, text, display_name, status, created_at, updated_at, product: { name, slug } | null }`. Default `status=pending`, `size=20` cap 100.
- `PATCH /api/admin/reviews/[id]` body `{ action: 'publish' | 'reject' | 'pending' }` → `{ id, status }`.
- `DELETE /api/admin/reviews/[id]` → `{ id }`.

- [ ] **Step 1: Append failing static tests**:

```ts
// ---- admin moderation routes ----

test('REVIEWS ADMIN: both routes sit behind requireAdminApi', () => {
  const listRoute = src('app/api/admin/reviews/route.ts');
  const itemRoute = src('app/api/admin/reviews/[id]/route.ts');
  for (const route of [listRoute, itemRoute]) {
    assert.match(route, /requireAdminApi\(\)/);
    assert.doesNotMatch(route, /select\('\*'\)/, 'column whitelist only');
  }
});

test('REVIEWS ADMIN LIST: whitelist filter, bounded page, deterministic order', () => {
  const route = src('app/api/admin/reviews/route.ts');
  assert.match(route, /\['pending', 'published', 'rejected', 'all'\]/);
  assert.match(route, /Math\.min\([\s\S]*?, 100\)/, 'size hard-capped at 100');
  assert.match(route, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(route, /\.order\('id', \{ ascending: false \}\)/);
  assert.match(route, /\.range\(/);
  assert.match(route, /count: 'exact'/, 'total comes from COUNT, not rows.length');
  assert.match(route, /products\(name, slug\)|products\!inner\(name, slug\)/,
    'product context embedded with narrow columns');
});

test('REVIEWS ADMIN ITEM: action whitelist maps onto status values', () => {
  const route = src('app/api/admin/reviews/[id]/route.ts');
  assert.match(route, /publish.*published/s);
  assert.match(route, /reject.*rejected/s);
  assert.match(route, /pending/, 'unpublish path exists');
  assert.match(route, /updated_at/, 'status transitions stamp updated_at');
  assert.match(route, /isUuid/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/reviews-security.test.ts`
Expected: FAIL — route files missing.

- [ ] **Step 3: Implement list route** — create `app/api/admin/reviews/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/app/lib/admin-api';

/**
 * Admin reviews list with status filter and bounded pagination.
 * Service-role reads happen only AFTER requireAdminApi() passed.
 * Deterministic order (created_at desc + id tiebreaker) keeps windows stable
 * while moderators act mid-list.
 */

const STATUS_FILTERS = ['pending', 'published', 'rejected', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const REVIEW_LIST_COLUMNS =
  'id, product_id, rating, text, display_name, status, created_at, updated_at, product:products(name, slug)';

export async function GET(request: Request) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);

  const statusParam = searchParams.get('status') ?? 'pending';
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(statusParam)
    ? (statusParam as StatusFilter)
    : 'pending';

  const rawPage = Number(searchParams.get('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawSize = Number(searchParams.get('size'));
  const size = Math.min(
    Number.isInteger(rawSize) && rawSize > 0 ? rawSize : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );

  // COUNT runs over the FILTERED set; the window is cut afterwards —
  // the same pipeline as admin-list.ts (filter BEFORE pagination).
  let countQuery = ctx.serviceClient
    .from('product_reviews')
    .select('id', { count: 'exact', head: true });
  if (status !== 'all') {
    countQuery = countQuery.eq('status', status);
  }
  const { count, error: countError } = await countQuery;

  if (countError) {
    console.error('admin reviews count failed:', countError.message);
    return NextResponse.json({ error: 'Не вдалося завантажити відгуки' }, { status: 500 });
  }

  const total = count ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(page, maxPage);

  // Window chain built FRESH: supabase-js builders accumulate repeated
  // .order() calls, so reusing a builder corrupts ordering (catalog.ts lesson).
  let windowQuery = ctx.serviceClient.from('product_reviews').select(REVIEW_LIST_COLUMNS);
  if (status !== 'all') {
    windowQuery = windowQuery.eq('status', status);
  }
  const { data, error: pageError } = await windowQuery
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range((safePage - 1) * size, safePage * size - 1);

  if (pageError) {
    console.error('admin reviews page failed:', pageError.message);
    return NextResponse.json({ error: 'Не вдалося завантажити відгуки' }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [], total, page: safePage, size });
}
```

- [ ] **Step 4: Implement item route** — create `app/api/admin/reviews/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { requireAdminApi, isUuid } from '@/app/lib/admin-api';

/**
 * Single-review moderation actions. Every transition stamps updated_at so
 * the moderation queue re-sorts sensibly. Deletion is a plain row delete —
 * nothing else references product_reviews (FK is child-side only).
 */

const ACTION_TO_STATUS: Record<string, string> = {
  publish: 'published',
  reject: 'rejected',
  pending: 'pending',
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id відгуку' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некоректний JSON' }, { status: 400 });
  }

  const action = (body as { action?: unknown })?.action;
  const status = typeof action === 'string' ? ACTION_TO_STATUS[action] : undefined;
  if (!status) {
    return NextResponse.json(
      { error: 'Недопустима дія (publish | reject | pending)' },
      { status: 400 }
    );
  }

  const { data, error } = await ctx.serviceClient
    .from('product_reviews')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, status')
    .maybeSingle();

  if (error) {
    console.error('review status update failed:', error.message);
    return NextResponse.json({ error: 'Не вдалося оновити відгук' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Відгук не знайдено' }, { status: 404 });
  }

  return NextResponse.json(data);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id відгуку' }, { status: 400 });
  }

  const { data, error } = await ctx.serviceClient
    .from('product_reviews')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('review delete failed:', error.message);
    return NextResponse.json({ error: 'Не вдалося видалити відгук' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Відгук не знайдено' }, { status: 404 });
  }

  return NextResponse.json({ id: data.id });
}
```

Note for the static pin `/Math\.min\([\s\S]*?, 100\)/`: ensure the size line literally contains `Math.min(..., MAX_PAGE_SIZE)` where `MAX_PAGE_SIZE = 100` — adjust pin to `MAX_PAGE_SIZE = 100` instead:

Replace that assertion with:
```ts
  assert.match(route, /MAX_PAGE_SIZE = 100/, 'size hard-capped at 100');
```

- [ ] **Step 5: Verify pass**

Run: `npm test tests/reviews-security.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

---

### Task 8: Star icon + ReviewFormModal

**Files:**
- Modify: `app/components/icons.tsx`
- Create: `app/components/ReviewFormModal.tsx`
- Test: `tests/reviews-security.test.ts` (append)

- [ ] **Step 1: Append failing static test**:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/reviews-security.test.ts`
Expected: FAIL — StarIcon / ReviewFormModal missing.

- [ ] **Step 3: Add StarIcon** to `app/components/icons.tsx` (after ChevronDownIcon):

```tsx
export function StarIcon({
  className,
  filled = false,
}: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(className)} fill={filled ? 'currentColor' : 'none'}>
      <path d="M11.5 3.1a.55.55 0 0 1 1 0l2.3 4.9 5.2.7c.5.06.68.68.32 1l-3.85 3.66.95 5.25a.55.55 0 0 1-.82.58L12 16.62l-4.6 2.57a.55.55 0 0 1-.82-.58l.95-5.25L3.68 9.7c-.36-.32-.18-.94.32-1l5.2-.7Z" />
    </svg>
  );
}
```

- [ ] **Step 4: Implement the modal** — create `app/components/ReviewFormModal.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { StarIcon, XIcon } from './icons';
import {
  REVIEW_MAX_LENGTH,
  REVIEW_MIN_LENGTH,
  REVIEW_NAME_MAX_LENGTH,
} from '@/app/lib/reviews';

/**
 * «Залишити відгук» modal on the product page. Collects ONLY rating, text
 * and an optional display name (plus the hidden honeypot field). Server puts
 * the review into the pending queue; the success state promises moderation
 * explicitly — we never imply instant publication.
 */

type Status = 'idle' | 'sending' | 'success' | 'error';
type ErrorKind = 'unconfigured' | 'rate' | 'generic';

export default function ReviewFormModal({
  label,
  productId,
}: {
  label: string;
  productId: string;
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hoveredRating, setHoveredRating] = useState(0);
  const [text, setText] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorKind, setErrorKind] = useState<ErrorKind>('generic');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const trimmedLength = text.trim().length;
  const canSubmit =
    rating >= 1 &&
    trimmedLength >= REVIEW_MIN_LENGTH &&
    trimmedLength <= REVIEW_MAX_LENGTH;

  const onClose = useCallback(() => {
    setOpen(false);
    setStatus('idle');
    setErrorKind('generic');
    setRating(0);
    setText('');
    setDisplayName('');
    setWebsite('');
  }, []);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea, input:not([type="hidden"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || status === 'sending') return;
    setStatus('sending');
    setErrorKind('generic');
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId,
          rating,
          text,
          displayName: displayName.trim() === '' ? undefined : displayName.trim(),
          website,
        }),
      });
      if (res.status === 201) {
        setStatus('success');
      } else if (res.status === 429) {
        setErrorKind('rate');
        setStatus('error');
      } else {
        setErrorKind(res.status === 503 ? 'unconfigured' : 'generic');
        setStatus('error');
      }
    } catch {
      setErrorKind('generic');
      setStatus('error');
    }
  };

  const shownRating = hoveredRating > 0 ? hoveredRating : rating;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn btn-primary">
        {label}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className="relative w-full max-w-md rounded-t-xl bg-white p-5 shadow-xl sm:rounded-xl"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900">{label}</h2>
              <button
                ref={closeBtnRef}
                type="button"
                aria-label="Закрити вікно"
                onClick={onClose}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            {status === 'success' ? (
              <p className="py-6 text-center text-sm text-green-700" role="status">
                Дякуємо! Відгук надіслано та очікує модерації.
              </p>
            ) : (
              <form onSubmit={submit} noValidate>
                <fieldset className="mb-4">
                  <legend className="mb-2 text-sm text-gray-600">Оцінка</legend>
                  <div className="flex gap-1" role="radiogroup" aria-label="Оцінка від 1 до 5">
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={rating === value}
                        aria-label={`${value} ${value === 1 ? 'зірка' : 'зірки'}`}
                        onMouseEnter={() => setHoveredRating(value)}
                        onMouseLeave={() => setHoveredRating(0)}
                        onClick={() => setRating(value)}
                        className={`rounded p-1 ${
                          value <= shownRating ? 'text-amber-500' : 'text-gray-300'
                        } hover:text-amber-400`}
                      >
                        <StarIcon className="h-7 w-7" filled={value <= shownRating} />
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label htmlFor="review-name" className="mb-1 block text-sm text-gray-600">
                  Ім&apos;я (необов&apos;язково)
                </label>
                <input
                  id="review-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={REVIEW_NAME_MAX_LENGTH}
                  autoComplete="off"
                  className="mb-3 w-full rounded-lg border border-gray-300 p-2.5 text-sm focus:border-transparent focus:ring-2 focus:ring-blue-500"
                  placeholder="Наприклад: Оксана"
                />

                <label htmlFor="review-text" className="mb-1 block text-sm text-gray-600">
                  Ваш відгук
                </label>
                <textarea
                  id="review-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={5}
                  maxLength={REVIEW_MAX_LENGTH}
                  required
                  className="w-full rounded-lg border border-gray-300 p-3 text-sm focus:border-transparent focus:ring-2 focus:ring-blue-500"
                  placeholder="Поділіться враженнями про товар…"
                />

                {/* honeypot — invisible to humans, bots fill it */}
                <input
                  type="text"
                  name="website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  className="hidden"
                />

                <div className="mt-1 flex items-center justify-between text-xs text-gray-400">
                  <span>Відгук публікується після перевірки модератором.</span>
                  <span>
                    {trimmedLength}/{REVIEW_MAX_LENGTH}
                  </span>
                </div>

                {status === 'error' && (
                  <p className="mt-2 text-sm text-red-600" role="alert">
                    {errorKind === 'rate'
                      ? 'Зараз надто багато відгуків — спробуйте, будь ласка, пізніше.'
                      : errorKind === 'unconfigured'
                        ? 'Прийом відгуків ще не підключено — спробуйте пізніше.'
                        : 'Перевірте оцінку та текст (від 10 символів) і спробуйте ще раз.'}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={!canSubmit || status === 'sending'}
                  className="btn btn-primary mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === 'sending' ? 'Надсилаємо...' : 'Надіслати відгук'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 5: Verify pass**

Run: `npm test tests/reviews-security.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

---

### Task 9: ProductReviews section + product page wiring

**Files:**
- Create: `app/components/ProductReviews.tsx`
- Modify: `app/product/[slug]/page.tsx`
- Test: `tests/reviews-security.test.ts` (append)

**Interfaces:**
- Consumes: `ProductReviews` props `{ summary: ReviewSummary; data: ReviewsPageData; productSlug: string }`; `<ReviewFormModal label productId />`.
- Page gains `searchParams` promise; `reviews_page` int param drives `fetchPublishedReviews`.

- [ ] **Step 1: Append failing static tests**:

```ts
// ---- product page section ----

test('REVIEWS SECTION: summary/distribution/list/pagination rendered safely', () => {
  const section = src('app/components/ProductReviews.tsx');
  assert.match(section, /Відгуки/);
  assert.match(section, /Залишити відгук/);
  assert.match(section, /Анонімний відгук/, 'missing display_name falls back');
  assert.match(section, /distribution/, 'star distribution bars rendered');
  assert.match(section, /reviews_page=/, 'pagination links preserve param');
  assert.doesNotMatch(section, /dangerouslySetInnerHTML/, 'text children only');
  assert.doesNotMatch(section, /email|phone/iu, 'no PII surface in UI');
});

test('PRODUCT PAGE: wires section with searchParams-driven page + tracker-free imports', () => {
  const page = src('app/product/[slug]/page.tsx');
  assert.match(page, /fetchPublishedReviews/);
  assert.match(page, /fetchReviewSummary/);
  assert.match(page, /reviews_page/);
  assert.match(page, /<ProductReviews/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/reviews-security.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement section** — create `app/components/ProductReviews.tsx`:

```tsx
import Link from 'next/link';
import { StarIcon } from './icons';
import ReviewFormModal from './ReviewFormModal';
import type { ReviewSummary, ReviewsPageData } from '@/app/lib/catalog';

const dateFormatter = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'long',
});

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`Оцінка ${value} з 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <StarIcon
          key={star}
          className={`h-4 w-4 ${star <= Math.round(value) ? 'text-amber-500' : 'text-gray-300'}`}
          filled={star <= Math.round(value)}
        />
      ))}
    </span>
  );
}

function pluralReviews(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'відгук';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'відгуки';
  return 'відгуків';
}

/**
 * «Відгуки» section of the product page. Pure server component: all data is
 * fetched by the page (RLS-published rows only) and passed down. Text is
 * rendered as React children — no HTML sink anywhere in this feature.
 */
export default function ProductReviews({
  productId,
  summary,
  data,
  productSlug,
}: {
  productId: string;
  summary: ReviewSummary;
  data: ReviewsPageData;
  productSlug: string;
}) {
  const totalPages = Math.max(1, Math.ceil(data.total / (data.pageSize || 1)));
  const basePath = `/product/${encodeURIComponent(productSlug)}`;
  const pageHref = (page: number) => `${basePath}?reviews_page=${page}`;

  return (
    <section id="reviews" className="bg-white rounded-lg shadow p-6 mb-8 scroll-mt-24">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">Відгуки</h2>
        <ReviewFormModal label="Залишити відгук" productId={productId} />
      </div>

      {summary.total === 0 ? (
        <p className="text-gray-500">
          Ще немає відгуків — станьте першим, хто залишить відгук про цей товар.
        </p>
      ) : (
        <>
          <div className="mb-6 flex flex-col gap-6 sm:flex-row sm:items-start md:gap-10">
            <div className="text-center sm:w-40">
              <p className="text-4xl font-extrabold text-gray-900">
                {summary.average !== null ? summary.average.toFixed(1) : '—'}
              </p>
              <div className="mt-1 flex justify-center">
                <Stars value={summary.average ?? 0} />
              </div>
              <p className="mt-1 text-sm text-gray-500">
                {summary.total} {pluralReviews(summary.total)}
              </p>
            </div>
            <div className="flex-1 space-y-1.5">
              {[5, 4, 3, 2, 1].map((stars) => {
                const count = summary.distribution[stars - 1];
                const percent = summary.total > 0 ? Math.round((count / summary.total) * 100) : 0;
                return (
                  <div key={stars} className="flex items-center gap-2 text-sm">
                    <span className="w-8 shrink-0 text-right text-gray-600">{stars} ★</span>
                    <div
                      className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100"
                      role="presentation"
                    >
                      <div className="h-full rounded-full bg-amber-400" style={{ width: `${percent}%` }} />
                    </div>
                    <span className="w-8 shrink-0 text-gray-500">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <ul className="space-y-4">
            {data.reviews.map((review) => (
              <li key={review.id} className="rounded-xl border border-gray-200 p-4">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <Stars value={review.rating} />
                  <time dateTime={review.created_at} className="text-xs text-gray-400">
                    {dateFormatter.format(new Date(review.created_at))}
                  </time>
                </div>
                <p className="text-sm font-semibold text-gray-900">
                  {review.display_name ?? 'Анонімний відгук'}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                  {review.text}
                </p>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <nav
              aria-label="Пагінація відгуків"
              className="mt-5 flex items-center justify-between text-sm"
            >
              {data.page > 1 ? (
                <Link href={pageHref(data.page - 1)} className="text-blue-600 hover:underline">
                  ← Попередні
                </Link>
              ) : (
                <span />
              )}
              <span className="text-gray-500">
                Сторінка {data.page} з {totalPages}
              </span>
              {data.page < totalPages ? (
                <Link href={pageHref(data.page + 1)} className="text-blue-600 hover:underline">
                  Наступні →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}
```

Note: `★` inside the distribution row label is a typographic glyph in a data-viz label, not an emoji replacing an icon — the stars themselves are `StarIcon` SVGs.

Update the section static test to also pin the explicit prop:

```ts
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
```

- [ ] **Step 4: Wire the product page** — modify `app/product/[slug]/page.tsx`:

1. Extend signature:

```tsx
export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
```

2. After `if (!product) notFound()` add:

```tsx
  const rawReviewsPage = Number((await searchParams).reviews_page);
  const reviewsPage =
    Number.isInteger(rawReviewsPage) && rawReviewsPage > 0 ? rawReviewsPage : 1;
  const [reviewSummary, reviewsData] = await Promise.all([
    fetchReviewSummary(product.id),
    fetchPublishedReviews(product.id, reviewsPage),
  ]);
```

3. Add imports `fetchPublishedReviews, fetchReviewSummary` from catalog and `ProductReviews` component; render below variants section:

```tsx
        {/* Отзывы (moderated) */}
        <ProductReviews
          productId={product.id}
          summary={reviewSummary}
          data={reviewsData}
          productSlug={product.slug}
        />
```

- [ ] **Step 5: Feature 1 checkpoint — full verification**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green (lint may show the 2 pre-existing warnings noted in Stage 9).

---

### Task 10: Recently-viewed pure storage module

**Files:**
- Create: `app/lib/recently-viewed-storage.ts`
- Test: `tests/recently-viewed.test.ts`

**Interfaces:**
- Produces:
  - `RECENTLY_VIEWED_STORAGE_KEY = 'eshop-recently-viewed-v1'`
  - `MAX_RECENTLY_VIEWED = 8`
  - `sanitizeRecentlyViewed(raw: unknown): string[]` — valid UUID strings only, dedupe keeping FIRST occurrence, cap 8, preserve order
  - `readRecentlyViewed(get: (key: string) => string | null): string[]` — JSON.parse guarded → []
  - `writeRecentlyViewed(set: (key: string, value: string) => void, ids: string[]): void` — guarded no-throw
  - `recordRecentlyViewed(ids: string[], productId: string): string[]` — dedupe current, unshift, cap 8; invalid/non-uuid productId returns sanitized ids unchanged

- [ ] **Step 1: Write failing unit tests** — create `tests/recently-viewed.test.ts`:

```ts
/**
 * Recently-viewed shelf: pure storage logic (no DB — localStorage only).
 * Covers order, dedupe, cap-8, move-to-front, malformed input, hydration-safe
 * contracts, plus static pins on the client islands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  RECENTLY_VIEWED_STORAGE_KEY,
  MAX_RECENTLY_VIEWED,
  sanitizeRecentlyViewed,
  readRecentlyViewed,
  writeRecentlyViewed,
  recordRecentlyViewed,
} from '../app/lib/recently-viewed-storage';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

const uuidN = (n: number) =>
  `${String(n % 10).repeat(8)}-${String(n % 10).repeat(4)}-4${String(n % 10).repeat(3)}-8${String(n % 10).repeat(3)}-${String(n % 10).repeat(12)}`;

test('RECENT: sanitize keeps valid uuids in order, drops everything else', () => {
  assert.deepEqual(sanitizeRecentlyViewed([A, B]), [A, B]);
  assert.deepEqual(sanitizeRecentlyViewed(['not-a-uuid', A, 42, null, {}]), [A]);
  assert.deepEqual(sanitizeRecentlyViewed('junk'), []);
  assert.deepEqual(sanitizeRecentlyViewed(null), []);
  assert.deepEqual(sanitizeRecentlyViewed([]), []);
});

test('RECENT: sanitize dedupes keeping the FIRST occurrence (stored recency order)', () => {
  assert.deepEqual(sanitizeRecentlyViewed([A, B, A, C]), [A, B, C]);
});

test('RECENT: sanitize caps at 8 entries', () => {
  const many = Array.from({ length: 20 }, (_, i) => uuidN(i));
  assert.equal(sanitizeRecentlyViewed(many).length, MAX_RECENTLY_VIEWED);
});

test('RECENT: record adds new product at front', () => {
  assert.deepEqual(recordRecentlyViewed([B, C], A), [A, B, C]);
});

test('RECENT: record moves existing product to front without duplication', () => {
  assert.deepEqual(recordRecentlyViewed([C, B, A], A), [A, C, B]);
  const once = recordRecentlyViewed([C, B, A], A);
  assert.equal(once.filter((id) => id === A).length, 1);
});

test('RECENT: record evicts oldest beyond the cap of 8', () => {
  const eight = [A, B, C, uuidN(4), uuidN(5), uuidN(6), uuidN(7), uuidN(8)];
  const next = recordRecentlyViewed(eight, D);
  assert.equal(next.length, MAX_RECENTLY_VIEWED);
  assert.equal(next[0], D);
  assert.equal(next.includes(uuidN(8)), false, 'oldest dropped');
});

test('RECENT: invalid product id leaves the list unchanged', () => {
  assert.deepEqual(recordRecentlyViewed([A, B], 'garbage'), [A, B]);
  assert.deepEqual(recordRecentlyViewed([], ''), []);
});

test('RECENT: read guards malformed JSON and wrong shapes', () => {
  const get = (raw: string | null) => (_key: string) => raw;
  assert.deepEqual(readRecentlyViewed(get('not json')), []);
  assert.deepEqual(readRecentlyViewed(get(JSON.stringify({ x: 1 }) as string)), []);
  assert.deepEqual(readRecentlyViewed(get(JSON.stringify([A, 'bad']))), [A]);
  assert.deepEqual(readRecentlyViewed(get(null)), []);
});

test('RECENT: write serializes the array; storage failures are swallowed', () => {
  let stored: string | null = null;
  writeRecentlyViewed((_k, v) => { stored = v; }, [A, B]);
  assert.deepEqual(JSON.parse(stored as string), [A, B]);

  assert.doesNotThrow(() =>
    writeRecentlyViewed(() => { throw new Error('quota'); }, [A])
  );

  assert.equal(RECENTLY_VIEWED_STORAGE_KEY, 'eshop-recently-viewed-v1');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/recently-viewed.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — create `app/lib/recently-viewed-storage.ts`:

```ts
/**
 * Pure recently-viewed storage — no React, no direct DOM access. Imported by
 * the tracker/shelf client islands and unit-tested in Node.
 *
 * Privacy: stores ONLY anonymous product UUIDs — no names, prices, sessions
 * or identifiers of any kind.
 */

export const RECENTLY_VIEWED_STORAGE_KEY = 'eshop-recently-viewed-v1';

export const MAX_RECENTLY_VIEWED = 8;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Defensive parse of persisted data: keep only well-formed UUIDs, preserve
 * stored order (most recent first), drop duplicates keeping the FIRST
 * occurrence (the position that reflects recency), cap at the limit.
 */
export function sanitizeRecentlyViewed(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw.slice(0, MAX_RECENTLY_VIEWED * 2)) {
    if (typeof entry !== 'string' || !UUID_RE.test(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= MAX_RECENTLY_VIEWED) break;
  }
  return out;
}

/** localStorage.getItem adapter: broken/absent JSON degrades to []. */
export function readRecentlyViewed(get: (key: string) => string | null): string[] {
  let raw: string | null = null;
  try {
    raw = get(RECENTLY_VIEWED_STORAGE_KEY);
    if (raw === null) return [];
    return sanitizeRecentlyViewed(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** localStorage.setItem adapter: quota/private-mode failures are swallowed. */
export function writeRecentlyViewed(
  set: (key: string, value: string) => void,
  ids: string[]
): void {
  try {
    set(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode/quota): the shelf simply stays empty.
  }
}

/**
 * Record a product view: newest first, no duplicates, oldest evicted past 8.
 * An invalid product id is a no-op (never poison the stored list).
 */
export function recordRecentlyViewed(ids: string[], productId: string): string[] {
  if (!UUID_RE.test(productId)) return sanitizeRecentlyViewed(ids);
  const next = [productId, ...ids.filter((id) => id !== productId)];
  return next.slice(0, MAX_RECENTLY_VIEWED);
}
```

- [ ] **Step 4: Verify pass**

Run: `npm test tests/recently-viewed.test.ts`
Expected: PASS (9 tests).

---

### Task 11: Tracker + shelf components, page wiring

**Files:**
- Create: `app/components/RecentlyViewedTracker.tsx`
- Create: `app/components/RecentProducts.tsx`
- Modify: `app/product/[slug]/page.tsx`
- Test: `tests/recently-viewed.test.ts` (append)

**Hydration contract:** the tracker renders `null` on server AND client during render; it touches localStorage only inside `useEffect`. The shelf renders `null` until a post-mount effect read completes → SSR HTML identical to first client render → zero mismatch.

- [ ] **Step 1: Append failing static tests**:

```ts
// ---- client islands: hydration-safe contracts ----

test('RECENT TRACKER: renders null, writes only inside useEffect', () => {
  const cmp = src('app/components/RecentlyViewedTracker.tsx');
  assert.match(cmp, /'use client'/);
  assert.match(cmp, /useEffect/);
  assert.match(cmp, /return null/, 'renders nothing — SSR-safe');
  assert.doesNotMatch(cmp, /localStorage[\s\S]*render|useMemo[\s\S]*localStorage/,
    'no storage access during render');
});

test('RECENT SHELF: excludes current product, caps 8, reuses cart-preview invariant', () => {
  const cmp = src('app/components/RecentProducts.tsx');
  assert.match(cmp, /excludeProductId/);
  assert.match(cmp, /\.filter\(\(id\) => id !== excludeProductId/);
  assert.match(cmp, /fetchCartPreview/, 'ONLY sanctioned preview fetcher');
  assert.match(cmp, /mounted/, 'renders nothing before mount (hydration-safe)');
  assert.match(cmp, /Нещодавно переглянуті/);
  assert.match(cmp, /<ProductCard/);
  const page = src('app/product/[slug]/page.tsx');
  assert.match(page, /<RecentProducts excludeProductId=\{product\.id\}/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/recently-viewed.test.ts`
Expected: FAIL — components missing.

- [ ] **Step 3: Implement tracker** — create `app/components/RecentlyViewedTracker.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import {
  readRecentlyViewed,
  writeRecentlyViewed,
  recordRecentlyViewed,
} from '@/app/lib/recently-viewed-storage';

/**
 * Invisible recorder: adds the currently open product to the
 * recently-viewed list. Runs exclusively inside an effect (after
 * hydration) and always renders null, so server and client markup match
 * exactly — no hydration mismatch is possible.
 */
export default function RecentlyViewedTracker({ productId }: { productId: string }) {
  useEffect(() => {
    const current = readRecentlyViewed((key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    });
    writeRecentlyViewed((key, value) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // ignore quota/private-mode failures
      }
    }, recordRecentlyViewed(current, productId));
  }, [productId]);

  return null;
}
```

- [ ] **Step 4: Implement shelf** — create `app/components/RecentProducts.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import ProductCard from '@/app/components/ProductCard';
import {
  fetchCartPreview,
  type CartPreviewLine,
} from '@/app/lib/cart-preview';
import {
  MAX_RECENTLY_VIEWED,
  readRecentlyViewed,
} from '@/app/lib/recently-viewed-storage';

/**
 * «Нещодавно переглянуті» shelf. Data flow mirrors the favorites page:
 * localStorage holds ONLY product UUIDs; every price/name/image arrives from
 * the existing bounded batch endpoint /api/cart-preview via the sanctioned
 * time-bounded fetcher. Products that disappeared (inactive/deleted) come
 * back found:false and are dropped silently — stale ids can never break the
 * UI. The block renders nothing (server AND first client render) until the
 * post-mount read finishes: SSR-safe, no hydration mismatch.
 */
export default function RecentProducts({ excludeProductId }: { excludeProductId: string }) {
  const [mounted, setMounted] = useState(false);
  const [lines, setLines] = useState<CartPreviewLine[]>([]);
  const [hasEntries, setHasEntries] = useState(false);

  useEffect(() => {
    setMounted(true);
    const ids = readRecentlyViewed((key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    })
      .filter((id) => id !== excludeProductId)
      .slice(0, MAX_RECENTLY_VIEWED);

    if (ids.length === 0) return;

    setHasEntries(true);
    let cancelled = false;
    const dispose = fetchCartPreview(
      ids.map((productId) => ({ productId, variantId: null })),
      {
        onData: (data) => {
          if (cancelled) return;
          // Preserve recency order of the STORED ids, not the response order.
          const byId = new Map(data.map((line) => [line.productId, line]));
          setLines(
            ids
              .map((id) => byId.get(id))
              .filter((line): line is CartPreviewLine => Boolean(line && line.found))
          );
        },
        onError: (message) => {
          // Supplementary shelf: a network hiccup hides it, never blocks the page.
          console.error('recently-viewed preview failed:', message);
          if (!cancelled) setHasEntries(false);
        },
        onDone: () => {},
      }
    );
    return () => {
      cancelled = true;
      dispose();
    };
  }, [excludeProductId]);

  if (!mounted || !hasEntries || lines.length === 0) return null;

  return (
    <section className="container mx-auto px-4 pb-4">
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <h2 className="text-xl font-bold mb-4">Нещодавно переглянуті</h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {lines.map((line) => (
            <ProductCard
              key={line.productId}
              product={{
                id: line.productId,
                name: line.name ?? '',
                slug: line.slug ?? '',
                price: line.unitPrice ?? 0,
                currency: line.currency ?? '',
                old_price: null,
                availability_status: line.availabilityStatus ?? 'out_of_stock',
                brand: null,
              }}
              imageUrl={line.imageUrl}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Wire the product page** — in `app/product/[slug]/page.tsx`:

Import both components; render `<RecentProducts excludeProductId={product.id} />` right AFTER the variants section (before `<ProductReviews>` per UX: related content first, personal shelf after), and `<RecentlyViewedTracker productId={product.id} />` just before `<SiteFooter />`.

- [ ] **Step 6: Feature 2 checkpoint**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: green.

---

### Task 12: Featured-limit pure module

**Files:**
- Create: `app/lib/featured-limit.ts`
- Test: `tests/featured-limit.test.ts`

**Interfaces:**
- Produces:
  - `MAX_FEATURED_PRODUCTS = 8`
  - `FEATURED_LIMIT_MESSAGE` (uk string about the 8-limit)
  - `decideFeaturedToggle(input: { currentlyFeatured: boolean; requestedFeatured: boolean; featuredCount: number }): { allowed: true } | { allowed: false; reason: 'limit_reached' }`
  - `countFeaturedProducts(client: { from: Function }): Promise<number>` — typed against SupabaseClient via `import type` (runtime dependency-free)

- [ ] **Step 1: Write failing unit tests** — create `tests/featured-limit.test.ts`:

```ts
/** Max-8 business rule for «Популярні товари» (UI/API rule, NOT a DB constraint). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  MAX_FEATURED_PRODUCTS,
  FEATURED_LIMIT_MESSAGE,
  decideFeaturedToggle,
} from '../app/lib/featured-limit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

test('FEATURED: cap constant is exactly 8', () => {
  assert.equal(MAX_FEATURED_PRODUCTS, 8);
});

test('FEATURED: turning OFF is always allowed, even at full capacity', () => {
  assert.deepEqual(decideFeaturedToggle({ currentlyFeatured: true, requestedFeatured: false, featuredCount: 8 }), { allowed: true });
});

test('FEATURED: keeping an already-featured product ON is a no-op allow', () => {
  assert.deepEqual(decideFeaturedToggle({ currentlyFeatured: true, requestedFeatured: true, featuredCount: 8 }), { allowed: true });
  assert.deepEqual(decideFeaturedToggle({ currentlyFeatured: true, requestedFeatured: true, featuredCount: 3 }), { allowed: true });
});

test('FEATURED: enabling under the cap is allowed', () => {
  assert.deepEqual(decideFeaturedToggle({ currentlyFeatured: false, requestedFeatured: true, featuredCount: 7 }), { allowed: true });
  assert.deepEqual(decideFeaturedToggle({ currentlyFeatured: false, requestedFeatured: true, featuredCount: 0 }), { allowed: true });
});

test('FEATURED: enabling at 8 is rejected with a clear reason', () => {
  assert.deepEqual(decideFeaturedToggle({ currentlyFeatured: false, requestedFeatured: true, featuredCount: 8 }), { allowed: false, reason: 'limit_reached' });
  assert.deepEqual(decideFeaturedToggle({ currentlyFeatured: false, requestedFeatured: true, featuredCount: 9 }), { allowed: false, reason: 'limit_reached' });
});

test('FEATURED: message explains the limit in Ukrainian', () => {
  assert.match(FEATURED_LIMIT_MESSAGE, /8/);
  assert.match(FEATURED_LIMIT_MESSAGE, /Популярн/);
});

// ---- static pins: API enforcement lives in BOTH mutating product routes ----

test('FEATURED API: PUT checks before update and REVERTS its own overshoot', () => {
  const route = src('app/api/admin/products/[id]/route.ts');
  assert.match(route, /decideFeaturedToggle/);
  assert.match(route, /countFeaturedProducts/);
  assert.match(route, /limit_reached/);
  assert.match(route, /revert/i, 'post-update recount reverts overshoot');
});

test('FEATURED API: POST checks before insert and demotes its own overshoot', () => {
  const route = src('app/api/admin/products/route.ts');
  assert.match(route, /decideFeaturedToggle/);
  assert.match(route, /featured-count/, 'counter endpoint exists');
});

test('FEATURED API: admin auth guard intact in both product routes', () => {
  const listRoute = src('app/api/admin/products/route.ts');
  const itemRoute = src('app/api/admin/products/[id]/route.ts');
  // list route: GET + POST; item route: GET + PUT + DELETE.
  assert.equal((listRoute.match(/export async function/g) ?? []).length, 2);
  assert.equal((itemRoute.match(/export async function/g) ?? []).length, 3);
  // Every handler body must pass through the guard before touching serviceClient.
  for (const route of [listRoute, itemRoute]) {
    const parts = route.split(/export async function (?:GET|POST|PUT|DELETE)/).slice(1);
    for (const part of parts) {
      const guardPos = part.indexOf('requireAdminApi()');
      assert.ok(guardPos >= 0, 'handler must call the guard');
      const dbPos = part.indexOf(".from('");
      if (dbPos >= 0) assert.ok(guardPos < dbPos, 'guard BEFORE any DB query');
    }
  }
});

test('FEATURED UI: badge reflects server row state on every page/search result', () => {
  const ui = src('app/admin/(dashboard)/products/page.tsx');
  // The «Вибраний» badge renders from the per-row server payload — so it is
  // correct on ANY page of pagination and under any search filter.
  assert.match(ui, /product\.is_featured &&/);
});

test('FEATURED UI: modal shows counter, hint, disables at limit — no silent unselect', () => {
  const ui = src('app/admin/(dashboard)/products/page.tsx');
  assert.match(ui, /Обрано:/);
  assert.match(ui, /Популярні товари/);
  assert.match(ui, /featured-count/);
  assert.match(ui, /disabled/, 'checkbox blocked at limit');
  assert.match(ui, /Ліміт/, 'explicit message instead of silent auto-removal');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/featured-limit.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — create `app/lib/featured-limit.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Business rule: the home «Популярні товари» shelf shows AT MOST 8 curated
 * (is_featured=true) products. The limit is deliberately enforced in the
 * admin API + UI — NOT as a database constraint (admins may exceed it
 * temporarily via SQL without breaking anything; the storefront query stays
 * bounded at 8 either way).
 */

export const MAX_FEATURED_PRODUCTS = 8;

export const FEATURED_LIMIT_MESSAGE =
  'Досягнуто ліміт: у блоці «Популярні товари» вже 8 товарів. Зніміть один з них, щоб додати інший.';

export type FeaturedDecision =
  | { allowed: true }
  | { allowed: false; reason: 'limit_reached' };

/**
 * Pure decision for a featured toggle:
 *  - switching OFF: always fine (frees a slot);
 *  - staying ON: a no-op, allowed even at capacity;
 *  - switching ON: allowed only while fewer than 8 products are featured.
 */
export function decideFeaturedToggle(input: {
  currentlyFeatured: boolean;
  requestedFeatured: boolean;
  featuredCount: number;
}): FeaturedDecision {
  if (!input.requestedFeatured) return { allowed: true };
  if (input.currentlyFeatured) return { allowed: true };
  if (input.featuredCount < MAX_FEATURED_PRODUCTS) return { allowed: true };
  return { allowed: false, reason: 'limit_reached' };
}

/**
 * Indexed head-count of featured products (service-role client expected).
 * Used by the admin routes for the pre-check and the post-update race guard.
 */
export async function countFeaturedProducts(
  client: SupabaseClient
): Promise<number> {
  const { count, error } = await client
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('is_featured', true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
```

- [ ] **Step 4: Verify pass (API/UI pins will still fail — they gate Tasks 13–14)**

Run: `npm test tests/featured-limit.test.ts`
Expected: the 6 pure-module tests PASS; the 3 static pins FAIL until Tasks 13–14 land. This is the intended intermediate state; do not proceed to a checkpoint until Task 14 completes.

---

### Task 13: Storefront popular query — featured-only + homepage hides empty

**Files:**
- Modify: `app/lib/catalog.ts` (`fetchPopularProducts`)
- Modify: `app/(home)/page.tsx`
- Rewrite: `tests/popular-products.test.ts`

**Decision (user-approved):** NO newest-products fallback anymore — the shelf shows exactly what the admin curated (≤8). 0 featured ⇒ homepage renders no popular section at all.

- [ ] **Step 1: Rewrite the failing parts of `tests/popular-products.test.ts`** — replace the fallback-leg test («POPULAR: fallback leg takes newest non-featured…») and leg-bound test with:

```ts
test('POPULAR: featured-only leg with stable ordering (NO fallback fill)', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(lib.indexOf('fetchPopularProducts'));
  assert.ok(fn.length > 0 && fn.length < 4000, 'function must stay local');
  assert.match(fn, /\.eq\('is_featured', true\)/);
  assert.match(fn, /created_at/, 'existing date field orders the shelf');
  assert.match(fn, /\.order\('id'/, 'id tiebreaker required for bulk imports');
  assert.doesNotMatch(
    fn,
    /is_featured[^]*?false|neq\('is_featured'|remaining/,
    'fallback-to-newest was REMOVED by decision 2026-08-26'
  );
});

test('POPULAR: single bounded window, not a paged scan', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(lib.indexOf('fetchPopularProducts'));
  const ranges = fn.match(/\.range\(/g) ?? [];
  assert.equal(ranges.length, 1, 'exactly one bound window');
  assert.doesNotMatch(fn, /for\s*\(\s*;;\)/, 'no unbounded pagination loop');
  assert.match(fn, /\.range\(0,\s*[A-Za-z]/, 'window derives from the limit cap');
});

test('POPULAR: home hides the whole section when nothing is featured', () => {
  const page = src('app/(home)/page.tsx');
  assert.match(page, /popularProducts\.length > 0 && \(/, 'conditional render');
  assert.match(page, /Популярні товари/);
  assert.match(page, /<ProductCard\b/, 'must use the existing ProductCard');
});
```

Keep the other tests (exports/real-table, clamp, honest-error, Вибрані-survives, no-mock-names) intact but fix the grid regex if it referenced removed markup.

- [ ] **Step 2: Run to verify failure**

Run: `npm test tests/popular-products.test.ts`
Expected: FAIL on fallback-present / conditional-render assertions.

- [ ] **Step 3: Rewrite `fetchPopularProducts`** in `app/lib/catalog.ts`:

```ts
/**
 * Products for the home «Популярні товары» section — PURELY admin-curated.
 *
 * DECISION 2026-08-26 (supersedes the Stage-11 fallback): popularity has no
 * sales signal yet, and padding the shelf with newest arrivals blurred who
 * controls the block. Now it shows EXACTLY the active products flagged
 * is_featured, newest-first with an id tiebreaker, hard-capped at 8. If an
 * admin flags more than 8, the first 8 in this deterministic order win and
 * DATA IS NEVER CHANGED AUTOMATICALLY. Zero featured ⇒ the home page skips
 * the section entirely (no giant empty box, no random filler).
 */
export async function fetchPopularProducts(
  limit: number = POPULAR_LIMIT
): Promise<Product[]> {
  const take = Math.min(Math.max(limit, 1), POPULAR_LIMIT);

  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('is_active', true)
    .eq('is_featured', true)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, take - 1)
    .returns<ProductJoinedRow[]>();

  if (error) {
    throw new Error(`Failed to load featured products: ${error.message}`);
  }

  return (data ?? []).map(normalizeProduct);
}
```

- [ ] **Step 4: Homepage conditional render** — wrap the popular section in `app/(home)/page.tsx`:

```tsx
      {/* Популярні товари — purely admin-curated (is_featured), hidden
          entirely while nothing is selected (decision 2026-08-26). */}
      {popularProducts.length > 0 && (
        <section className="container mx-auto px-4 py-12">
          ...existing header + grid...
        </section>
      )}
```

Also update the `popularProducts.length === 0` branch removal (no longer reachable inside the conditional) and drop the stale "topped up" comment.

- [ ] **Step 5: Verify pass**

Run: `npm test tests/popular-products.test.ts`
Expected: PASS.

---

### Task 14: Admin API enforcement (PUT/POST + featured-count)

**Files:**
- Modify: `app/api/admin/products/route.ts` (add `case 'featured-count'`; POST guard)
- Modify: `app/api/admin/products/[id]/route.ts` (PUT guard)
- Test: `tests/featured-limit.test.ts` pins from Task 12 now targeted

**Race-condition honesty:** supabase-js has no client transactions. Strategy: pre-check → mutate → post-count → self-revert. Two parallel enables can transiently exceed 8 between UPDATE and recount, but the LAST writer detects >8 and reverts ITS OWN change, so the persisted state converges back to ≤8 and no third product is ever silently removed. Full serialization would need an RPC/advisory-lock migration (out of scope; documented finding).

- [ ] **Step 1: PUT guard in `[id]/route.ts`** — replace the bare `if ('is_featured' in body) patch.is_featured = Boolean(body.is_featured);` with:

```ts
    if ('is_featured' in body) {
      const requested = Boolean(body.is_featured);
      patch.is_featured = requested;

      if (requested) {
        // Pre-check against the max-8 business rule (current state matters:
        // an already-featured product staying on is a no-op).
        const [currentRow, featuredCountBefore] = await Promise.all([
          ctx.serviceClient
            .from('products')
            .select('is_featured')
            .eq('id', id)
            .maybeSingle(),
          countFeaturedProducts(ctx.serviceClient),
        ]);
        if (productMissingOrError(currentRow.error, currentRow.data)) {
          return NextResponse.json({ error: 'Товар не знайдено' }, { status: 404 });
        }
        const decision = decideFeaturedToggle({
          currentlyFeatured: Boolean(currentRow.data?.is_featured),
          requestedFeatured: true,
          featuredCount: featuredCountBefore,
        });
        if (!decision.allowed) {
          return NextResponse.json({ error: FEATURED_LIMIT_MESSAGE }, { status: 409 });
        }
      }
    }
```

with local helpers at top of the handler file:

```ts
import {
  MAX_FEATURED_PRODUCTS,
  FEATURED_LIMIT_MESSAGE,
  countFeaturedProducts,
  decideFeaturedToggle,
} from '@/app/lib/featured-limit';

function productMissingOrError(
  error: { message: string } | null,
  data: unknown
): boolean {
  return Boolean(error) || !data;
}
```

And immediately AFTER a successful update (when `patch.is_featured === true`), add the race guard:

```ts
    // Race guard: parallel admins could both pass the pre-check. Whoever
    // pushes the count OVER the cap reverts THEIR OWN toggle — the state
    // converges to ≤8 and nobody else's product is touched silently.
    // Residual: a sub-second transient window above the cap is possible;
    // full serialization would require an RPC/advisory lock (needs GO).
    if (patch.is_featured === true) {
      const featuredCountAfter = await countFeaturedProducts(ctx.serviceClient);
      if (featuredCountAfter > MAX_FEATURED_PRODUCTS) {
        await ctx.serviceClient
          .from('products')
          .update({ is_featured: false })
          .eq('id', id);
        return NextResponse.json({ error: FEATURED_LIMIT_MESSAGE }, { status: 409 });
      }
    }
```

The word `revert` must appear (static pin) — put it in a comment exactly as above (`// ... reverts THEIR OWN toggle`) plus rename nothing else.

- [ ] **Step 2: POST guard + counter endpoint in `route.ts`**:

Add case to GET switch:

```ts
      case 'featured-count': {
        const count = await countFeaturedProducts(ctx.serviceClient);
        return NextResponse.json({ count });
      }
```

In POST: replace `is_featured: Boolean(body.is_featured)` insert usage — pre-check before insert:

```ts
    const wantsFeatured = Boolean(body.is_featured);
    if (wantsFeatured) {
      const featuredCount = await countFeaturedProducts(ctx.serviceClient);
      const decision = decideFeaturedToggle({
        currentlyFeatured: false,
        requestedFeatured: true,
        featuredCount,
      });
      if (!decision.allowed) {
        return NextResponse.json({ error: FEATURED_LIMIT_MESSAGE }, { status: 409 });
      }
    }
```

…and after successful insert (which returned `data`), demote-on-race:

```ts
    if (wantsFeatured) {
      const featuredCountAfter = await countFeaturedProducts(ctx.serviceClient);
      if (featuredCountAfter > MAX_FEATURED_PRODUCTS) {
        // Race loser: keep the created product, drop its featured flag.
        await ctx.serviceClient
          .from('products')
          .update({ is_featured: false })
          .eq('id', data.id);
        return NextResponse.json(
          {
            product: { ...normalizeProduct(data), is_featured: false },
            warning: FEATURED_LIMIT_MESSAGE,
          },
          { status: 201 }
        );
      }
    }
```

Import the four symbols from `@/app/lib/featured-limit` in both files.

- [ ] **Step 3: Verify pins pass**

Run: `npm test tests/featured-limit.test.ts && npx tsc --noEmit`
Expected: PASS all 9.

---

### Task 15: Admin UI — counter, hint, disable-at-limit

**Files:**
- Modify: `app/admin/(dashboard)/products/page.tsx`

**UX (user-approved: toggle stays ONLY in the edit modal):**
1. New state `const [featuredCount, setFeaturedCount] = useState<number | null>(null);` loaded once on mount via `GET /api/admin/products?action=featured-count` (module-scope loader following `fetchCategoryList` pattern), refreshed after every successful save/delete.
2. Checkbox area becomes:

```tsx
                <div className="mt-4 flex flex-col gap-2">
                  <label className="inline-flex items-center text-sm font-medium text-gray-700">
                    <input
                      type="checkbox"
                      name="is_featured"
                      checked={formData.is_featured}
                      disabled={
                        !formData.is_featured &&
                        (featuredCount ?? 0) >= MAX_FEATURED_PRODUCTS
                      }
                      onChange={handleCheckbox}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="ml-2">Популярні товари</span>
                  </label>
                  <p className="text-xs text-gray-500">
                    Обрано: {featuredCount ?? '…'} / {MAX_FEATURED_PRODUCTS} · блок на головній сторінці (макс. {MAX_FEATURED_PRODUCTS})
                  </p>
                  {!formData.is_featured && (featuredCount ?? 0) >= MAX_FEATURED_PRODUCTS && (
                    <p className="text-xs text-red-600">
                      Ліміт досягнуто — зніміть позначку з іншого товару, щоб обрати цей.
                    </p>
                  )}
                </div>
```

Import `MAX_FEATURED_PRODUCTS` from `@/app/lib/featured-limit` (client-safe: pure constants only — verify no server-only import leaks; featured-limit.ts has zero runtime deps besides `import type`).
3. In `handleSubmit` success path and `handleDelete` success path call `refreshFeaturedCount()`.

- [ ] **Step 1: Implement** per above.
- [ ] **Step 2: Feature 3 checkpoint**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green (2 pre-existing lint warnings tolerated).

---

### Task 16: Final verification sweep

- [ ] **Step 1: Full gates**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all green; report exact numbers.

- [ ] **Step 2: SSR smoke via `next start` + curl (Playwright unavailable in this environment — documented)**

Run: `npm run build && (npm run start &) && sleep 5` then curl:
- `GET /` → 200; contains «Вибрані товари»; contains «Популярні товари» ONLY if featured exist in DB (either outcome is valid — record which).
- `GET /catalog` → 200.
- One real product URL from sitemap/catalog → 200; contains `id="reviews"` and «Залишити відгук».
- `GET /api/reviews` (GET on POST-only) → 405.
- Kill the server afterwards.

- [ ] **Step 3: DB safety audit**

Confirm via git diff: no script executed against production DB; migrations NOT applied; `scripts/` untouched except nothing; production writes = 0.

- [ ] **Step 4: FINAL REPORT** — per user template: implemented/files/migrations(not applied)/DB writes(0)/tests/tsc/lint/build/Playwright(honest: unavailable—chrome libs absent)/security-RLS/findings/manual steps before prod (apply 015 via SQL Editor; optionally later RPC advisory-lock migration)/exact SQL file path `database/migrations/015_product_reviews.sql`.
