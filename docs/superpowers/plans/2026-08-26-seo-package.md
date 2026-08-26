# SEO Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all storefront SEO gaps: unique metadata, canonical/noindex policy, expanded sitemap (brands+products), robots hygiene, H1 invariants, Product JSON-LD, tests — with 0 DB writes.

**Architecture:** Pure decision functions in `app/lib/seo.ts` (indexability/canonical/titles) consumed by thin `generateMetadata` wrappers; injectable-fetcher pagination in `app/lib/seo-sitemap.ts` wired by `app/sitemap.ts`; pure JSON-LD builder `app/lib/schema-org.ts` rendered through one escaped sink `app/components/ProductJsonLd.tsx`. Technical routes get noindex via minimal segment layouts.

**Tech Stack:** Next.js 16.3.1 App Router metadata API, TypeScript, node:test (`npm test`), Supabase anon reads (SELECT only).

**Spec:** `docs/superpowers/specs/2026-08-26-seo-package-design.md`

## Global Constraints

- **NO git commits.** Working tree holds unrelated uncommitted work (reviews feature). Never stage/commit anything.
- **DB: 0 INSERT / 0 UPDATE / 0 DELETE / 0 migrations.** Only read-only SELECT via existing anon client patterns.
- All user-visible strings **Ukrainian**. Do not invent facts (no fake ratings/availability/brands/prices).
- This Next.js version differs from training data: consult `node_modules/next/dist/docs/` before inventing APIs. Confirmed APIs used below: `alternates.canonical`, `robots: { index, follow }`, `notFound()`.
- Test imports use explicit `.ts` extensions (`from '../app/lib/seo.ts'`) — project convention for node --test.
- Pure lib modules must NOT import `app/lib/catalog.ts` at runtime (it creates a Supabase client at module load; tests can't load it). Use `import type` only (erased at runtime) or local structural types.
- Do not touch: importer, checkout logic, auth, cart behavior, RLS, admin API semantics. UI visual changes limited to what SEO requires (none expected beyond head tags + one script tag).
- Baseline before start: 389 tests pass; `/product/nonexistent` → HTTP 404 (verified). Preserve both.

---

### Task 1: `app/lib/seo.ts` — indexability policy + metadata builders (pure)

**Files:**
- Create: `app/lib/seo.ts`
- Test: `tests/seo-metadata.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2, 3):
  - `SITE_NAME = 'E-Shop'`
  - `interface CatalogIndexInput { search?: string; categorySlug?: string; brandSlug?: string; categoryFound?: boolean; brandFound?: boolean; minPrice?: number; maxPrice?: number; inStockOnly?: boolean; sort?: string; page?: number }`
  - `decideCatalogIndexing(input: CatalogIndexInput): { indexable: boolean; canonicalPath: string | null }`
  - `truncateQuery(raw: string, max?: number): string` (default max 50)
  - `buildCatalogViewMetadata(args: { input: CatalogIndexInput; categoryName?: string; brandName?: string }): { title: string; description: string; robots?: { index: boolean; follow: boolean }; alternates?: { canonical: string } }`

- [ ] **Step 1: Write the failing test**

Create `tests/seo-metadata.test.ts`:

```ts
/**
 * Pure SEO decision layer: canonical/noindex policy for /catalog views,
 * query truncation, and per-view metadata builders (spec 2026-08-26 B/G).
 * Policy invariant: the INDEXABLE set is exactly the sitemap set —
 * bare /catalog plus single valid category/brand views on page 1
 * with default sort and no other filters. Everything else: noindex,follow,
 * and canonical is emitted ONLY on indexable URLs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SITE_NAME,
  decideCatalogIndexing,
  truncateQuery,
  buildCatalogViewMetadata,
} from '../app/lib/seo.ts';

function dec(over: Partial<Parameters<typeof decideCatalogIndexing>[0]> = {}) {
  return decideCatalogIndexing(over);
}

test('SEO: bare /catalog is indexable with self canonical', () => {
  assert.deepEqual(dec(), { indexable: true, canonicalPath: '/catalog' });
});

test('SEO: single valid category view is indexable, canonical carries encoded slug', () => {
  const r = dec({ categorySlug: 'blendery-1402', categoryFound: true });
  assert.equal(r.indexable, true);
  assert.equal(r.canonicalPath, '/catalog?category=blendery-1402');
});

test('SEO: single valid brand view is indexable', () => {
  const r = dec({ brandSlug: 'tefal', brandFound: true });
  assert.deepEqual(r, { indexable: true, canonicalPath: '/catalog?brand=tefal' });
});

test('SEO: unknown/inactive category or brand slug → noindex without canonical', () => {
  for (const input of [
    { categorySlug: 'bogus', categoryFound: false },
    { brandSlug: 'bogus', brandFound: false },
    { categorySlug: 'bogus' }, // missing flag counts as not found
    { brandSlug: 'bogus' },
  ]) {
    const r = dec(input);
    assert.equal(r.indexable, false, JSON.stringify(input));
    assert.equal(r.canonicalPath, null);
  }
});

test('SEO: search views are never indexable', () => {
  const r = dec({ search: 'щітка', categorySlug: 'c', categoryFound: true });
  assert.equal(r.indexable, false);
  assert.equal(r.canonicalPath, null);
});

test('SEO: filter combinations break indexability', () => {
  const combos: Parameters<typeof decideCatalogIndexing>[0][] = [
    { categorySlug: 'c', categoryFound: true, brandSlug: 'b', brandFound: true },
    { categorySlug: 'c', categoryFound: true, minPrice: 10 },
    { categorySlug: 'c', categoryFound: true, maxPrice: 10 },
    { categorySlug: 'c', categoryFound: true, inStockOnly: true },
    { categorySlug: 'c', categoryFound: true, sort: 'price_asc' },
    { categorySlug: 'c', categoryFound: true, page: 2 },
    { brandSlug: 'b', brandFound: true, sort: 'name_asc' },
  ];
  for (const input of combos) {
    assert.equal(dec(input).indexable, false, JSON.stringify(input));
    assert.equal(dec(input).canonicalPath, null);
  }
});

test('SEO: truncateQuery strips control chars, collapses whitespace, caps length', () => {
  assert.equal(truncateQuery('  a\t\nb  ', 10), 'a b');
  assert.equal(truncateQuery('x\u0000y', 10), 'xy');
  assert.equal(truncateQuery('ж'.repeat(80)), 'ж'.repeat(50));
  assert.equal(truncateQuery(''), '');
  assert.equal(truncateQuery('%,(")'), '', 'specials-only query collapses to nothing');
});

test('SEO: metadata builder — category title follows «X — купити в E-Shop»', () => {
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
  });
  assert.equal(m.title, 'Блендери — купити в E-Shop');
  assert.ok(m.description.includes('Блендери'));
  assert.ok(!m.robots, 'indexable view emits no robots override');
  assert.deepEqual(m.alternates, { canonical: '/catalog?category=blendery-1402' });
});

test('SEO: metadata builder — brand title and search title', () => {
  const b = buildCatalogViewMetadata({
    input: { brandSlug: 'tefal', brandFound: true },
    brandName: 'TEFAL',
  });
  assert.equal(b.title, 'TEFAL — купити в E-Shop');

  const s = buildCatalogViewMetadata({ input: { search: 'мультипіч tefal' } });
  assert.equal(s.title, 'Пошук: «мультипіч tefal» | E-Shop');
  assert.deepEqual(s.robots, { index: false, follow: true });
  assert.equal(s.alternates, undefined);
});

test('SEO: long search query is truncated inside title, never throws', () => {
  const s = buildCatalogViewMetadata({ input: { search: 'ж'.repeat(200) } });
  assert.ok(s.title.length <= 80, `title too long: ${s.title.length}`);
  assert.ok(s.title.startsWith('Пошук: «'));
});

test('SEO: unknown category falls back to generic catalog copy with noindex', () => {
  const m = buildCatalogViewMetadata({ input: { categorySlug: 'zzz' } });
  assert.deepEqual(m.robots, { index: false, follow: true });
  assert.equal(m.alternates, undefined);
});

test('SEO: home metadata is unique vs root layout title (static source check)', () => {
  const home = readFileSync('app/(home)/page.tsx', 'utf8');
  assert.match(home, /export const metadata[\s\S]*?title:/);
  const layout = readFileSync('app/layout.tsx', 'utf8');
  const homeTitle = home.match(/title:\s*[`'"]([^`'"]+)/)?.[1] ?? '';
  const layoutTitle = layout.match(/title:\s*[`'"]([^`'"]+)/)?.[1] ?? '';
  assert.ok(homeTitle.length > 0);
  assert.notEqual(homeTitle, layoutTitle);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E "seo-metadata|fail [0-9]" | tail -5`
Expected: FAIL — cannot find module '../app/lib/seo.ts'

- [ ] **Step 3: Write minimal implementation**

Create `app/lib/seo.ts`:

```ts
import type { Metadata } from 'next';

/**
 * Pure SEO decision layer for the storefront (spec 2026-08-26).
 *
 * Canonical/noindex policy: the indexable set is EXACTLY the sitemap set —
 * bare /catalog plus single valid category/brand views on page 1 with the
 * default sort and no extra filters. Everything else (search results, filter
 * combinations, pagination depth, unknown slugs) is noindex,follow WITHOUT a
 * canonical tag: Google ignores canonicals on noindexed pages, and emitting
 * one would send contradictory signals. Unknown category/brand slugs stay a
 * normal 200 empty state — they are filter VALUES on an existing resource
 * (/catalog), not missing resources (approved decision A of the spec).
 */

export const SITE_NAME = 'E-Shop';

/** Default sort value of /catalog — anything else is a duplicate-content view. */
const DEFAULT_SORT = 'newest';

export interface CatalogIndexInput {
  search?: string;
  categorySlug?: string;
  brandSlug?: string;
  /** slug resolved to an ACTIVE entity (fetchCategoryBySlug/fetchBrandBySlug) */
  categoryFound?: boolean;
  brandFound?: boolean;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort?: string;
  page?: number;
}

export interface IndexingDecision {
  indexable: boolean;
  /** Absolute-path canonical for THIS url; null → omit the tag entirely. */
  canonicalPath: string | null;
}

export function decideCatalogIndexing(
  input: CatalogIndexInput
): IndexingDecision {
  const hasSearch = Boolean(input.search);
  const categoryRequested = Boolean(input.categorySlug);
  const brandRequested = Boolean(input.brandSlug);
  const categoryValid =
    categoryRequested && input.categorySlug !== undefined && input.categoryFound === true;
  const brandValid =
    brandRequested && input.brandSlug !== undefined && input.brandFound === true;

  const invalidSlug =
    (categoryRequested && !categoryValid) || (brandRequested && !brandValid);
  const multiFilter =
    (categoryRequested && brandRequested) ||
    input.minPrice !== undefined ||
    input.maxPrice !== undefined ||
    input.inStockOnly === true ||
    (input.sort ?? DEFAULT_SORT) !== DEFAULT_SORT ||
    (input.page ?? 1) > 1;

  if (hasSearch || invalidSlug || multiFilter) {
    return { indexable: false, canonicalPath: null };
  }

  if (categoryValid) {
    return {
      indexable: true,
      canonicalPath: `/catalog?category=${encodeURIComponent(input.categorySlug!)}`,
    };
  }
  if (brandValid) {
    return {
      indexable: true,
      canonicalPath: `/catalog?brand=${encodeURIComponent(input.brandSlug!)}`,
    };
  }
  return { indexable: true, canonicalPath: '/catalog' };
}

/**
 * Normalize a raw user query for display in <title>/description:
 * strip control characters (they have no place in SERP snippets), collapse
 * whitespace, hard-cap length. PostgREST specials were already handled by
 * sanitizeSearchTerm for QUERIES; this is purely presentation-side.
 */
export function truncateQuery(raw: string, max = 50): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, max);
}

export interface CatalogViewMetadataArgs {
  input: CatalogIndexInput;
  categoryName?: string;
  brandName?: string;
}

type ViewMetadata = Pick<
  Metadata,
  'title' | 'description' | 'robots' | 'alternates'
>;

export function buildCatalogViewMetadata(
  args: CatalogViewMetadataArgs
): ViewMetadata {
  const { input, categoryName, brandName } = args;
  const decision = decideCatalogIndexing(input);

  let title = `Каталог товарів | ${SITE_NAME}`;
  let description =
    'Каталог товарів інтернет-магазину E-Shop з фільтрами та сортуванням.';

  if (input.search) {
    const q = truncateQuery(input.search);
    title = `Пошук: «${q}» | ${SITE_NAME}`;
    description = `Результати пошуку за запитом «${q}» в інтернет-магазині ${SITE_NAME}.`;
  } else if (input.categorySlug && categoryName) {
    title = `${categoryName} — купити в ${SITE_NAME}`;
    description = `Товари у категорії «${categoryName}» — купити в інтернет-магазині ${SITE_NAME}.`;
  } else if (input.brandSlug && brandName) {
    title = `${brandName} — купити в ${SITE_NAME}`;
    description = `Товари бренду ${brandName} — купити в інтернет-магазині ${SITE_NAME}.`;
  }

  return {
    title,
    description,
    ...(decision.indexable
      ? {}
      : { robots: { index: false, follow: true } }),
    ...(decision.canonicalPath
      ? { alternates: { canonical: decision.canonicalPath } }
      : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -5`
Expected: every seo-metadata test GREEN except exactly one — «home metadata is unique vs root layout» stays RED until Task 2 adds the home export. All other suites unaffected.

- [ ] **Step 5: No commit (global constraint)**

---

### Task 2: Home page unique metadata

**Files:**
- Modify: `app/(home)/page.tsx` (add `export const metadata` near top)
- Test: `tests/seo-metadata.test.ts` (existing static check turns green)

**Interfaces:**
- Consumes: nothing (static export)
- Produces: page-level Metadata overriding layout fallback for `/`

- [ ] **Step 1: Add the metadata export**

In `app/(home)/page.tsx`, after the imports (before `export const revalidate`), insert:

```tsx
import type { Metadata } from 'next';

// Unique home metadata (SEO package 2026-08-26): previously the page fell
// through to the root-layout fallback title shared with every other route.
// Copy reuses the hero text already rendered on this page — nothing invented.
export const metadata: Metadata = {
  title: 'Інтернет-магазин товарів для дому | E-Shop',
  description:
    'Найкращі товари за найкращими цінами — з доставкою по всій Україні.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Інтернет-магазин товарів для дому | E-Shop',
    description:
      'Найкращі товари за найкращими цінами — з доставкою по всій Україні.',
    locale: 'uk_UA',
    type: 'website',
    siteName: 'E-Shop',
  },
};
```

(The `import type { Metadata } from 'next';` goes with the other imports at the top; the rest after them.)

- [ ] **Step 2: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: ALL PASS including the Task-1 static home-metadata check (fail count 0).

- [ ] **Step 3: Verify SSR output**

Run: `npx next build && (npx next start -p 3111 > /tmp/opencode/next-start.log 2>&1 &) && sleep 4 && curl -s http://localhost:3111/ | grep -oE '<title>[^<]*</title>|<link rel="canonical"[^>]*>'`
Expected: `<title>Інтернет-магазин товарів для дому | E-Shop</title>` and `<link rel="canonical" href="http://localhost:3000/"/>`.

Then kill the server: `kill $(pgrep -f next-server) 2>/dev/null; true` (never `pkill -f` with a pattern matching your own shell command).

---

### Task 3: Catalog `generateMetadata` rewired through the policy layer

**Files:**
- Modify: `app/catalog/page.tsx:76-104` (replace inline generateMetadata body)

**Interfaces:**
- Consumes: `buildCatalogViewMetadata` from `../lib/seo.ts` (Task 1), existing `parseCatalogSearchParams`, `fetchCategoryBySlug`, `fetchBrandBySlug`
- Produces: Metadata with title/description/robots/alternates for every catalog view

- [ ] **Step 1: Replace the generateMetadata body**

Keep the JSDoc comment intent, replace lines between `export async function generateMetadata...` closing brace with:

```tsx
import { buildCatalogViewMetadata } from '@/app/lib/seo';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams
}): Promise<Metadata> {
  const rawParams = await searchParams;
  const { filters } = parseCatalogSearchParams(rawParams);

  const [category, brand] = await Promise.all([
    filters.categorySlug ? fetchCategoryBySlug(filters.categorySlug) : null,
    filters.brandSlug ? fetchBrandBySlug(filters.brandSlug) : null,
  ]);

  return buildCatalogViewMetadata({
    input: {
      search: filters.search,
      categorySlug: filters.categorySlug,
      brandSlug: filters.brandSlug,
      categoryFound: category !== null,
      brandFound: brand !== null,
      minPrice: filters.minPrice,
      maxPrice: filters.maxPrice,
      inStockOnly: filters.inStockOnly,
      sort: filters.sort,
      page: filters.page,
    },
    categoryName: category?.name,
    brandName: brand?.name,
  });
}
```

Note: `filters.search` arrives RAW from the URL; the builder truncates/strips for display. DB-facing sanitization stays in `sanitizeSearchTerm` (untouched).

- [ ] **Step 2: Run tests**

Run: `npm test 2>&1 | tail -3`
Expected: all PASS (389 baseline + new seo tests).

- [ ] **Step 3: SSR-matrix spot check**

Server still running from Task 2 (restart if needed):

```bash
Q=$(python3 -c "import urllib.parse;print(urllib.parse.quote('tefal'))")
curl -s "http://localhost:3111/catalog?q=$Q" | grep -oE '<title>[^<]*</title>|<meta name="robots"[^>]*>'
curl -s "http://localhost:3111/catalog?category=bogus" | grep -oE '<meta name="robots"[^>]*>'
curl -s "http://localhost:3111/catalog" | grep -oE '<link rel="canonical"[^>]*>'
CS=$(python3 -c "import urllib.parse;print(urllib.parse.quote('blendery-1402'))")
curl -s "http://localhost:3111/catalog?category=$CS" | grep -oE '<title>[^<]*</title>|<link rel="canonical"[^>]*>'
```

Expected: search → `<meta name="robots" content="noindex,follow"/>` (exact casing/format may differ; presence matters), no canonical; bogus category → robots noindex; bare catalog → canonical `/catalog`; category view → title `Блендери — купити в E-Shop` + self canonical.

Kill the server afterwards (see Task 2 Step 3).

---

### Task 4: robots.ts — block /cart and /favorites

**Files:**
- Modify: `app/robots.ts:17` (disallow array)
- Test: `tests/seo-robots.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: MetadataRoute.Robots with complete private-surface coverage

- [ ] **Step 1: Write the failing test**

Create `tests/seo-robots.test.ts`:

```ts
/**
 * robots.txt contract: public storefront crawlable, every private/technical
 * surface disallowed, sitemap linked (spec D).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import robots from '../app/robots.ts';

test('ROBOTS: all private surfaces disallowed for every crawler', () => {
  const rules = robots().rules;
  assert.ok(Array.isArray(rules));
  const star = rules.find((r) => r.userAgent === '*');
  assert.ok(star, 'must target all user agents');
  const disallow = Array.isArray(star.disallow) ? star.disallow : [star.disallow];
  for (const required of ['/admin', '/api/', '/checkout', '/orders/', '/cart', '/favorites']) {
    assert.ok(disallow.includes(required), `missing Disallow: ${required}`);
  }
  assert.ok(star.allow === '/' || (Array.isArray(star.allow) && star.allow.includes('/')),
    'storefront must stay crawlable');
});

test('ROBOTS: sitemap URL points at /sitemap.xml of the configured origin', () => {
  expect_sitemap(robots().sitemap);
});

function expect_sitemap(sitemap: string | string[] | undefined) {
  assert.ok(typeof sitemap === 'string');
  assert.ok(/\/sitemap\.xml$/.test(sitemap));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test 2>&1 | grep -A1 "missing Disallow: /cart" | head -3`
Expected: FAIL mentioning `missing Disallow: /cart`.

- [ ] **Step 3: Implement**

In `app/robots.ts` change line 17 to:

```ts
        disallow: ['/admin', '/admin/', '/api/', '/checkout', '/orders/', '/cart', '/favorites'],
```

(CSS/JS/images remain crawlable: `allow: '/'` untouched.)

- [ ] **Step 4: Verify pass**

Run: `npm test 2>&1 | tail -3`
Expected: all PASS.

---

### Task 5: noindex technical routes (layouts + checkout/admin metadata)

**Files:**
- Create: `app/cart/layout.tsx`, `app/favorites/layout.tsx`, `app/orders/layout.tsx`, `app/checkout/layout.tsx`
- Modify: `app/admin/(dashboard)/layout.tsx` (add metadata export), `app/admin/login/page.tsx` (add metadata export; if the file is `'use client'`, create `app/admin/login/layout.tsx` instead — check its first line)

Rationale: cart/favorites/orders pages are `'use client'` and cannot export metadata; segment layouts are the canonical App Router mechanism. One `app/orders/layout.tsx` covers both `/orders/lookup` and `/orders/[orderNumber]`; one `app/checkout/layout.tsx` covers `/checkout` and `/checkout/success`.

**Interfaces:**
- Consumes: Next Metadata `robots: { index: false, follow: false }`
- Produces: `<meta name="robots" content="noindex,nofollow">` on all technical pages

- [ ] **Step 1: Create the four layouts**

Each file has identical shape (example: `app/cart/layout.tsx`):

```tsx
import type { ReactNode } from 'react';

// Cart is a private localStorage-driven surface: keep it out of search
// indexes entirely (SEO package 2026-08-26, spec E).
export const metadata = {
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
```

Replicate for `favorites` (comment mentions favorites), `orders` (guest order lookup/views), `checkout` (checkout flow + HMAC success view).

- [ ] **Step 2: Admin metadata**

In `app/admin/(dashboard)/layout.tsx` add near the top:

```tsx
import type { Metadata } from 'next';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};
```

Check `app/admin/login/page.tsx`: if it has NO `'use client'` directive, add the same two exports; otherwise create `app/admin/login/layout.tsx` with the same content (adjusting the comment to mention the login screen).

- [ ] **Step 3: Static-invariant test**

Append to `tests/seo-robots.test.ts`:

```ts
import { readFileSync } from 'node:fs';

test('NOINDEX: technical routes carry robots noindex metadata (source-level)', () => {
  const sources: [string, RegExp][] = [
    ['app/cart/layout.tsx', /index:\s*false/],
    ['app/favorites/layout.tsx', /index:\s*false/],
    ['app/orders/layout.tsx', /index:\s*false/],
    ['app/checkout/layout.tsx', /index:\s*false/],
    ['app/admin/(dashboard)/layout.tsx', /index:\s*false/],
  ];
  for (const [file, re] of sources) {
    assert.match(readFileSync(file, 'utf8'), re, `${file} must declare noindex`);
  }
});
```

- [ ] **Step 4: Run tests + SSR check**

Run: `npm test 2>&1 | tail -3` → all PASS.

```bash
(npx next build && (npx next start -p 3111 > /tmp/opencode/next-start.log 2>&1 &) && sleep 4)
for p in cart favorites checkout orders/lookup; do curl -s "http://localhost:3111/$p" | grep -oE '<meta name="robots"[^>]*>' | head -1; done
curl -s -o /dev/null -w "orders-view %{http_code}\n" "http://localhost:3111/orders/x?t=y"
kill $(pgrep -f next-server) 2>/dev/null; true
```

Expected: each of the four prints a noindex robots meta; orders-view stays 200 (state semantics unchanged).

---

### Task 6: Product JSON-LD structured data

**Files:**
- Create: `app/lib/schema-org.ts` (pure builder), `app/components/ProductJsonLd.tsx` (single serialization sink)
- Modify: `app/product/[slug]/page.tsx` (render component), `tests/product-description.test.ts` (sink-count allowlist 1 → 2 sanctioned sinks)
- Test: `tests/seo-jsonld.test.ts` (create)

**Interfaces:**
- Consumes: `Product`, `ReviewSummary` types from `@/app/lib/catalog` (TYPE-ONLY imports — erased at runtime, tests stay Supabase-free); real page data `product` + `reviewSummary`
- Produces: `stripHtmlToText(html: string, cap?: number): string`; `toIsoCurrency(currency: string | null | undefined): string`; `buildProductJsonLd(product: ProductLike, summary: ReviewSummaryLike | null, siteUrl: string): Record<string, unknown> | null`; component `ProductJsonLd({ data })`.

- [ ] **Step 1: Write the failing test**

Create `tests/seo-jsonld.test.ts`:

```ts
/**
 * Product JSON-LD: ONLY real DB fields; offers gated on price>0;
 * aggregateRating gated on real published-review totals; serialization
 * escapes '<' so user/supplier strings can never close the script tag
 * (spec F). Type-only imports keep this module Supabase-free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHtmlToText,
  toIsoCurrency,
  buildProductJsonLd,
  serializeJsonLd,
} from '../app/lib/schema-org.ts';

const BASE = {
  name: 'Плита комбінована BEKO FSM52334DAO',
  slug: 'plyta-beko-7081966',
  sku: '24010/106',
  price: 10999,
  old_price: null as number | null,
  currency: 'UAH',
  availability_status: 'in_stock',
  description: '<p>Гарна плита</p>',
  short_description: null as string | null,
  images: [{ image_url: 'https://b2b.yugcontract.ua/x.jpg' }],
  brand: { name: 'BEKO' },
};

test('JSONLD: stripHtmlToText drops tags, decodes common entities, caps', () => {
  assert.equal(stripHtmlToText('<p>Текст &amp; ще</p>'), 'Текст & ще');
  assert.equal(stripHtmlToText('<div><b>x</b>y</div>'), 'xy');
  assert.equal(stripHtmlToText('abcdefgh', 4), 'abcd');
  assert.equal(stripHtmlToText(''), '');
});

test('JSONLD: currency normalization is factual, never invented', () => {
  assert.equal(toIsoCurrency('UAH'), 'UAH');
  assert.equal(toIsoCurrency('uah'), 'UAH');
  assert.equal(toIsoCurrency('₴'), 'UAH');
  assert.equal(toIsoCurrency('грн.'), 'UAH');
  assert.equal(toIsoCurrency(null), 'UAH');
});

test('JSONLD: happy path emits exactly the real fields', () => {
  const d = buildProductJsonLd(BASE, null, 'https://shop.example');
  assert.equal(d!.['@context'], 'https://schema.org');
  assert.equal(d!.['@type'], 'Product');
  assert.equal(d!.name, BASE.name);
  assert.equal(d!.sku, BASE.sku);
  assert.deepEqual(d!.image, ['https://b2b.yugcontract.ua/x.jpg']);
  assert.equal(d!.description, 'Гарна плита');
  assert.deepEqual(d!.brand, { '@type': 'Brand', name: 'BEKO' });
  assert.deepEqual(d!.offers, {
    '@type': 'Offer',
    url: 'https://shop.example/product/plyta-beko-7081966',
    price: '10999',
    priceCurrency: 'UAH',
    availability: 'https://schema.org/InStock',
  });
  assert.equal(d!.aggregateRating, undefined);
});

test('JSONLD: availability maps the three real statuses only', () => {
  const mk = (availability_status: string) =>
    buildProductJsonLd({ ...BASE, availability_status }, null, 'https://s.io')!.offers as { availability: string };
  assert.equal(mk('in_stock').availability, 'https://schema.org/InStock');
  assert.equal(mk('out_of_stock').availability, 'https://schema.org/OutOfStock');
  assert.equal(mk('limited_stock').availability, 'https://schema.org/LimitedAvailability');
});

test('JSONLD: offers omitted when price is not a positive finite number', () => {
  for (const price of [0, -5, Number.NaN]) {
    const d = buildProductJsonLd({ ...BASE, price }, null, 'https://s.io');
    assert.equal(d!.offers, undefined, `price=${price}`);
  }
});

test('JSONLD: aggregateRating only from real published totals', () => {
  const good = { total: 4, average: 4.5, distribution: [0, 0, 1, 0, 3] as [number, number, number, number, number] };
  assert.deepEqual(buildProductJsonLd(BASE, good, 'x')!.aggregateRating, {
    '@type': 'AggregateRating',
    ratingValue: '4.5',
    ratingCount: 4,
  });
  assert.equal(buildProductJsonLd(BASE, { total: 0, average: null, distribution: [0, 0, 0, 0, 0] }, 'x')!.aggregateRating, undefined);
  assert.equal(buildProductJsonLd(BASE, null, 'x')!.aggregateRating, undefined);
});

test('JSONLD: serializer escapes < so supplier HTML cannot break out', () => {
  const evil = buildProductJsonLd(
    { ...BASE, name: 'x</script><script>alert(1)</script>' },
    null,
    'https://s.io'
  )!;
  const html = serializeJsonLd(evil);
  assert.ok(!/<\/script>/.test(html), 'raw </script> must never survive');
  assert.ok(html.includes('\\u003c/script\\u003e'), 'escaped form required');
});

test('JSONLD: missing brand/description/images simply drop fields', () => {
  const d = buildProductJsonLd(
    { ...BASE, brand: null, description: null, images: [] },
    null,
    'https://s.io'
  )!;
  assert.equal(d!.brand, undefined);
  assert.equal(d!.description, undefined);
  assert.equal(d!.image, undefined);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test 2>&1 | grep -E "Cannot find module.*schema-org" | head -2`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `app/lib/schema-org.ts`**

```ts
import type { Product, ReviewSummary } from '@/app/lib/catalog';

/**
 * schema.org/Product builder — PURE and dependency-free at runtime
 * (type-only imports are erased, so node:test loads this without Supabase).
 *
 * Honesty rules (spec F): every emitted value originates in the database —
 * no invented availability, ratings, counts, brands or SKUs. Offers require
 * a positive finite price; aggregateRating requires REAL published totals
 * (>0 reviews with a computed average).
 */

export type ProductLike = Pick<
  Product,
  | 'name'
  | 'slug'
  | 'sku'
  | 'price'
  | 'currency'
  | 'availability_status'
> & {
  description?: string | null;
  short_description?: string | null;
  images: { image_url: string }[];
  brand?: { name: string } | null;
};

export type ReviewSummaryLike = ReviewSummary;

/** HTML → plain text: drop tags, decode the entities suppliers actually use. */
export function stripHtmlToText(html: string | null | undefined, cap = 5000): string {
  if (!html) return '';
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, cap);
}

/** Stored currency → ISO 4217. Symbol/word forms map to the hryvnia code. */
export function toIsoCurrency(currency: string | null | undefined): string {
  const c = (currency ?? '').trim();
  if (/^[a-z]{3}$/i.test(c)) return c.toUpperCase();
  if (/₴|грн/i.test(c)) return 'UAH';
  return 'UAH';
}

function availabilityUrl(status: string): string {
  if (status === 'in_stock') return 'https://schema.org/InStock';
  if (status === 'out_of_stock') return 'https://schema.org/OutOfStock';
  return 'https://schema.org/LimitedAvailability';
}

export function buildProductJsonLd(
  product: ProductLike,
  summary: ReviewSummaryLike | null,
  siteUrl: string
): Record<string, unknown> | null {
  const base: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    sku: product.sku,
  };

  const image = (product.images ?? [])
    .map((img) => img.image_url)
    .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
  if (image.length > 0) base.image = image;

  const description = stripHtmlToText(product.description) ||
    stripHtmlToText(product.short_description);
  if (description) base.description = description;

  if (product.brand?.name) {
    base.brand = { '@type': 'Brand', name: product.brand.name };
  }

  if (Number.isFinite(product.price) && product.price > 0) {
    base.offers = {
      '@type': 'Offer',
      url: `${siteUrl.replace(/\/+$/, '')}/product/${product.slug}`,
      price: String(product.price),
      priceCurrency: toIsoCurrency(product.currency),
      availability: availabilityUrl(product.availability_status),
    };
  }

  if (
    summary &&
    summary.total > 0 &&
    summary.average !== null &&
    Number.isFinite(summary.average)
  ) {
    base.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: String(summary.average),
      ratingCount: summary.total,
    };
  }

  return base;
}

/**
 * THE serialization invariant: escape '<' so no supplier string can emit
 * '</script>' inside the JSON-LD sink. Used by ProductJsonLd.tsx and pinned
 * by tests/seo-jsonld.test.ts.
 */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
```

- [ ] **Step 4: Implement `app/components/ProductJsonLd.tsx`**

```tsx
import { serializeJsonLd } from '@/app/lib/schema-org';

/**
 * The SECOND sanctioned dangerouslySetInnerHTML sink of the whole app/
 * (the first is ProductDescription). Input is built exclusively by
 * buildProductJsonLd from DB values and serialized with '<'-escaping, so
 * no stored string can terminate the script element early.
 */
export default function ProductJsonLd({
  data,
}: {
  data: Record<string, unknown> | null;
}) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
```

- [ ] **Step 5: Product metadata — canonical + OG locale/siteName (spec §2, G)**

In `app/product/[slug]/page.tsx` `generateMetadata`, the current return drops
layout openGraph fields (shallow merge) and has no canonical. Replace the
return block:

```tsx
  const canonical = `/product/${slug}`;
  return {
    title: `${product.name} — E-Shop`,
    description,
    alternates: { canonical },
    openGraph: {
      title: `${product.name} — E-Shop`,
      description,
      url: canonical,
      locale: 'uk_UA',
      type: 'website',
      siteName: 'E-Shop',
    },
  }
```

(`url` inside openGraph resolves against metadataBase from the root layout.)

- [ ] **Step 6: Wire JSON-LD into the product page**

In `app/product/[slug]/page.tsx`:

1. Add import: `import ProductJsonLd from '@/app/components/ProductJsonLd';`
2. After the `siteUrl` concept — compute once near the top of the component body (after reviews resolve):

```tsx
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const productJsonLd = buildProductJsonLd(product, reviewSummary, siteUrl);
```

with import `import { buildProductJsonLd } from '@/app/lib/schema-org';`

3. Render inside `<main>` right after the opening breadcrumb `<nav>`:

```tsx
        {/* Structured data: real DB fields only (see schema-org.ts honesty rules) */}
        <ProductJsonLd data={productJsonLd} />
```

- [ ] **Step 7: Update the sink-count invariant**

Read `tests/product-description.test.ts`, locate the assertion that counts `dangerouslySetInnerHTML` usages (expects exactly 1 across `app/`), and update it to assert exactly **2**, with an explicit allowlist comment naming both sanctioned sinks (`components/ProductDescription.tsx`, `components/ProductJsonLd.tsx`). Keep the assertion strict (== 2, not >=).

- [ ] **Step 8: Run tests**

Run: `npm test 2>&1 | tail -3`
Expected: all PASS (previous count + ~9 jsonld tests).

- [ ] **Step 9: SSR verify JSON-LD renders**

Rebuild + restart server (commands from Task 5 Step 4), then:

```bash
curl -s http://localhost:3111/product/plyta-kombinovana-beko-fsm52334dao-7081966 | grep -o 'application/ld+json' | head -1
kill $(pgrep -f next-server) 2>/dev/null; true
```

Expected: one match. (If the slug 404s because live data changed, pick another slug from `/catalog` HTML.)

---

### Task 7: Sitemap — brands + eligible products (bounded reads)

**Files:**
- Create: `app/lib/seo-sitemap.ts`
- Modify: `app/sitemap.ts`
- Test: `tests/seo-sitemap.test.ts` (create)

**Interfaces:**
- Consumes (in sitemap.ts): existing `fetchActiveCategories`, `fetchActiveBrands`; a NEW local paged fetcher against `products` mirroring storefront eligibility
- Produces: `collectPaged<T>(fetchPage: (from: number, limit: number) => Promise<T[]>, opts?: { pageSize?: number; maxRows?: number }): Promise<T[]>` — pure loop, injectable IO, unit-testable

- [ ] **Step 1: Write the failing test**

Create `tests/seo-sitemap.test.ts`:

```ts
/**
 * Sitemap expansion: products enter the sitemap under the SAME visibility
 * contract as the storefront grid (active + ≥1 photo), reads stay bounded
 * (paged windows ≤1000, deterministic id tiebreaker), and no private route
 * ever enters the URL list (spec C).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectPaged } from '../app/lib/seo-sitemap.ts';

test('SITEMAP: collectPaged walks exact windows and stops on a short page', async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ slug: `s${i}` }));
  const calls: [number, number][] = [];
  const out = await collectPaged(async (from, limit) => {
    calls.push([from, limit]);
    return rows.slice(from, from + limit);
  }, { pageSize: 1000 });

  assert.deepEqual(calls, [[0, 1000], [1000, 1000], [2000, 1000]]);
  assert.equal(out.length, 2500);
  assert.equal(out[2499].slug, 's2499');
});

test('SITEMAP: collectPaged enforces pageSize ≤1000 and honors maxRows cap', async () => {
  const big = Array.from({ length: 999_999 }, (_, i) => i);
  const out = await collectPaged(async (from, limit) => big.slice(from, from + limit),
    { pageSize: 5000, maxRows: 2500 });
  assert.equal(out.length, 2500);

  const seen: number[] = [];
  await collectPaged(async (_from, limit) => { seen.push(limit); return new Array(limit).fill(0); },
    { pageSize: 20000, maxRows: 10 });
  assert.ok(seen.every((l) => l <= 1000), 'window must clamp to 1000');
});

test('SITEMAP: product query mirrors storefront eligibility (source-level)', () => {
  const src = readFileSync('app/sitemap.ts', 'utf8');
  assert.match(src, /product_images!inner/, 'eligibility join required');
  assert.match(src, /\.eq\('is_active',\s*true\)/);
  assert.match(src, /\.order\('id'/, 'deterministic tiebreaker required');
  assert.doesNotMatch(src, /select\('\*'\)\s*\.\s*eq\('is_active'[^!]*products/, 'no unbounded full-row scans');
  for (const banned of ['/cart', '/favorites', '/checkout', '/admin', '/api/']) {
    assert.ok(!src.includes(`'${banned}'`), `${banned} must not appear in sitemap paths`);
  }
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test 2>&1 | grep -E "Cannot find module.*seo-sitemap" | head -2`
Expected: FAIL.

- [ ] **Step 3: Implement `app/lib/seo-sitemap.ts`**

```ts
/**
 * Bounded paged collection for the sitemap builder. PostgREST caps any
 * response at 1000 rows, so product enumeration walks explicit windows;
 * the CALLER owns ordering (.order('id')) — this module owns termination
 * (short page ⇒ done) and the absolute row cap that bounds worst-case
 * latency no matter how large the catalog grows.
 */
const MAX_PAGE_SIZE = 1000;
const DEFAULT_MAX_ROWS = 100_000;

export async function collectPaged<T>(
  fetchPage: (from: number, limit: number) => Promise<T[]>,
  opts: { pageSize?: number; maxRows?: number } = {}
): Promise<T[]> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

  const out: T[] = [];
  let from = 0;
  for (;;) {
    const limit = Math.min(pageSize, maxRows - out.length);
    if (limit <= 0) return out;
    const rows = await fetchPage(from, limit);
    out.push(...rows);
    if (rows.length < limit) return out;
    from += limit;
  }
}
```

- [ ] **Step 4: Rewrite `app/sitemap.ts`**

```ts
import type { MetadataRoute } from 'next';
import { fetchActiveCategories, fetchActiveBrands } from '@/app/lib/catalog';
import { collectPaged } from '@/app/lib/seo-sitemap';

/**
 * Sitemap for public surfaces only (spec C): static pages, active categories,
 * active brands and EVERY product the storefront grid can show — same
 * eligibility join (active + ≥1 photo via product_images!inner), same
 * anonymous client, whitelist columns only (slug, updated_at). Private and
 * technical routes are never listed. Reads walk bounded 1000-row windows
 * with a deterministic id order (see seo-sitemap.collectPaged).
 */
export const dynamic = 'force-dynamic';

interface SitemapProductRow {
  slug: string;
  updated_at: string;
}

async function fetchEligibleProducts(): Promise<SitemapProductRow[]> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } }
  );

  try {
    return await collectPaged(async (from, limit) => {
      const { data, error } = await supabase
        .from('products')
        .select('slug, updated_at, images:product_images!inner(id)')
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, from + limit - 1);
      if (error) throw new Error(error.message);
      return (data ?? []).map(({ slug, updated_at }) => ({ slug, updated_at }));
    });
  } catch {
    // Sitemap must never fail the route over product data; categories and
    // static entries still ship.
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000')
    .replace(/\/+$/, '');

  const staticEntries: MetadataRoute.Sitemap = [
    '',
    '/catalog',
    '/delivery',
    '/contacts',
    '/about',
    '/returns',
    '/privacy',
    '/terms',
  ].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: path === '' || path === '/catalog' ? 'daily' : 'monthly',
    priority: path === '' ? 1 : path === '/catalog' ? 0.9 : 0.3,
  }));

  const [categories, brands, products] = await Promise.all([
    fetchActiveCategories().catch(() => []),
    fetchActiveBrands().catch(() => []),
    fetchEligibleProducts(),
  ]);

  const categoryEntries: MetadataRoute.Sitemap = categories.map((category) => ({
    url: `${base}/catalog?category=${encodeURIComponent(category.slug)}`,
    lastModified: new Date(category.updated_at),
    changeFrequency: 'daily',
    priority: 0.7,
  }));

  const brandEntries: MetadataRoute.Sitemap = brands.map((brand) => ({
    url: `${base}/catalog?brand=${encodeURIComponent(brand.slug)}`,
    lastModified: new Date(brand.updated_at),
    changeFrequency: 'weekly',
    priority: 0.6,
  }));

  const productEntries: MetadataRoute.Sitemap = products.map((product) => ({
    url: `${base}/product/${encodeURIComponent(product.slug)}`,
    lastModified: new Date(product.updated_at),
    changeFrequency: 'weekly',
    priority: 0.5,
  }));

  return [...staticEntries, ...categoryEntries, ...brandEntries, ...productEntries];
}
```

Note on the dynamic import of supabase-js: keeps this file loadable where the static import graph differs; if lint prefers a top-level import, use `import { createClient } from '@supabase/supabase-js';` at top — equivalent.

- [ ] **Step 5: Run tests**

Run: `npm test 2>&1 | tail -3`
Expected: all PASS.

- [ ] **Step 6: SSR verify sitemap**

Rebuild + restart (Task 5 commands), then:

```bash
curl -s http://localhost:3111/sitemap.xml | grep -c "<loc>"
curl -s http://localhost:3111/sitemap.xml | grep -o "<loc>[^<]*product/[^<]*</loc>" | head -2
curl -s http://localhost:3111/sitemap.xml | grep -c "catalog?brand="
kill $(pgrep -f next-server) 2>/dev/null; true
```

Expected: several thousand locs (~4600); product URLs present; brand URLs present; NO /cart|/favorites|/checkout|/admin|/api in output.

---

### Task 8: H1 invariants (static tests)

**Files:**
- Test: `tests/h1-invariants.test.ts` (create)

- [ ] **Step 1: Write the test**

```ts
/**
 * Exactly one primary <h1> per indexable page (spec H). Source-level pin:
 * these pages render their heading through a single literal or a single
 * heading variable; regressions that sneak a second h1 fail CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGES: [string, string][] = [
  ['home hero', 'app/(home)/page.tsx'],
  ['catalog', 'app/catalog/page.tsx'],
  ['product', 'app/product/[slug]/page.tsx'],
  ['not-found', 'app/not-found.tsx'],
];

for (const [label, file] of PAGES) {
  test(`H1: ${label} declares exactly one <h1> literal`, () => {
    const src = readFileSync(file, 'utf8');
    const count = (src.match(/<h1/g) ?? []).length;
    assert.equal(count, 1, `${file} has ${count} <h1> literals`);
  });
}

test('H1: info pages share the single-h1 InfoPage component', () => {
  const comp = readFileSync('app/components/InfoPage.tsx', 'utf8');
  assert.equal((comp.match(/<h1/g) ?? []).length, 1);
});
```

- [ ] **Step 2: Run**

Run: `npm test 2>&1 | tail -3`
Expected: all PASS (current markup already satisfies; verified live: home=1, product=1).

---

### Task 9: Full verification + documentation

**Files:**
- Modify: `PROJECT_CONTEXT.md` (append stage report)

- [ ] **Step 1: Full gates**

```bash
npm test 2>&1 | tail -5          # expect 0 fail
npx tsc --noEmit                 # expect silent
npm run lint                     # expect only the 2 pre-existing warnings
npm run build                    # expect success
```

- [ ] **Step 2: HTTP/SEO matrix on production build**

Start server, then verify each row; record actual outputs for the report:

| URL | Expect |
|---|---|
| `/` | 200; unique title; canonical `/`; 1×h1 |
| `/catalog` | 200; canonical self; indexable |
| `/catalog?q=tefal` | 200; robots noindex; truncated-safe title |
| `/catalog?category=blendery-1402` | 200; title «Блендери — купити в E-Shop»; canonical self |
| `/catalog?brand=<valid>` | 200; brand title; canonical self |
| `/catalog?category=bogus` | 200; robots noindex (decision A) |
| `/product/<valid>` | 200; JSON-LD present; canonical self |
| `/product/nonexistent-xyz` | **404** |
| `/cart`,`/favorites`,`/checkout`,`/orders/lookup`,`/checkout/success`,`/orders/x?t=y` | 200 + robots noindex meta |
| `/robots.txt` | Disallow /cart,/favorites present; sitemap linked |
| `/sitemap.xml` | products+brands+categories; no private routes |
| `/no-such-route` | 404 |

Console-errors check: `curl` cannot execute JS — note honestly in report (Playwright unavailable in this environment: no chrome/system libs).

Kill server when done.

- [ ] **Step 3: Append stage notes to PROJECT_CONTEXT.md**

Add a dated section describing: scope shipped, decision A semantics, canonical table, sitemap contents/bounds, JSON-LD honesty gates, F14 empirical status (404 verified, streaming caveat documented), test counts, DB writes = 0.

- [ ] **Step 4: Final report to user**

Deliver the 13-point final report required by the GO brief (root causes, files, metadata added, H1 routes, F14 fix status, robots/sitemap/canonical state, structured-data decision, tests, gates, browser-verification limits, DB writes 0, remaining findings, unverifiable-local items).
