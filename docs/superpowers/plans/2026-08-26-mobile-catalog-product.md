# Priority 2 UX/UI: Mobile Catalog + Product Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add «Схожі товари» (bounded, deterministic related products), a compact delivery CTA, and LCP priority for first-row product cards on the product/catalog/home pages.

**Architecture:** Pure merge (`collectRelated`) over up to three parallel bounded reads (`fetchRelatedProducts`, windows ≤8 rows mirroring storefront eligibility); server `RelatedProducts` section hiding itself when empty; `priority` opt-in prop on `ProductCard`. GO items 1–5 already implemented earlier are NOT touched.

**Tech Stack:** Next.js 16.3.1 App Router, TypeScript, node:test (env-placeholder + dynamic-import pattern for catalog.ts), Supabase anon SELECT only.

**Spec:** `docs/superpowers/specs/2026-08-26-mobile-catalog-product-design.md`

## Global Constraints

- **NO git commits** (dirty tree holds unrelated owner WIP).
- **DB: read-only SELECT only** — no migrations, no RPC, no new tables. Each product view adds at most 3 bounded reads (windows ≤8 rows).
- Ukrainian strings; no invented facts (delivery CTA references `/delivery`, states nothing about terms).
- Do NOT touch: mobile sheet filters, CategorySelect, existing brand/category links, gallery priority, checkout/orders/auth/RLS, importer, reviews, recently viewed, popular products, SEO files/logic.
- Tests import catalog.ts ONLY via env placeholders set BEFORE dynamic import (project pattern, see tests/catalog-search.test.ts:17-22).
- Baseline: 423 tests pass; tsc clean; lint = 2 pre-existing warnings; H1-invariants (one `<h1` per home/catalog/product/not-found) and the 2-sink dangerouslySetInnerHTML invariant MUST stay green — RelatedProducts uses `<h2>`.
- Kill dev servers with `pgrep -f "next-serv[e]r"` bracket-pattern only (a bare pattern matches your own shell and kills the session).

---

### Task 1: Related-products data layer (`RELATED_LIMIT`, `collectRelated`, `fetchRelatedProducts`)

**Files:**
- Modify: `app/lib/catalog.ts` (append after `fetchPopularProducts`, before `fetchActiveCategories`)
- Test: `tests/related-products.test.ts` (create)

**Interfaces:**
- Consumes: existing `PRODUCT_SELECT`, `ProductJoinedRow`, `normalizeProduct`, `supabase`, `Product` (all in catalog.ts)
- Produces (consumed by Tasks 2):
  - `RELATED_LIMIT = 8`
  - `collectRelated(groups: Product[][], currentId: string, cap?: number): Product[]` — pure
  - `fetchRelatedProducts(product: Pick<Product,'id'|'category_id'|'brand_id'>, limit?: number): Promise<Product[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/related-products.test.ts`:

```ts
/**
 * «Схожі товари» (spec A, 2026-08-26): up to three bounded reads
 * (same category → same brand → newest) merged by the PURE collectRelated.
 * Invariants: storefront eligibility mirror, exclusion of the current
 * product, dedupe across groups, hard cap 8, deterministic order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// catalog.ts creates its Supabase client at module load; provide the
// publishable-env placeholders BEFORE the import (no network happens).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';
const { collectRelated, RELATED_LIMIT } = await import(
  '../app/lib/catalog.ts'
);

// Minimal row shape cast for merge testing — collectRelated only touches id.
function mk(id: string): never {
  return { id } as never;
}

test('RELATED: category group keeps priority over brand, then newest', () => {
  const out = collectRelated(
    [[mk('c1'), mk('c2')], [mk('b1')], [mk('n1'), mk('n2')]],
    'current'
  );
  assert.deepEqual(out.map((p) => p.id), ['c1', 'c2', 'b1', 'n1', 'n2']);
});

test('RELATED: current product is excluded everywhere', () => {
  const out = collectRelated([[mk('current'), mk('c1')], [mk('current')]], 'current');
  assert.deepEqual(out.map((p) => p.id), ['c1']);
});

test('RELATED: duplicates across groups collapse to the first occurrence', () => {
  const out = collectRelated([[mk('x'), mk('y')], [mk('y'), mk('z')]], 'cur');
  assert.deepEqual(out.map((p) => p.id), ['x', 'y', 'z']);
});

test('RELATED: hard cap 8 regardless of candidate volume', () => {
  assert.equal(RELATED_LIMIT, 8);
  const big = Array.from({ length: 20 }, (_, i) => mk(`p${i}`));
  assert.equal(collectRelated([big], 'cur').length, 8);
});

test('RELATED: empty candidates yield an empty list (block hides itself)', () => {
  assert.deepEqual(collectRelated([], 'cur'), []);
  assert.deepEqual(collectRelated([[], [], []], 'cur'), []);
});

test('RELATED: fetch layer is bounded and mirrors eligibility (source-level)', () => {
  const src = readFileSync('app/lib/catalog.ts', 'utf8');
  const start = src.indexOf('async function fetchRelatedStage');
  const end = src.indexOf('export async function fetchRelatedProducts');
  assert.ok(start !== -1 && end > start, 'stage helper must exist');
  const stage = src.slice(start, end);
  assert.match(stage, /\.select\(PRODUCT_SELECT\)/, 'eligibility join reused');
  assert.match(stage, /\.eq\('is_active',\s*true\)/);
  assert.match(stage, /\.neq\('id',\s*currentId\)/, 'current product excluded in SQL');
  assert.match(stage, /\.range\(0,\s*limit - 1\)/, 'single bounded window');
  assert.match(stage, /\.order\('id',\s*\{\s*ascending:\s*false\s*\}\)/, 'deterministic tiebreaker');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /for\s*\(;;\)\s*\{[\s\S]{0,400}fetchRelated/, 'no unbounded paging loop for related');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E "RELATED|ℹ fail" | head -4`
Expected: FAIL — `collectRelated` not exported / stage helper missing.

- [ ] **Step 3: Implement in `app/lib/catalog.ts`**

Insert AFTER the closing brace of `fetchPopularProducts` (before `export async function fetchActiveCategories`):

```ts
// ---------------------------------------------------------------------------
// «Схожі товари» (related products) — read-only discovery shelf for the
// product page. Up to THREE bounded reads (one window ≤limit each), merged
// by the PURE collectRelated: same category first, then same brand, then
// newest. Eligibility mirrors the storefront exactly (PRODUCT_SELECT ⇒
// is_active + ≥1 photo); the current product is excluded in SQL. No RPC,
// no new tables (spec A 2026-08-26).
// ---------------------------------------------------------------------------

/** Hard cap for «Схожі товари» — bounded by design. */
export const RELATED_LIMIT = 8;

/**
 * PURE merge of pre-fetched candidate groups into the final related list.
 * Group order IS the priority; within a group the DB already returned
 * created_at desc → id desc. Dedupes by id, skips currentId, caps at `cap`.
 */
export function collectRelated(
  groups: Product[][],
  currentId: string,
  cap: number = RELATED_LIMIT
): Product[] {
  const seen = new Set<string>([currentId]);
  const collected: Product[] = [];
  for (const group of groups) {
    for (const row of group) {
      if (collected.length >= cap) return collected;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      collected.push(row);
    }
  }
  return collected;
}

async function fetchRelatedStage(
  filter: { field: 'category_id' | 'brand_id'; id: string } | null,
  currentId: string,
  limit: number
): Promise<Product[]> {
  let query = supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('is_active', true)
    .neq('id', currentId);
  if (filter) query = query.eq(filter.field, filter.id);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, limit - 1)
    .returns<ProductJoinedRow[]>();
  if (error) {
    throw new Error(`Failed to load related products: ${error.message}`);
  }
  return (data ?? []).map(normalizeProduct);
}

export async function fetchRelatedProducts(
  product: Pick<Product, 'id' | 'category_id' | 'brand_id'>,
  limit: number = RELATED_LIMIT
): Promise<Product[]> {
  const [sameCategory, sameBrand, newest] = await Promise.all([
    product.category_id
      ? fetchRelatedStage({ field: 'category_id', id: product.category_id }, product.id, limit)
      : Promise.resolve<Product[]>([]),
    product.brand_id
      ? fetchRelatedStage({ field: 'brand_id', id: product.brand_id }, product.id, limit)
      : Promise.resolve<Product[]>([]),
    fetchRelatedStage(null, product.id, limit),
  ]);
  return collectRelated([sameCategory, sameBrand, newest], product.id, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)" | head -6`
Expected: ALL PASS (423 + ~6 related = 429).

---

### Task 2: `RelatedProducts` component + product-page wiring

**Files:**
- Create: `app/components/RelatedProducts.tsx`
- Modify: `app/product/[slug]/page.tsx` (imports; data fetch; render between variants and reviews)
- Test: `tests/related-products.test.ts` (append)

**Interfaces:**
- Consumes: `fetchRelatedProducts`, `Product` (Task 1); existing `ProductCard`, `getMainPublicImageUrl`
- Produces: `RelatedProducts({ products }: { products: Product[] })` — server component, `null` when empty

- [ ] **Step 1: Append failing component/wiring tests to `tests/related-products.test.ts`**

```ts
test('RELATED: component uses h2 (H1-invariant safe), hides when empty, reuses ProductCard', () => {
  const comp = readFileSync('app/components/RelatedProducts.tsx', 'utf8');
  assert.match(comp, /<h2[^>]*>Схожі товари<\/h2>/);
  assert.ok(!comp.includes('<h1'), 'must not introduce a second h1');
  assert.match(comp, /products\.length === 0[\s\S]*?return null/);
  assert.match(comp, /import ProductCard from '\.\/ProductCard'/);
  assert.match(comp, /<ProductCard/);
});

test('RELATED: page degrades on read failure and renders before reviews', () => {
  const page = readFileSync('app/product/[slug]/page.tsx', 'utf8');
  assert.match(page, /let relatedProducts: Product\[\] = \[\]/);
  assert.match(page, /await fetchRelatedProducts\(product\)/);
  assert.match(page, /console\.error\('related products unavailable:'/);
  assert.match(page, /<RelatedProducts products=\{relatedProducts\} \/>/);
  const rel = page.indexOf('<RelatedProducts');
  const rev = page.indexOf('<ProductReviews');
  assert.ok(rel !== -1 && rev !== -1 && rel < rev, 'related before reviews');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test 2>&1 | grep -E "RELATED: (component|page)" | head -3`
Expected: FAIL (files/patterns missing).

- [ ] **Step 3: Create `app/components/RelatedProducts.tsx`**

```tsx
import type { Product } from '@/app/lib/catalog';
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage';
import ProductCard from './ProductCard';

/**
 * «Схожі товари» shelf below the product details. Server component fed by
 * fetchRelatedProducts (bounded, deterministic); hides itself ENTIRELY when
 * nothing qualified — no empty box (spec A 2026-08-26). Uses h2: the page's
 * single <h1> stays the product name (h1-invariants test).
 */
export default function RelatedProducts({
  products,
}: {
  products: Product[];
}) {
  if (products.length === 0) return null;

  return (
    <section className="mb-8 rounded-lg bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-bold">Схожі товари</h2>
      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            imageUrl={getMainPublicImageUrl(product.images)}
          />
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Wire into `app/product/[slug]/page.tsx`**

1. Extend the catalog import (first line of imports):

```tsx
import { fetchProductBySlug, fetchPublishedReviews, fetchReviewSummary, fetchRelatedProducts, type ReviewsPageData, type ReviewSummary, type Product } from '@/app/lib/catalog'
```

2. Add component import next to the other component imports:

```tsx
import RelatedProducts from '@/app/components/RelatedProducts'
```

3. After the reviews try/catch block (after `reviewsData = { reviews: [], total: 0, page: 1, pageSize: 10 }` and its closing `}`), insert:

```tsx
  // Related products are supplementary content: a failed read degrades to a
  // hidden block instead of failing the whole page (same contract as reviews).
  let relatedProducts: Product[] = []
  try {
    relatedProducts = await fetchRelatedProducts(product)
  } catch (err) {
    console.error('related products unavailable:', err)
  }
```

4. Between the variants block's closing `)}` and the `{/* Відгуки */}` comment, insert:

```tsx
        {/* Схожі товари — bounded discovery shelf; hidden when empty. */}
        <RelatedProducts products={relatedProducts} />
```

- [ ] **Step 5: Run tests**

Run: `npm test 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)" | head -5`
Expected: ALL PASS.

---

### Task 3: Delivery CTA on the product page

**Files:**
- Modify: `app/product/[slug]/page.tsx` (inside the details card, directly under `<AddToCartButton … />`)
- Test: `tests/related-products.test.ts` (append)

**Interfaces:**
- Consumes: existing `Link` import (already in the page), route `/delivery`
- Produces: compact info box linking to the delivery/payment policy page

- [ ] **Step 1: Append failing test**

```ts
test('DELIVERY CTA: compact pointer to /delivery without invented facts', () => {
  const page = readFileSync('app/product/[slug]/page.tsx', 'utf8');
  // Inspect ONLY our own block (supplier HTML elsewhere may contain any words).
  const idx = page.indexOf('Доставка та оплата</p>');
  assert.ok(idx !== -1, 'CTA block missing');
  const block = page.slice(idx, idx + 600);
  assert.match(block, /href="\/delivery"/);
  assert.ok(!/Оплата карткою|Оплата онлайн|1-2 дн|терміни|Кур['’]єр/i.test(block), 'no invented payment/shipping claims');
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test 2>&1 | grep "DELIVERY CTA" | head -2`
Expected: FAIL.

- [ ] **Step 3: Implement — insert right after the `<AddToCartButton … />` element (still inside the details card `<div className="bg-white rounded-lg shadow p-6">`)**

```tsx
            {/* Компактний вказівник на повну політику: деталі живуть на
                /delivery — тут нічого не дублюємо і не вигадуємо. */}
            <div className="mt-6 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm">
              <p className="font-semibold text-gray-900">Доставка та оплата</p>
              <p className="mt-1 text-gray-600">
                Умови доставки та оплати — на сторінці{' '}
                <Link href="/delivery" className="text-blue-600 hover:underline">
                  «Доставка та оплата»
                </Link>
                .
              </p>
            </div>
```

- [ ] **Step 4: Run tests**

Run: `npm test 2>&1 | tail -3`
Expected: ALL PASS.

---

### Task 4: LCP priority for first-row cards (ProductCard + home/catalog wiring)

**Files:**
- Modify: `app/components/ProductCard.tsx` (optional `priority` prop)
- Modify: `app/(home)/page.tsx` (featured grid: first 4)
- Modify: `app/catalog/page.tsx` (grid: first 6)
- Test: `tests/lcp-main-invariants.test.ts` (create)

**Interfaces:**
- Consumes: next/image `priority`
- Produces: `ProductCard({ product, imageUrl, priority = false })`; pages pass `priority={idx < N}`

- [ ] **Step 1: Write the failing test**

Create `tests/lcp-main-invariants.test.ts`:

```ts
/**
 * LCP + landmark pins (spec C/D, 2026-08-26): only genuinely above-the-fold
 * card images get next/image priority; everything else keeps lazy-loading.
 * The product page keeps EXACTLY one <main>; header/footer render none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('LCP: ProductCard exposes opt-in priority passed to next/image', () => {
  const src = readFileSync('app/components/ProductCard.tsx', 'utf8');
  assert.match(src, /priority = false/);
  assert.match(src, /priority=\{priority\}/);
});

test('LCP: home marks the first 4 featured cards, popular stays lazy', () => {
  const home = readFileSync('app/(home)/page.tsx', 'utf8');
  assert.match(home, /priority=\{idx < 4\}/);
  const popularIdx = home.indexOf('Популярні товари');
  assert.ok(popularIdx === -1 || !home.slice(popularIdx).includes('priority='), 'popular shelf must stay lazy');
});

test('LCP: catalog marks the first 6 cards eager', () => {
  const src = readFileSync('app/catalog/page.tsx', 'utf8');
  assert.match(src, /priority=\{idx < 6\}/);
});

test('LANDMARK: product page renders exactly one <main>', () => {
  const page = readFileSync('app/product/[slug]/page.tsx', 'utf8');
  assert.equal((page.match(/<main/g) ?? []).length, 1);
});

test('LANDMARK: SiteHeader/SiteFooter render no <main>', () => {
  for (const file of ['app/components/SiteHeader.tsx', 'app/components/SiteFooter.tsx']) {
    assert.equal((readFileSync(file, 'utf8').match(/<main/g) ?? []).length, 0, file);
  }
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npm test 2>&1 | grep -E "LCP:|LANDMARK:" | head -6`
Expected: LCP tests FAIL; LANDMARK tests PASS (pinning current correct state).

- [ ] **Step 3: Implement**

`app/components/ProductCard.tsx` — replace the signature and Image props:

```tsx
export default function ProductCard({
  product,
  imageUrl,
  priority = false,
}: {
  product: ProductCardData;
  imageUrl?: string | null;
  /** Above-the-fold boost for the first grid row(s) only; every other card
   *  keeps next/image native lazy-loading. */
  priority?: boolean;
}) {
```

and on the card image add `priority={priority}` (keep `unoptimized`, `width/height`, classes untouched):

```tsx
            <Image
              src={imageUrl}
              alt={product.name}
              width={400}
              height={300}
              priority={priority}
              unoptimized
              // object-contain: the WHOLE supplier photo must fit inside the
              // card (object-cover was cropping product photos).
              className="h-48 w-full object-contain p-2 transition-transform duration-300 group-hover:scale-[1.03]"
            />
```

`app/(home)/page.tsx` — featured grid map becomes:

```tsx
            {featuredProducts.map((product, idx) => (
              <ProductCard
                key={product.id}
                product={product}
                imageUrl={getMainPublicImageUrl(product.images)}
                priority={idx < 4}
              />
            ))}
```

(Popular-products map stays unchanged.)

`app/catalog/page.tsx` — grid map becomes:

```tsx
                  {products.map((product, idx) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      imageUrl={getMainPublicImageUrl(product.images)}
                      priority={idx < 6}
                    />
                  ))}
```

- [ ] **Step 4: Run tests**

Run: `npm test 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)" | head -5`
Expected: ALL PASS (~436).

---

### Task 5: Full verification gates + live SSR + docs

**Files:**
- Modify: `PROJECT_CONTEXT.md` (append stage notes)

- [ ] **Step 1: Gates**

```bash
npm test 2>&1 | tail -5     # expect 0 fail
npx tsc --noEmit            # expect silent
npm run lint 2>&1 | tail -3 # expect only the 2 pre-existing warnings
npm run build               # expect success
```

- [ ] **Step 2: Live matrix (production build)**

Start server (`(npx next start -p 3111 > /tmp/opencode/next-start.log 2>&1 &) ; sleep 4`), pick a valid slug from `/catalog` HTML, then verify:

| Check | Expect |
|---|---|
| `/product/<valid>` status | 200 |
| «Схожі товари» present | h2 found; ≤8 ProductCards inside section |
| Delivery CTA | «Доставка та оплата» + href="/delivery" |
| `<main` count on product HTML | exactly 1 |
| First card images on `/catalog` | contain `fetchpriority="high"` (≤6), later cards don't |
| Gallery main image | `fetchpriority="high"` present; thumbnails not |
| H1 counts unchanged | home=1, catalog=1, product=1 |

Kill server (bracket pattern).

- [ ] **Step 3: Append PROJECT_CONTEXT.md stage notes**

Short dated section: scope shipped (related/delivery/LCP-cards/landmark pins), bounded-reads numbers, what was ALREADY done earlier (items 1–5), gates results, Playwright limitation, DB writes 0.

- [ ] **Step 4: Final report** per the GO checklist (9 points).
