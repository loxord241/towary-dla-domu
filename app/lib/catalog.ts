import { createClient } from '@supabase/supabase-js';
import { cache } from 'react';
// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import { collectSubtreeIds } from './category-tree.ts';

// unstable_cache is resolved dynamically: the bare 'next/cache' specifier
// does not resolve under plain-node ESM (no ./cache subpath in next's
// exports), and the node --test suite imports this module. Next's bundler
// resolves the primary specifier; the fallback (the implementation file,
// resolved WITH its .js extension for ESM) is only hit outside Next — i.e.
// by the cache-wiring tests. Creation of wrappers needs no request context;
// only CALLING a wrapped function does (inside a render it always exists).
type UnstableCacheFn = <TArgs extends unknown[], TResult>(
  cb: (...args: TArgs) => Promise<TResult>,
  keyParts: string[],
  options: { revalidate: number; tags: string[] }
) => (...args: TArgs) => Promise<TResult>;

const { unstable_cache } = (await import('next/cache').then(
  (m) => m as { unstable_cache: UnstableCacheFn },
  () =>
    import(
      'next/dist/server/web/spec-extension/unstable-cache.js'
    ) as Promise<{ unstable_cache: UnstableCacheFn }>
)) as { unstable_cache: UnstableCacheFn };

// ---------------------------------------------------------------------------
// Storefront public-read caching (caching step 2, audit 2026-08-31).
//
// The functions wrapped below are PUBLIC and USER-INDEPENDENT: their inputs
// are explicit arguments (no cookies/headers/searchParams), they run under
// the anonymous role, so RLS already decided their content, and their
// results are identical for every visitor. unstable_cache therefore shares
// one Data Cache entry across users safely.
//
// TTL policy: dictionaries change only via the admin UI (120s); products /
// reviews change via the 6-hour Yugcontract importer or moderation (60s).
// Post-import staleness is bounded by the TTL — invisible against the
// 6-hour import cycle. DB errors are never cached: unstable_cache writes
// the entry only after the callback resolves, so a failed read re-executes
// on the next request (degradation contracts of the product page stay).
//
// NOT cached (deliberately):
//  - fetchCatalogProducts: filter keys include user-controlled q/min/max —
//    unbounded cache cardinality (pollution/DoS vector);
//  - fetchProducts / fetchPopularProducts: the home page already bounds
//    them behind ISR (revalidate 60);
//  - everything in app/api/*, admin, checkout, orders, payments: private,
//    personalized or rate-limited surfaces.
// ---------------------------------------------------------------------------

export const CATALOG_DICTIONARY_TTL_SECONDS = 120;
export const CATALOG_PUBLIC_READ_TTL_SECONDS = 60;

/** Shared tag so a future importer hook can revalidateTag() targeted. */
const CATALOG_PUBLIC_CACHE_TAG = 'catalog-public-reads';

/**
 * Wrap a public, user-independent read in unstable_cache. The wrapper is
 * created lazily on first call (no request context needed for creation,
 * only for invocation). Exported for the cache-wiring tests; do not use
 * for anything user-specific.
 */
export function cachePublicRead<TArgs extends unknown[], TResult>(
  keyPrefix: string,
  revalidateSeconds: number,
  fn: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  let wrapped: ((...args: TArgs) => Promise<TResult>) | null = null;
  return async (...args: TArgs): Promise<TResult> => {
    if (wrapped === null) {
      wrapped = unstable_cache(fn, [keyPrefix], {
        revalidate: revalidateSeconds,
        tags: [CATALOG_PUBLIC_CACHE_TAG],
      });
    }
    return wrapped(...args);
  };
}

export interface ProductImage {
  id: string;
  product_id: string;
  image_url: string;
  alt?: string | null;
  sort_order?: number;
  is_main?: boolean;
  created_at: string;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  name: string;
  sku?: string | null;
  price: number;
  old_price?: number | null;
  stock_quantity: number;
  availability_status: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  category_id?: string | null;
  brand_id?: string | null;
  sku: string;
  name: string;
  slug: string;
  short_description?: string | null;
  description?: string | null;
  /** Supplier characteristics as [{name,value}] pairs (JSONB array, order preserved). */
  specifications?: { name: string; value: string }[] | null;
  price: number;
  old_price?: number | null;
  currency: string;
  stock_quantity: number;
  availability_status: string;
  is_active: boolean;
  is_featured: boolean;
  /** Admin-curated «Обрані товари» home section — independent of is_featured. */
  is_selected: boolean;
  created_at: string;
  updated_at: string;
  images: ProductImage[];
  category?: Category | null;
  brand?: Brand | null;
  variants: ProductVariant[];
}

export interface Category {
  id: string;
  parent_id?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  image?: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Brand {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  logo?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Storefront reads run with the publishable key as the anonymous role,
// so visibility is decided entirely by the existing RLS policies.
// The service role key must never be used here.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { persistSession: false } }
);

/**
 * Storefront eligibility policy (F2 UX): a product is shown only when it
 * has at least one photo. Supplier imports that lack content arrive with
 * zero product_images rows — exactly the cards that rendered
 * «Фото відсутнє» / «Опис відсутній». Absence of images is the precise,
 * durable proxy for "no imported content": it hides the 192 placeholder
 * products without hiding the ~700 normal products whose supplier simply
 * shipped no description text. When the importer later fills them, they
 * reappear automatically.
 *
 * `!inner` turns the images embed into an inner join, excluding imageless
 * products from every storefront read built on this constant (catalog,
 * search, category/brand filters, featured, direct slug → 404).
 * Verified live: PostgREST does NOT inflate count=exact for this join
 * (4131 == distinct products-with-images), and pagination stays per
 * top-level entity. Admin API keeps its own plain SELECT on purpose.
 */
// Since migration 016 there are TWO products→categories relationships
// (legacy FK + junction), so PostgREST needs a disambiguation hint. The
// hint uses the constraint name discovered live via PGRST201 (2026-08-26).
const PRODUCT_SELECT =
  '*, category:categories!products_category_id_fkey(id, name, slug), brand:brands(*), images:product_images!inner(*), variants:product_variants(*)';

/**
 * Slim card projection for /catalog (Task #4, 2026-08-31): ONLY the fields
 * ProductCard and the catalog page actually read. description/specifications/
 * variants and the category embed are dropped — category names come from
 * fetchActiveCategories and body fields are never rendered in the grid.
 * `product_images!inner` is REQUIRED: it is the eligibility join that hides
 * imageless products (same semantics as PRODUCT_SELECT); `sort_order` drives
 * image normalization; `product_id` is required by getMainPublicImageUrl's
 * parameter type. Live-measured ~2.3 KB/product vs ~9.8 KB for PRODUCT_SELECT.
 */
const CATALOG_CARD_SELECT =
  'id, name, slug, price, old_price, currency, availability_status, brand:brands(name), images:product_images!inner(id, product_id, image_url, is_main, sort_order)';

/** Same eligibility join for head-count queries (no row multiplication). */
// NOTE: the junction count embed selects product_id (a real column), NOT id:
// PostgREST resolves `pc.id` against the EMBEDDED table, and selecting
// `, pc:product_categories!inner(id)` made the head-count fail live with
// 42703 "column product_categories_1.id does not exist" (verified 2026-08-26).
const ELIGIBLE_COUNT_SELECT = 'id, images:product_images!inner(id)';
const JUNCTION_COUNT_SELECT = 'id, images:product_images!inner(id), pc:product_categories!inner(product_id)';

// PostgREST embeds a many-to-one relation as an object (or null when the
// FK is unset) and one-to-many relations as arrays — verified against the
// live database. This row type mirrors that raw shape exactly.
type ProductJoinedRow = Omit<
  Product,
  'category' | 'brand' | 'images' | 'variants' | 'pc'
> & {
  category: Category | null;
  brand: Brand | null;
  images: ProductImage[] | null;
  variants: ProductVariant[] | null;
  // Junction rows joined via `pc:product_categories!inner(...)` when the
  // caller filters by category (direct assignments; parents are resolved
  // through collectSubtreeIds in memory). Stripped by normalizeProduct.
  pc?: { category_id: string }[] | null;
};

/**
 * Minimal card row returned by the /catalog projection (Task #4). NOT a
 * full Product: sku, body fields, flags and timestamps are absent at
 * runtime and must not be typed as present.
 */
export interface CatalogCardProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  old_price?: number | null;
  currency: string;
  availability_status: string;
  brand: { name: string } | null;
  images: CatalogCardImage[];
}

/** Card image row — mirrors getMainPublicImageUrl's parameter shape. */
export interface CatalogCardImage {
  id: string;
  product_id: string;
  image_url: string;
  alt?: string | null;
  sort_order?: number;
  is_main?: boolean;
}

type CatalogCardRow = Omit<CatalogCardProduct, 'images'> & {
  images: CatalogCardImage[] | null;
  // Junction rows joined via `pc:product_categories!inner(...)` when the
  // caller filters by category. Stripped by normalizeCatalogCard.
  pc?: { category_id: string }[] | null;
};

/**
 * Row shape of the relevance-ranked data query: the card projection plus the
 * scoring fields (searchRelevanceScore reads name/short_description/sku/
 * yugcontract_id; rankSearchResults ties on created_at/id). Only fetched on
 * the ranked search path — the plain path selects CATALOG_CARD_SELECT, whose
 * rows still satisfy this type (the scoring fields are optional).
 */
type SearchCardRow = CatalogCardRow & SearchRankable;

/** Card variant of normalizeProduct: sorts images, strips the junction embed. */
function normalizeCatalogCard(row: CatalogCardRow): CatalogCardProduct {
  const { pc: _pc, ...rest } = row;
  return {
    ...rest,
    brand: row.brand ?? null,
    images: [...(rest.images ?? [])].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    ),
  };
}

function normalizeProduct(row: ProductJoinedRow): Product {
  const { pc: _pc, ...rest } = row;
  const images = [...(rest.images ?? [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );

  return {
    ...rest,
    category: row.category ?? null,
    brand: row.brand ?? null,
    images,
    variants: row.variants ?? [],
  };
}

async function fetchProducts(options: {
  featuredOnly?: boolean;
  selectedOnly?: boolean;
}): Promise<Product[]> {
  // Full read via paged windows: PostgREST caps ANY single response at
  // 1000 rows, so the previous unbounded select would silently truncate
  // the set once featured/active products exceed that cap. The home page
  // renders the WHOLE returned array — the contract is "all of them".
  // The query chain is rebuilt INSIDE the loop: supabase-js builders
  // accumulate repeated .order() calls (url searchParams append), so a
  // shared builder corrupts ordering on page 2+. `id desc` is a
  // deterministic tiebreaker for bulk-imported rows sharing created_at.
  const products: Product[] = [];
  let from = 0;
  for (;;) {
    const PAGE = 1000; // PostgREST max_rows cap per response
    let query = supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('is_active', true);
    if (options.featuredOnly) {
      query = query.eq('is_featured', true);
    }
    if (options.selectedOnly) {
      query = query.eq('is_selected', true);
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1)
      .returns<ProductJoinedRow[]>();

    if (error) {
      // Never serve a partial set as if it were complete — and never serve
      // an empty set as if the catalog were empty: a data error must reach
      // app/error.tsx (honest failure), not masquerade as "no products".
      throw new Error(`Failed to load products: ${error.message}`);
    }

    const rows = data ?? [];
    products.push(...rows.map(normalizeProduct));
    if (rows.length < PAGE) return products;
    from += PAGE;
  }
}

/**
 * Sanitize a user-supplied search term for use inside a PostgREST `or`
 * expression (`name.ilike.%term%,short_description.ilike.%term%`).
 *
 * Specials are REPLACED with a space (not removed) so word tokens stay
 * separated: "foo,bar" stays searchable as two words. Reserved chars,
 * verified against the LIVE PostgREST (2026-08):
 *   ','  hard parse failure (PGRST100);
 *   '"'  silently swallowed as value-quoting syntax and CORRUPTS the
 *        ilike pattern — a product named `…поварський6" (24010/106)`
 *        was unfindable by its own name;
 *   '(' ')' same silent corruption class;
  *   '%'  ILIKE wildcard — silently broadens matches (searching "100%"
  *        matched everything containing "100");
  *   '*'  PostgREST treats it as a %-synonym in ilike patterns (`q=***`
  *        matched everything);
  *   '_'  ILIKE single-char wildcard — same silent broadening class.
  * Dots, hyphens, apostrophes, colons and any letters/digits are proven
  * safe literals and deliberately preserved. Interior whitespace runs are
  * collapsed so adjacent specials don't leave unmatched gaps.
  */
export function sanitizeSearchTerm(term: string): string {
  return term
    .replace(/[%,()"*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the search filter for /catalog from a raw user query.
 *
 * UX contract (2026-08 audit fix): word ORDER must not matter. Every
 * non-empty sanitized token becomes its own PostgREST `or` expression —
 * `name.ilike.%tok%,short_description.ilike.%tok%,…` — and the caller ANDs
 * the expressions by chaining `.or()` once per token (supabase-js appends
 * a separate `or` query param per call; separate filters intersect).
 *
 * SKU search (P2-1 2026-08-29): each token additionally matches
 * `sku` (`YC-<id>`, verified the only format across all products) and
 * `yugcontract_id` (the supplier article — an existing top-level column,
 * no schema change). Same sanitized token, same ILIKE semantics: case is
 * folded by ILIKE, partial matches fall out naturally, and hyphens are
 * proven-safe literals (see sanitizeSearchTerm), so `YC-7061899` and the
 * bare `7061899` both find the product.
 *
 * Description search (2026-09 UX audit): `description` joins the or-set so
 * a keyword that only appears in the full supplier text finds the product.
 * Description hits rank BELOW name/sku/short-description tiers in
 * searchRelevanceScore, so exact-name matches never lose to a body-text hit.
 *
 * «мультипіч TEFAL» and «TEFAL мультипіч» therefore yield the same
 * condition SET. A single token keeps the legacy single-`or` shape, and an
 * empty/specials-only query yields null (no search filter at all).
 *
 * Injection safety is inherited from sanitizeSearchTerm: no reserved
 * or= grammar character (`,` `"` `(` `)` `%`) can survive inside a
 * pattern value, verified by tests/catalog-search.test.ts.
 */
export function buildSearchConditions(search: string): string[] | null {
  const tokens = searchTokens(search);
  if (tokens.length === 0) return null;
  return tokens.map(
    (token) =>
      `name.ilike.%${token}%,short_description.ilike.%${token}%,description.ilike.%${token}%,sku.ilike.%${token}%,yugcontract_id.ilike.%${token}%`
  );
}

/**
 * Tokenize a raw search string EXACTLY as buildSearchConditions does:
 * sanitize, split on spaces, dedupe, cap the fan-out. Each token becomes an
 * `or` expression on the count AND the data query, so an absurdly long `q=`
 * must not multiply ILIKE cost without bound. Ten tokens is far beyond any
 * meaningful storefront query. The relevance scorer reuses this so it always
 * sees the same token set the conditions matched the rows with.
 */
function searchTokens(search: string): string[] {
  const sanitized = sanitizeSearchTerm(search);
  if (!sanitized) return [];
  return [...new Set(sanitized.split(' ').filter(Boolean))].slice(0, 10);
}

// ---- Typo-tolerance fallback (Task #40) -----------------------------------
//
// When a search returns zero results (e.g. «блендерр» instead of «блендер»),
// we retry with progressively relaxed terms: each retry drops the LAST
// character of the currently-longest trimmable token, CUMULATIVELY (the
// same token keeps shrinking across retries until it hits the floor).
// Constraints:
//   - Only triggered when the original query matched zero rows.
//   - Tokens are never shortened below FALLBACK_MIN_TOKEN_LEN — short stems
//     like «чай» → «ча» would match far too broadly.
//   - Retry budget is capped (FALLBACK_MAX_RETRIES) so a pathological query
//     can't turn into a request storm.
//   - Each retry changes exactly ONE character. Progressive (cumulative)
//     trimming matters because 1-edit fuzzy variants cannot bridge
//     multi-edit typos in word FORM: verified on production data
//     (2026-09-05), «сковоротка» has zero 1-edit neighbors among product
//     names («сковорода» differs by 2 edits), but its stem «сковоро»
//     matches 252 eligible products on the third retry.
//   - Injection safety is inherited from sanitizeSearchTerm because
//     variants are re-fed through buildSearchConditions.
export const FALLBACK_MIN_TOKEN_LEN = 4;
export const FALLBACK_MAX_RETRIES = 3;

/**
 * PURE: given a raw search string, yield progressively relaxed variants.
 * Each retry trims the LAST character of ONE token; the token is picked by
 * (fewest prior trims → longest → earliest), so the ladder is BREADTH-first
 * across tokens (every token gets one trim before any gets a second —
 * multi-typo queries keep testing their second token) and then DEEP-first
 * on the same token (a single long token keeps shrinking across retries —
 * «сковоротка» reaches the stem «сковоро», which is the only production
 * bridge to the 252 «сковоро*» products; 1-edit fuzzy variants cannot get
 * there, SQL-verified 2026-09-05). Yields at most FALLBACK_MAX_RETRIES
 * variants; stops early when no token remains above FALLBACK_MIN_TOKEN_LEN.
 * Output depends purely on the input; callers must re-run the output
 * through buildSearchConditions (which re-sanitizes) before use.
 */
export function relaxSearchTerm(search: string): string[] {
  const work = [
    ...new Set(sanitizeSearchTerm(search).split(' ').filter(Boolean)),
  ];
  const trims = new Array<number>(work.length).fill(0);
  const out: string[] = [];
  for (let retry = 0; retry < FALLBACK_MAX_RETRIES; retry += 1) {
    let best = -1;
    for (let i = 0; i < work.length; i += 1) {
      const len = work[i]?.length ?? 0;
      if (len <= FALLBACK_MIN_TOKEN_LEN) continue;
      if (best === -1) {
        best = i;
        continue;
      }
      const bestTrims = trims[best] ?? 0;
      const bestLen = work[best]?.length ?? 0;
      const iTrims = trims[i] ?? 0;
      if (iTrims < bestTrims || (iTrims === bestTrims && len > bestLen)) {
        best = i;
      }
    }
    if (best === -1) break;
    const token = work[best];
    if (token === undefined) break;
    work[best] = token.slice(0, -1);
    trims[best] = (trims[best] ?? 0) + 1;
    out.push(work.join(' '));
  }
  return out;
}

// ---- Fuzzy typo fallback (Phase 1, 2026-09-04; Phase 2, 2026-09-05) --------
//
// Second tier of the zero-result fallback, AFTER the trim ladder above:
// when the original query AND every trim variant matched zero rows, we probe
// once with 1-edit fuzzy candidates per token:
//   - keyboard-layout remap (QWERTY ↔ ЙЦУКЕН) — «ktylth» → «лендер»;
//   - single-char deletion at ANY position — «бленддер» → «блендер»;
//   - adjacent-char transposition — «блендре» → «блендер»;
//   - one-char ILIKE gap «_» — «блндер» → «бл_ндер» matches «блендер»
//     (covers a MISSING letter, which deletion/transposition cannot);
//   - interior substitution «_» (Phase 2) — «сковоротка» → «сковоро_ка»
//     matches «сковородка» (covers a WRONG letter of the same word length,
//     which no other kind reaches: deletions/gaps change the pattern length
//     and transpositions keep both original letters).
//
// Invariants:
//   - tokens shorter than FALLBACK_MIN_TOKEN_LEN are never fuzzied;
//   - ONE extra count request total: per token, a single or= value OR-ing
//     [original, ...variants]; tokens AND together exactly like
//     buildSearchConditions. The probe count REPLACES the search conditions
//     for BOTH the count and the data query, so total/pagination stay
//     consistent by construction (no per-variant retry storm);
//   - `appliedSearch` is identified afterwards in JS from the actually
//     returned rows (per token: first emitted candidate that matches);
//   - deterministic emission: round 0 is every token's original, then
//     round-robin over each token's kind-fair positional variant list
//     (per position: deletion → transposition → gap → substitution), with
//     the layout remap emitted first. Position-major interleaving is
//     deliberate: with ANY cap, block-ordered kinds let early kinds
//     displace later ones (under the old flat 32-candidate cap a ≥8-char
//     token never emitted a single substitution);
//   - the probe is bounded by an encoded-URL byte budget
//     (FALLBACK_FUZZY_URL_BUDGET_BYTES), NOT a candidate count — the real
//     constraint is the request URL / response-header limit, which scales
//     with bytes, not with candidate count. Measured live (2026-09-05):
//     an encoded or= of 8017 bytes succeeds, 10085 bytes already fails
//     (undici "fetch failed", UND_ERR_HEADERS_OVERFLOW on PostgREST's
//     Content-Location echo) — so the old 32-candidate × 4-field shape
//     (~15.9 KB for a 17-char Cyrillic token) broke the probe entirely;
//   - injection safety: candidates originate from sanitizeSearchTerm output
//     (no , " ( ) % possible), mutations add only letters or a single `_`
//     (an ILIKE single-char wildcard — deliberately scoped here; it is
//     rejected in USER input by sanitizeSearchTerm but generated
//     intentionally at a known interior position), and every candidate is
//     re-checked against the reserved-char class before use.
// Worst case request budget on a zero-result query: 1 original count +
// FALLBACK_MAX_RETRIES trim counts + 1 fuzzy probe + 1 data query = 6
// (unchanged from Phase 1 — the probe is still ONE request).
// ---------------------------------------------------------------------------
export const FALLBACK_FUZZY_URL_BUDGET_BYTES = 8000;

/** ILIKE/or= grammar characters that must never appear inside a candidate. */
const FUZZY_RESERVED = /[,"()%]/;

// Standard ЙЦУКЕН key positions, Ukrainian layout («і» on the s key).
// Used in BOTH directions: latin garbage → cyrillic («ktylth» → «лендер»)
// and cyrillic-typed brand names → latin («ЕУАФД» → «tefal»).
const QWERTY_TO_CYR: Record<string, string> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з',
  a: 'ф', s: 'і', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь',
};
const CYR_TO_QWERTY: Record<string, string> = {};
for (const [lat, cyr] of Object.entries(QWERTY_TO_CYR)) {
  CYR_TO_QWERTY[cyr] = lat;
}
// ru-layout tolerance on the reverse direction («ы» sits on the s key).
CYR_TO_QWERTY['ы'] = 's';

/**
 * PURE: remap a whole token across keyboard layouts (QWERTY ↔ ЙЦУКЕН).
 * Returns null when ANY character is unmappable (digits, punctuation,
 * Ukrainian є/ї/ґ, mixed scripts) or the mapping is the identity — a
 * partial remap would fabricate garbage candidates.
 */
export function mapKeyboardLayout(token: string): string | null {
  if (!token) return null;
  let out = '';
  for (const ch of token) {
    const lower = ch.toLowerCase();
    const mapped = QWERTY_TO_CYR[lower] ?? CYR_TO_QWERTY[lower];
    if (mapped === undefined) return null;
    out += mapped;
  }
  const lowerToken = token.toLowerCase();
  return out === lowerToken ? null : out;
}

/**
 * PURE: fuzzy 1-edit variants of ONE token (never the token itself, never
 * below FALLBACK_MIN_TOKEN_LEN). Emission is KIND-FAIR and position-major:
 * the layout remap first, then one round per position — per position
 * (deletion, transposition, gap, substitution, in that relative kind order),
 * skipping the kinds invalid at that position. Under any prefix cap every
 * kind is therefore represented after the first few positions; a
 * block-ordered layout (all deletions, then all transpositions, …) would let
 * earlier kinds displace later ones. Candidates that would carry or=/ILIKE
 * grammar characters (e.g. a layout remap of «б», whose key IS the comma)
 * are dropped, not escaped.
 *
 * Position rules (both wildcards are the single-char ILIKE `_`):
 *   - gap inserts an extra `_` BEFORE position i, i ≥ 1 (leading/trailing
 *     gaps would only re-test deletions);
 *   - substitution REPLACES the char at position i with `_`, interior
 *     positions only (1 ≤ i ≤ len-2): under ILIKE substring semantics the
 *     position-0 substitution is subsumed by the position-0 deletion
 *     (%Xrest% ⇒ contains rest) and the last-position substitution by the
 *     last-position deletion (%prec% ⇒ contains pre) — interior ones are
 *     the only genuinely new coverage («блендар» → «бленд_р» → «блендер»).
 */
export function fuzzyTokenVariants(token: string): string[] {
  if (token.length < FALLBACK_MIN_TOKEN_LEN) return [];
  const seen = new Set<string>([token]);
  const out: string[] = [];
  const push = (variant: string): void => {
    if (!seen.has(variant) && !FUZZY_RESERVED.test(variant)) {
      seen.add(variant);
      out.push(variant);
    }
  };

  const mapped = mapKeyboardLayout(token);
  if (mapped) push(mapped);

  for (let i = 0; i < token.length; i += 1) {
    push(token.slice(0, i) + token.slice(i + 1));
    if (i + 1 < token.length) {
      push(
        token.slice(0, i) +
          token.charAt(i + 1) +
          token.charAt(i) +
          token.slice(i + 2)
      );
    }
    if (i >= 1) {
      push(`${token.slice(0, i)}_${token.slice(i)}`);
    }
    if (i >= 1 && i <= token.length - 2) {
      push(`${token.slice(0, i)}_${token.slice(i + 1)}`);
    }
  }
  return out;
}

export interface FuzzyFallbackPlan {
  /** Sanitized, deduped, fan-out-capped tokens of the original query. */
  tokens: string[];
  /**
   * Emitted candidates in probe/identification order — round 0 is every
   * token's original, then round-robin over the per-token kind-fair variant
   * lists, bounded by the encoded-URL byte budget (not a candidate count).
   */
  candidates: { tokenIndex: number; variant: string }[];
  /**
   * One or= value per token: OR over that token's emitted candidates
   * (a token with no variants degrades to the exact 2-field probe shape).
   * Caller chains .or() once per entry — same AND semantics.
   */
  conditions: string[];
}

/**
 * Fuzzy probe fields. Deliberately limited to `name` + `short_description`
 * (Phase 1 already dropped `description`; Phase 2 also drops
 * `sku`/`yugcontract_id`). Two constraints trade off against each other:
 *   - the encoded or= size must stay under FALLBACK_FUZZY_URL_BUDGET_BYTES
 *     (measured live: ≥~10KB breaks the probe — see the section comment);
 *   - CANDIDATE coverage must stay wide: a missing variant is a missed
 *     correction, while SKU/supplier-article fuzzy matching has negligible
 *     real-world yield (SKUs are `YC-<digits>`; the exact and trim-ladder
 *     paths keep all five fields, and the probe only runs after BOTH
 *     already returned zero — so the user's exact SKU spelling has failed).
 * Two fields halve the per-candidate byte cost and double how many variants
 * survive the budget. `fuzzyVariantMatchesRow` mirrors this field set.
 */
const FUZZY_PROBE_FIELDS = ['name', 'short_description'] as const;

/**
 * Encoded-URL cost of adding ONE candidate to the probe: supabase-js
 * URL-encodes each or= value with encodeURIComponent (commas become `%2C`,
 * the ILIKE `%` becomes `%25`), and PostgREST echoes the request URL back
 * in the Content-Location response header — so the encoded length is
 * exactly what the response-header budget pays for.
 */
function fuzzyPredicateCost(variant: string): number {
  // each predicate gets one encoded ',' separator before it (the very last
  // one is unused, so the model is conservatively 3 bytes over per token)
  let cost = encodeURIComponent(',').length * FUZZY_PROBE_FIELDS.length;
  for (const field of FUZZY_PROBE_FIELDS) {
    cost += encodeURIComponent(`${field}.ilike.%${variant}%`).length;
  }
  return cost;
}

function fuzzyOrCondition(variants: string[]): string {
  const preds: string[] = [];
  for (const field of FUZZY_PROBE_FIELDS) {
    for (const variant of variants) {
      preds.push(`${field}.ilike.%${variant}%`);
    }
  }
  return preds.join(',');
}

/**
 * PURE: build the batched fuzzy probe for a raw search string. Returns null
 * when NO token produced variants (nothing to fuzz — e.g. all tokens below
 * the floor) or when even the originals cannot fit the URL budget (skip the
 * probe rather than emit an oversized request). Round 0 — every token's
 * original — is emitted UNCONDITIONALLY: it keeps intact tokens' exact match
 * semantics inside the probe and guarantees each token's or= value is never
 * empty. Variants are then added round-robin across tokens (one candidate
 * per token per round) until the next candidate would overflow
 * FALLBACK_FUZZY_URL_BUDGET_BYTES; emission stops there (later, cheaper
 * candidates are not substituted back — keeps the emission deterministic
 * and kind-fair).
 */
export function buildFuzzyFallbackPlan(search: string): FuzzyFallbackPlan | null {
  const tokens = [
    ...new Set(sanitizeSearchTerm(search).split(' ').filter(Boolean)),
  ].slice(0, 10);
  const perToken = tokens.map((t) => [t, ...fuzzyTokenVariants(t)]);
  if (perToken.every((list) => list.length === 1)) return null;

  const candidates: { tokenIndex: number; variant: string }[] = [];
  let usedBytes = 0;
  for (let i = 0; i < perToken.length; i += 1) {
    const original = perToken[i]?.[0];
    if (original === undefined) continue;
    candidates.push({ tokenIndex: i, variant: original });
    usedBytes += fuzzyPredicateCost(original);
  }
  if (usedBytes > FALLBACK_FUZZY_URL_BUDGET_BYTES) return null;

  const maxRounds = Math.max(...perToken.map((list) => list.length));
  outer: for (let round = 1; round < maxRounds; round += 1) {
    for (let i = 0; i < perToken.length; i += 1) {
      const variant = perToken[i]?.[round];
      if (variant === undefined) continue;
      const cost = fuzzyPredicateCost(variant);
      if (usedBytes + cost > FALLBACK_FUZZY_URL_BUDGET_BYTES) break outer;
      usedBytes += cost;
      candidates.push({ tokenIndex: i, variant });
    }
  }

  const conditions = perToken.map((_, i) =>
    fuzzyOrCondition(
      candidates
        .filter((c) => c.tokenIndex === i)
        .map((c) => c.variant)
    )
  );
  return { tokens, candidates, conditions };
}

/**
 * PURE: the JS-side regex for one wildcard candidate — each ILIKE «_» maps
 * to EXACTLY ONE unknown character (`.`), everything else is a literal. The
 * pattern never contains quantifiers, so EVERY match of this regex has
 * exactly the candidate's own length — a recovered display word (see
 * recoverWildcardDisplay) is by construction a same-length substring of a
 * row field, never a longer/shorter artifact. Non-global form: a stateless
 * `.test()` predicate (a global regex would carry `lastIndex` between calls).
 */
function wildcardVariantRegExp(variant: string, global: boolean): RegExp {
  const pattern = variant
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/_/g, '.');
  return new RegExp(pattern, global ? 'gi' : 'i');
}

/** JS-side ILIKE semantics for one candidate against one fetched row.
 *  Mirrors FUZZY_PROBE_FIELDS (no description/sku — see there). */
function fuzzyVariantMatchesRow(variant: string, row: SearchRankable): boolean {
  const fields = [row.name, row.short_description];
  if (variant.includes('_')) {
    const re = wildcardVariantRegExp(variant, false);
    return fields.some((f) => typeof f === 'string' && re.test(f));
  }
  const needle = variant.toLowerCase();
  return fields.some(
    (f) => typeof f === 'string' && f.toLowerCase().includes(needle)
  );
}

/**
 * PURE: recover the REAL word a wildcard candidate matched, from the rows
 * the probe returned. The candidate's own regex (wildcardVariantRegExp — the
 * exact semantics that selected it) is re-run over the same fields the probe
 * matched (name, short_description — mirrors FUZZY_PROBE_FIELDS) and every
 * matched substring is a recovered word. Each match has EXACTLY the
 * candidate's length (one `.` per «_`, no quantifiers — see
 * wildcardVariantRegExp), so the result is a same-length real catalog word
 * (e.g. «сковоро_ка» over «Електросковородка…» → «сковородка»), lowercased
 * to read like the (typically lowercase) search term the notice renders.
 *
 * Choice among several DIFFERENT recovered words: the MOST FREQUENT one
 * wins — a word counts once per row, so a row repeating it in name +
 * description cannot outweigh other rows; ties keep the word seen FIRST in
 * row order. Rationale (vs plain first-occurrence): in a homogeneous
 * catalog every matched row holds the same word and frequency degenerates
 * to first-occurrence, but when rows disagree (a stray brand or a compound
 * word hit the same gap pattern) the word the majority of the result page
 * actually shows is the better hint — and the choice is independent of the
 * probe's row ordering, with first-seen order as the deterministic
 * tie-break. Deterministic for a given rows array; no I/O.
 *
 * Returns null when nothing matches (a probe/data race, rows fetched
 * through a different filter set) — identifyAppliedSearch falls back to the
 * honest wildcard candidate; it never returns a wrong word.
 */
export function recoverWildcardDisplay(
  variant: string,
  rows: SearchRankable[]
): string | null {
  if (!variant.includes('_')) return null;
  const re = wildcardVariantRegExp(variant, true);
  const counts = new Map<string, { count: number; first: number }>();
  let seen = 0;
  for (const row of rows) {
    const fields = [row.name, row.short_description];
    const rowWords = new Set<string>();
    for (const field of fields) {
      if (typeof field !== 'string') continue;
      for (const match of field.matchAll(re)) {
        rowWords.add(match[0].toLowerCase());
      }
    }
    for (const word of rowWords) {
      const entry = counts.get(word);
      if (entry) entry.count += 1;
      else counts.set(word, { count: 1, first: seen++ });
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  let bestFirst = Number.POSITIVE_INFINITY;
  for (const [word, { count, first }] of counts) {
    if (count > bestCount || (count === bestCount && first < bestFirst)) {
      best = word;
      bestCount = count;
      bestFirst = first;
    }
  }
  return best;
}

/**
 * PURE: derive the user-facing appliedSearch from the probe plan and the
 * rows the probe actually returned. Per token, in order:
 *   1. the original token, when it matches any row, displays verbatim —
 *      even when a longer variant also matches (an intact token must never
 *      be rewritten into a wildcard form);
 *   2. otherwise the LONGEST emitted candidate matching any row wins: a
 *      deletion/stem candidate is shorter than the full word it came from
 *      («ендер» vs «б_ендер»), so length is the best readability proxy
 *      among matched candidates — the notice keeps a human-readable term;
 *   3. equal lengths prefer the LITERAL candidate (no ILIKE «_») over the
 *      wildcard one: a literal and a wildcard of the same length can both
 *      match rows (the substitution «te_la» hits «tesla» while the
 *      transposition «tefal» hits «tefal»), and the plain word is the more
 *      readable, intended display;
 *   4. same length and same wildcard-ness keep the EARLIEST emitted
 *      candidate (emission order = likelihood order — the same tie-break
 *      the old first-match rule used);
 *   5. a WILDCARD winner (contains ILIKE «_») is finally rewritten into the
 *      REAL word it matched: the candidate's own regex is re-run over the
 *      same rows and the most frequent recovered word displays instead
 *      (recoverWildcardDisplay). The probe CONDITIONS keep the wildcard —
 *      only the notice term becomes human-readable («бл_ндер» → «блендер»);
 *      when recovery finds no match (probe/data race) the raw wildcard
 *      stays, so the display is never null and never fabricated.
 * Returns null when every token kept its original (probe rows should always
 * match at least one non-original candidate, but a data race between the
 * probe and the data query degrades to "no notice", never to wrong
 * conditions).
 */
export function identifyAppliedSearch(
  rows: SearchRankable[],
  plan: FuzzyFallbackPlan
): string | null {
  const display = plan.tokens.slice();
  let changed = false;
  plan.tokens.forEach((token, i) => {
    if (rows.some((row) => fuzzyVariantMatchesRow(token, row))) return;
    let best: string | null = null;
    for (const candidate of plan.candidates) {
      const variant = candidate.variant;
      if (candidate.tokenIndex !== i) continue;
      if (best !== null) {
        // Strictly-longer first: candidates arrive in emission order, so
        // among the longest matches this keeps the EARLIEST one — except at
        // equal length the LITERAL (no «_») form displaces a wildcard: both
        // are 1-edit variants of the token, and when both match, the plain
        // word is the more readable display. Same wildcard-ness keeps the
        // earliest emitted candidate (rule 4 in the docstring).
        if (variant.length < best.length) continue;
        if (
          variant.length === best.length &&
          (best.indexOf('_') === -1 || variant.indexOf('_') !== -1)
        ) {
          continue;
        }
      }
      if (rows.some((row) => fuzzyVariantMatchesRow(variant, row))) {
        best = variant;
      }
    }
    if (best !== null) {
      // Rule 5: a wildcard winner is technical ILIKE syntax — recover the
      // real word it matched from the same rows so the notice reads like
      // the user's word. Recovery reuses the candidate's match semantics,
      // so a selected wildcard always has ≥1 recoverable match here; null
      // (a probe/data race) keeps the honest wildcard form.
      display[i] = recoverWildcardDisplay(best, rows) ?? best;
      changed = true;
    }
  });
  return changed ? display.join(' ') : null;
}

// ---- Search relevance ranking (2026-09 audit, search C1) -------------------
//
// PostgREST can only ORDER BY columns — there is no expression ordering and
// this project deliberately adds no RPC/extension, so relevance is computed
// in JS over the matched rows. The match SET is unchanged (same or=
// conditions as the count query); only the ORDER of the default «нові»
// search view changes, because created_at ordering surfaced the newest
// imports instead of the best textual matches.

/**
 * Hard cap on rows scanned for relevance ranking. The ranked data query
 * fetches up to this many matched rows in ONE request (PostgREST caps a
 * single response at 1000 rows anyway), ranks them and slices the page in
 * JS. Searches matching more rows than the cap keep the plain SQL ordering
 * (deterministic created_at desc, id desc) instead of ranking a truncated
 * set — at that width the match quality is nearly uniform anyway.
 */
export const SEARCH_RANK_SCAN_LIMIT = 1000;

/** Fields the ranking reads; a superset of the catalog card projection. */
export interface SearchRankable {
  id: string;
  name: string;
  short_description?: string | null;
  description?: string | null;
  sku?: string | null;
  yugcontract_id?: string | null;
  created_at?: string | null;
}

/**
 * PURE: relevance of one row for one search term — higher wins. Weights are
 * spaced so the tiers can never overlap (a stronger tier always dominates
 * every combination of weaker ones):
 *   exact name (800) > name prefix (600) > name contains the query (400)
 *   > per-token name hits (100 each, +50 when every token hits)
 *   > SKU / supplier-article match (60 full, 30 per token)
 *   > short-description hits (10 each) > description hits (5 each).
 * Matching semantics mirror the ILIKE conditions that matched the row:
 * case-folded substring containment. The raw URL term is re-sanitized here,
 * so special characters can never widen or corrupt the scoring.
 */
export function searchRelevanceScore(
  row: SearchRankable,
  search: string
): number {
  const query = sanitizeSearchTerm(search).toLowerCase();
  if (!query) return 0;
  // ILIKE folds case, the DB matched case-insensitively — the scorer must
  // fold too, and re-dedupe AFTER folding («Tefal tefal» is one token).
  const tokens = [...new Set(searchTokens(search).map((t) => t.toLowerCase()))];
  const name = (row.name ?? '').toLowerCase();
  const shortDescription = (row.short_description ?? '').toLowerCase();
  const description = (row.description ?? '').toLowerCase();
  const sku = (row.sku ?? '').toLowerCase();
  const yugcontractId = (row.yugcontract_id ?? '').toLowerCase();

  let score = 0;
  if (name === query) score += 800;
  if (name.startsWith(query)) score += 600;
  if (name.includes(query)) score += 400;

  const nameHits = tokens.filter((token) => name.includes(token)).length;
  score += nameHits * 100;
  if (tokens.length > 1 && nameHits === tokens.length) score += 50;

  if (sku.includes(query) || yugcontractId.includes(query)) score += 60;
  score +=
    tokens.filter((t) => sku.includes(t) || yugcontractId.includes(t)).length *
    30;

  score +=
    tokens.filter((token) => shortDescription.includes(token)).length * 10;

  score += tokens.filter((token) => description.includes(token)).length * 5;
  return score;
}

/**
 * PURE: order matched rows by relevance (best first). Ties keep the SQL base
 * order — created_at desc, then id desc, the exact deterministic order the
 * un-ranked view used — so pagination never overlaps. Returns a new array;
 * the input is not mutated.
 */
export function rankSearchResults<T extends SearchRankable>(
  rows: T[],
  search: string
): T[] {
  const scored = rows.map((row) => ({
    row,
    score: searchRelevanceScore(row, search),
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const aAt = a.row.created_at ?? '';
    const bAt = b.row.created_at ?? '';
    if (aAt !== bAt) return aAt < bAt ? 1 : -1; // newer first
    if (a.row.id !== b.row.id) return a.row.id < b.row.id ? 1 : -1; // id desc
    return 0;
  });
  return scored.map((entry) => entry.row);
}

export type CatalogSort = 'newest' | 'price_asc' | 'price_desc' | 'name_asc';

export interface CatalogFilters {
  categorySlug?: string;
  brandSlug?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort?: CatalogSort;
  page?: number;
  /** page size for the catalog grid (server-enforced cap) */
  size?: number;
}

export const CATALOG_PAGE_SIZE = 12;
const CATALOG_MAX_PAGE_SIZE = 50;

/**
 * Resolve a category/brand slug to its UUID. Catalog filters target plain
 * FK columns (category_id/brand_id) instead of PostgREST embedded-resource
 * filters: embed filters require the embed in `select`, and without
 * `!inner` they degrade to left-join semantics that keep non-matching
 * rows (verified against the live database 2026-08). Returns null when
 * the slug does not exist.
 *
 * Perf audit Step 3 (2026-08-28): the slug lookups are React `cache()`d —
 * generateMetadata and the page render resolve the SAME slug through ONE
 * request per render instead of duplicated reads (per-request memo only;
 * nothing is cached across requests).
 * Caching step 2 (2026-08-31): wrapped in unstable_cache (60s) UNDER the
 * React cache() — cross-request Data Cache for hot slug lookups.
 */
const fetchCategoryBySlugStore = cachePublicRead(
  'catalog:category-slug',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  fetchCategoryBySlugUncached
);
const lookupCategoryBySlugCached = cache(fetchCategoryBySlugStore);
const fetchBrandBySlugStore = cachePublicRead(
  'catalog:brand-slug',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  fetchBrandBySlugUncached
);
const lookupBrandBySlugCached = cache(fetchBrandBySlugStore);

async function findCategoryIdBySlug(slug: string): Promise<string | null> {
  return (await lookupCategoryBySlugCached(slug))?.id ?? null;
}

async function findBrandIdBySlug(slug: string): Promise<string | null> {
  return (await lookupBrandBySlugCached(slug))?.id ?? null;
}

/**
 * Light slug → display-name lookups for UI chrome (filter chips, H1,
 * generateMetadata). Single indexed selects; return null for unknown or
 * inactive slugs.
 */
async function fetchCategoryBySlugUncached(
  slug: string
): Promise<{ id: string; name: string; slug: string } | null> {
  const { data } = await supabase
    .from('categories')
    .select('id, name, slug')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  return data ?? null;
}

async function fetchBrandBySlugUncached(
  slug: string
): Promise<{ id: string; name: string; slug: string } | null> {
  const { data } = await supabase
    .from('brands')
    .select('id, name, slug')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  return data ?? null;
}

export const fetchCategoryBySlug = lookupCategoryBySlugCached;
export const fetchBrandBySlug = lookupBrandBySlugCached;
export interface CatalogPage {
  products: CatalogCardProduct[];
  total: number;
  page: number;
  size: number;
  /**
   * Set ONLY when the zero-result typo fallback rewrote the search term
   * (e.g. user typed «блендерр», we searched «блендер» instead).
   * Null/undefined means results come from the user's original query.
   */
  appliedSearch?: string | null;
}

/**
 * Paginated variant used by /catalog. Same filtering as above; returns the
 * total matching count so the UI can render real pagination. Out-of-range
 * pages are clamped to the last valid one.
 */
export async function fetchCatalogProducts(
  filters: CatalogFilters = {}
): Promise<CatalogPage> {
  const size = Math.min(
    Math.max(filters.size ?? CATALOG_PAGE_SIZE, 1),
    CATALOG_MAX_PAGE_SIZE
  );

  // ---- shared filter inputs (computed once, reused by both queries) ----
  // One `or` expression per token; the caller chains .or() per item so the
  // tokens AND together (word-order-independent search, see the helper).
  let searchConditions = buildSearchConditions(filters.search ?? '');
  // Search term actually applied. Null while the user's own query is in
  // effect; set to the relaxed term when the zero-result typo fallback
  // (below) rewrites it — the UI shows «Показані результати для ...».
  let appliedSearch: string | null = null;

  const [categoryId, brandId] = await Promise.all([
    filters.categorySlug ? findCategoryIdBySlug(filters.categorySlug) : null,
    filters.brandSlug ? findBrandIdBySlug(filters.brandSlug) : null,
  ]);

  // Unknown category/brand slug → nothing can match; skip the queries.
  if ((filters.categorySlug && categoryId === null) ||
      (filters.brandSlug && brandId === null)) {
    return { products: [], total: 0, page: 1, size };
  }

  // Multi-category model (2026-08-26): products match a category through
  // product_categories DIRECT assignments; selecting any parent pulls in
  // every descendant via in-memory subtree expansion over the already
  // fetched active list (one dictionary read per catalog page, no N+1).
  // The legacy products.category_id holds only the default assignment, so
  // filtering by it would miss multi-assigned products.
  let subtreeIds: string[] = [];
  if (categoryId) {
    const activeCategories = await fetchActiveCategories();
    subtreeIds = Array.from(collectSubtreeIds(activeCategories, categoryId));
  }

  // ---- total count with identical filters (no pagination) ----
  // The eligibility join MUST mirror PRODUCT_SELECT, otherwise totals
  // would count imageless products that the data query can never return.
  // Built via a factory so the typo fallback can rebuild the SAME count
  // query with RELAXED conditions (replacing, not adding to, the original
  // search terms) without duplicating filter wiring.
  const buildCountQuery = (conditions: string[] | null) => {
    let q = supabase
      .from('products')
      .select(categoryId ? JUNCTION_COUNT_SELECT : ELIGIBLE_COUNT_SELECT, {
        count: 'exact',
        head: true,
      })
      .eq('is_active', true);

    if (categoryId) {
      q = q.in('pc.category_id', subtreeIds);
    }
    if (brandId) {
      q = q.eq('brand_id', brandId);
    }

    if (conditions) {
      for (const condition of conditions) {
        q = q.or(condition);
      }
    }

    if (filters.minPrice !== undefined) {
      q = q.gte('price', filters.minPrice);
    }
    if (filters.maxPrice !== undefined) {
      q = q.lte('price', filters.maxPrice);
    }
    if (filters.inStockOnly) {
      q = q.eq('availability_status', 'in_stock');
    }
    return q;
  };

  const { count, error: countError } = await buildCountQuery(searchConditions);
  if (countError) {
    // Same honesty contract as the data query below: a transient count
    // failure must reach app/error.tsx, not render an empty catalog that
    // reads as "the shop has no products".
    throw new Error(`Failed to count catalog products: ${countError.message}`);
  }

  let total = count ?? 0;

  // ---- typo fallback (Task #40): only when the ORIGINAL query matched zero
  // rows. Progressively drop the LAST character of ONE token (longest first)
  // until a non-zero count appears or the retry budget / min-length floor is
  // hit. Same ILIKE grammar, same sanitized tokens — no new operators, no new
  // API. A fallback hit records `appliedSearch` so the UI can tell the user
  // which term actually produced the results.
  if (total === 0 && searchConditions) {
    for (const relaxedTerm of relaxSearchTerm(filters.search ?? '')) {
      const relaxedConditions = buildSearchConditions(relaxedTerm);
      if (!relaxedConditions) continue;

      // The retry REPLACES the original search conditions entirely —
      // chaining them on top would keep the unmatched term in the AND
      // tree and pin the count to zero forever.
      const { count: retryCount, error: retryError } =
        await buildCountQuery(relaxedConditions);
      if (retryError) {
        console.error(
          'Failed to count catalog products (fallback):',
          retryError.message
        );
        break;
      }
      if ((retryCount ?? 0) > 0) {
        total = retryCount ?? 0;
        searchConditions = relaxedConditions;
        appliedSearch = relaxedTerm;
        break;
      }
    }
  }

  // ---- fuzzy fallback (Phase 1): ONE batched probe, only when the trim
  // ladder ALSO matched zero rows. The probe REPLACES the search conditions
  // for both the count and the data query (same contract as the trim
  // ladder); `appliedSearch` is identified from the fetched rows further
  // below, so no per-variant retry requests exist at all.
  let fuzzyPlan: FuzzyFallbackPlan | null = null;
  if (total === 0 && searchConditions) {
    const plan = buildFuzzyFallbackPlan(filters.search ?? '');
    if (plan) {
      const { count: probeCount, error: probeError } =
        await buildCountQuery(plan.conditions);
      if (probeError) {
        console.error(
          'Failed to count catalog products (fuzzy probe):',
          probeError.message
        );
      } else if ((probeCount ?? 0) > 0) {
        total = probeCount ?? 0;
        searchConditions = plan.conditions;
        fuzzyPlan = plan;
      }
    }
  }

  const maxPage = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(filters.page ?? 1, 1), maxPage);

  // ---- paged data query ----
  // Relevance ranking (2026-09 audit): with an active search and the default
  // «нові» sort (undefined or 'newest' — the sort switch's default branch),
  // matched rows are ranked by match quality instead of raw recency — the
  // newest import is not automatically the best answer. An
  // explicitly chosen sort (price/name) keeps its SQL ordering: the user
  // overrode the default on purpose. The ranked path fetches up to
  // SEARCH_RANK_SCAN_LIMIT rows in one request, ranks them and slices the
  // page in JS; broader searches keep server-side pagination with the plain
  // SQL ordering.
  const rankedSearch =
    searchConditions !== null &&
    (filters.sort === undefined || filters.sort === 'newest') &&
    total <= SEARCH_RANK_SCAN_LIMIT;

  let query = supabase
    .from('products')
    .select(
      (rankedSearch
        ? CATALOG_CARD_SELECT +
          ', short_description, description, sku, yugcontract_id, created_at'
        : CATALOG_CARD_SELECT) +
        (categoryId ? ', pc:product_categories!inner(category_id)' : '')
    )
    .eq('is_active', true);

  if (categoryId) {
    // PostgREST dedups the top-level entities of this one-to-many inner
    // join (same verified behavior as the images!inner eligibility join).
    query = query.in('pc.category_id', subtreeIds);
  }
  if (brandId) {
    query = query.eq('brand_id', brandId);
  }

  if (searchConditions) {
    for (const condition of searchConditions) {
      query = query.or(condition);
    }
  }

  if (filters.minPrice !== undefined) {
    query = query.gte('price', filters.minPrice);
  }
  if (filters.maxPrice !== undefined) {
    query = query.lte('price', filters.maxPrice);
  }
  if (filters.inStockOnly) {
    query = query.eq('availability_status', 'in_stock');
  }

  // Every sort gets `id` as a deterministic tiebreaker: imported rows share
  // created_at timestamps in bulk, and without a unique secondary key
  // Postgres may return ties in different orders per request, which makes
  // pagination overlap. The ranked search path uses the same recency pair as
  // its deterministic BASE order — relevance ties fall back to it in JS.
  if (rankedSearch) {
    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(0, SEARCH_RANK_SCAN_LIMIT - 1);
  } else {
    switch (filters.sort) {
      case 'price_asc':
        query = query.order('price', { ascending: true }).order('id', { ascending: true });
        break;
      case 'price_desc':
        query = query.order('price', { ascending: false }).order('id', { ascending: false });
        break;
      case 'name_asc':
        query = query.order('name', { ascending: true }).order('id', { ascending: true });
        break;
      default:
        // In-stock first (2026-09 UX audit): the storefront's default view
        // must not open on a wall of out-of-stock novelties. The DB only
        // holds 'in_stock'/'out_of_stock' (verified 2026-09), and
        // 'in_stock' < 'out_of_stock' lexicographically, so ascending
        // availability_status IS the in-stock-first contract; each tier
        // keeps the recency ordering.
        query = query
          .order('availability_status', { ascending: true })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });
    }

    query = query.range((page - 1) * size, page * size - 1);
  }

  const { data, error } = await query.returns<SearchCardRow[]>();

  if (error) {
    // A data error must reach app/error.tsx (honest failure) — an empty
    // catalog page would read as "the shop has no products".
    throw new Error(`Failed to load catalog products: ${error.message}`);
  }

  const rows = data ?? [];
  // Fuzzy probe adoption: derive the human-facing appliedSearch from the
  // rows actually returned, BEFORE ranking — the ranked path scores against
  // the adopted term (appliedSearch ?? original), same contract as the trim
  // ladder. The probe CONDITIONS (not the identified term) remain the
  // count/data filter set, so total and pagination never diverge.
  if (fuzzyPlan) {
    appliedSearch = identifyAppliedSearch(rows, fuzzyPlan);
  }
  // Ranked path: rank the full scanned match set (total ≤ cap ⇒ the scan is
  // complete) and slice the requested page in JS. Ties resolve to the same
  // created_at/id order the SQL base ordering produced, so page windows are
  // identical to the un-ranked layout whenever scores tie.
  const products = (
    rankedSearch
      ? rankSearchResults(rows, appliedSearch ?? filters.search ?? '').slice(
          (page - 1) * size,
          page * size
        )
      : rows
  ).map(normalizeCatalogCard);

  return {
    products,
    total,
    page,
    size,
    appliedSearch,
  };
}

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
  return fetchPublishedReviewsStore(productId, page ?? 1);
}

/**
 * Caching step 2 (2026-08-31): 60s Data Cache keyed by (productId, page).
 * Published reviews are public, moderated, user-independent content.
 */
const fetchPublishedReviewsStore = cachePublicRead(
  'catalog:reviews',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  async (productId: string, page: number): Promise<ReviewsPageData> => {
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
);

export interface ReviewSummary {
  total: number;
  /** Arithmetic mean rounded to 1 decimal; null when no published reviews. */
  average: number | null;
  /** Index 0 = ★1 … index 4 = ★5. */
  distribution: [number, number, number, number, number];
}

/**
 * Average + star distribution via ONE read-only RPC (migration 029,
 * perf audit Step 2 2026-08-28): replaces the previous five separate
 * head-count requests (one per rating) with a single group-by call.
 * The RPC is SECURITY INVOKER, so the anonymous role's RLS policy
 * (product_reviews_public_read_published) still governs visibility —
 * no rows can cross the wire, only ≤5 aggregated counts.
 */
export async function fetchReviewSummary(
  productId: string
): Promise<ReviewSummary> {
  return fetchReviewSummaryStore(productId);
}

/**
 * Caching step 2 (2026-08-31): 60s Data Cache keyed by productId. The RPC
 * is SECURITY INVOKER and public (aggregated counts only) — identical for
 * every visitor.
 */
const fetchReviewSummaryStore = cachePublicRead(
  'catalog:review-summary',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  async (productId: string): Promise<ReviewSummary> => {
    const { data, error } = await supabase.rpc('product_review_summary', {
      p_product_id: productId,
    });
    if (error) {
      throw new Error(`Failed to summarize ratings: ${error.message}`);
    }

    type SummaryRow = { rating: number | string; review_count: number | string };
    const rows = (data ?? []) as SummaryRow[];
    const countFor = (rating: number): number => {
      const row = rows.find((entry) => Number(entry.rating) === rating);
      return row ? Number(row.review_count) : 0;
    };

    const distribution: ReviewSummary['distribution'] = [
      countFor(1),
      countFor(2),
      countFor(3),
      countFor(4),
      countFor(5),
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
);

/**
 * Active products marked as featured for the home page.
 */
export async function fetchFeaturedProducts(): Promise<Product[]> {
  return fetchProducts({ featuredOnly: true });
}

/** Hard cap for the home «Обрані товари» shelf — bounded by design
    (mirror of the «Популярні товари» rule, MAX_FEATURED_PRODUCTS). */
export const SELECTED_LIMIT = 8;

export async function fetchSelectedProducts(): Promise<Product[]> {
  // Single bounded window (rows 0..7, partial index
  // idx_products_active_selected): the home grid renders at most two
  // 4-column rows, so admin flagging beyond 8 must not unbound the home
  // read. Deterministic order (created_at desc, id desc) — same priority
  // semantics as the popular shelf.
  //
  // In-stock first (2026-09 audit, mirrors the catalog default sort at
  // fetchCatalogProducts): with most of the catalog out of stock, the
  // recency-only order opened the home shelf on a wall of «Немає в
  // наявності». The DB only holds 'in_stock'/'out_of_stock' and
  // 'in_stock' < 'out_of_stock' lexicographically, so ascending
  // availability_status IS the in-stock-first contract; the set of shown
  // products (the admin-curated is_selected flag) is untouched — only the
  // display order changes. Recency stays the tiebreaker within each tier.
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('is_active', true)
    .eq('is_selected', true)
    .order('availability_status', { ascending: true })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, SELECTED_LIMIT - 1)
    .returns<ProductJoinedRow[]>();

  if (error) {
    throw new Error(`Failed to load selected products: ${error.message}`);
  }

  return (data ?? []).map(normalizeProduct);
}

/** Hard cap for the home «Популярні товари» shelf — bounded by design. */
const POPULAR_LIMIT = 8;

/**
 * Products for the home «Популярні товари» section — PURELY admin-curated.
 *
 * DECISION 2026-08-26 (supersedes the Stage-11 newest-arrivals fallback):
 * popularity has no real sales signal yet, and padding the shelf with
 * newest arrivals blurred who controls the block. It now shows EXACTLY the
 * active products flagged is_featured — newest first with an id tiebreaker,
 * hard-capped at 8. If an admin flags more than 8, the first 8 in this
 * deterministic order win and DATA IS NEVER CHANGED AUTOMATICALLY (the
 * max-8 business rule lives in the admin API/UI, see featured-limit.ts).
 * Zero featured ⇒ the home page skips the section entirely.
 */
export async function fetchPopularProducts(
  limit: number = POPULAR_LIMIT
): Promise<Product[]> {
  const take = Math.min(Math.max(limit, 1), POPULAR_LIMIT);

  // Single bounded window (rows 0..take-1, at most 8) — never a paged scan.
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
    throw new Error(`Failed to load popular products: ${error.message}`);
  }

  return (data ?? []).map(normalizeProduct);
}

/**
 * Active categories — React `cache()`d per request (perf audit Step 3):
 * the catalog page, the category-subtree expansion inside
 * fetchCatalogProducts and the related-products leg all need the SAME
 * dictionary read; within one render it now executes once.
 * Caching step 2 (2026-08-31): unstable_cache (120s) UNDER the React
 * cache() — one Data Cache entry shared across requests.
 */
export async function fetchActiveCategories(): Promise<Category[]> {
  return fetchActiveCategoriesCached();
}

const fetchActiveCategoriesStore = cachePublicRead(
  'catalog:categories',
  CATALOG_DICTIONARY_TTL_SECONDS,
  async (): Promise<Category[]> => {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .eq('is_active', true)
      // Commercial order is sort_order alone; the deterministic id fallback
      // keeps ties stable. No row-timestamp tiebreak here: the uk-name
      // fallback for display lives in compareCategories.
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })
      .returns<Category[]>();

    if (error) {
      throw new Error(`Failed to load categories: ${error.message}`);
    }

    return data ?? [];
  }
);

const fetchActiveCategoriesCached = cache(fetchActiveCategoriesStore);

/**
 * Active brands — same caching contract as fetchActiveCategories.
 */
export async function fetchActiveBrands(): Promise<Brand[]> {
  return fetchActiveBrandsCached();
}

const fetchActiveBrandsStore = cachePublicRead(
  'catalog:brands',
  CATALOG_DICTIONARY_TTL_SECONDS,
  async (): Promise<Brand[]> => {
    const { data, error } = await supabase
      .from('brands')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true })
      .returns<Brand[]>();

    if (error) {
      throw new Error(`Failed to load brands: ${error.message}`);
    }

    return data ?? [];
  }
);

const fetchActiveBrandsCached = cache(fetchActiveBrandsStore);

// ---------------------------------------------------------------------------
// Eligible-product counts per single category/brand view (Task #14,
// 2026-09): /catalog?category=X and /catalog?brand=Y with ZERO eligible
// products (active + ≥1 photo; category via junction + subtree expansion)
// must be noindex'd (lib/seo.ts) and stay out of the sitemap. The counts
// reuse the exact ELIGIBLE_COUNT_SELECT / JUNCTION_COUNT_SELECT shapes of
// fetchCatalogProducts, so an «empty» verdict can never disagree with the
// grid's own total. Cached like the slug lookups (60s) — public and
// identical for every visitor; null = slug unknown/inactive. A DB error is
// rethrown (callers degrade to «non-empty» so a transient read can never
// noindex a full page).
// ---------------------------------------------------------------------------

async function countCategoryProductsUncached(
  slug: string
): Promise<number | null> {
  const category = await lookupCategoryBySlugCached(slug);
  if (!category) return null;
  const activeCategories = await fetchActiveCategoriesStore();
  const subtreeIds = Array.from(
    collectSubtreeIds(activeCategories, category.id)
  );
  const { count, error } = await supabase
    .from('products')
    .select(JUNCTION_COUNT_SELECT, { count: 'exact', head: true })
    .eq('is_active', true)
    .in('pc.category_id', subtreeIds);
  if (error) {
    throw new Error(
      `Failed to count eligible products for category "${slug}": ${error.message}`
    );
  }
  return count ?? 0;
}

const countCategoryProductsStore = cachePublicRead(
  'catalog:category-product-count',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  countCategoryProductsUncached
);

/** React cache() on top of the 60s Data Cache: one execution per request. */
export const fetchCategoryProductCount = cache(countCategoryProductsStore);

async function countBrandProductsUncached(
  slug: string
): Promise<number | null> {
  const brand = await lookupBrandBySlugCached(slug);
  if (!brand) return null;
  const { count, error } = await supabase
    .from('products')
    .select(ELIGIBLE_COUNT_SELECT, { count: 'exact', head: true })
    .eq('is_active', true)
    .eq('brand_id', brand.id);
  if (error) {
    throw new Error(
      `Failed to count eligible products for brand "${slug}": ${error.message}`
    );
  }
  return count ?? 0;
}

const countBrandProductsStore = cachePublicRead(
  'catalog:brand-product-count',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  countBrandProductsUncached
);

export const fetchBrandProductCount = cache(countBrandProductsStore);

/**
 * Find an active product by slug with category, brand, images and variants.
 * Main image is derived from product_images.is_main (there is no
 * products.main_image column in the schema).
 * Returns null when no active product matches the slug.
 * Caching step 2 (2026-08-31): 60s Data Cache keyed by slug — the PDP read
 * is public and identical for every visitor. Failed reads stay uncached.
 */
export async function fetchProductBySlug(slug: string): Promise<Product | null> {
  return fetchProductBySlugStore(slug);
}

const fetchProductBySlugStore = cachePublicRead(
  'catalog:product-slug',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  async (slug: string): Promise<Product | null> => {
    const { data, error } = await supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('slug', slug)
      .eq('is_active', true)
      .returns<ProductJoinedRow[]>()
      .maybeSingle();

    if (error) {
      // A data error is not a missing product: rethrow so the route renders
      // the error boundary instead of a misleading 404.
      throw new Error(`Failed to load product by slug "${slug}": ${error.message}`);
    }

    if (!data) return null;

    return normalizeProduct(data);
  }
);
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

type RelatedStageFilter =
  | { kind: 'brand'; id: string }
  | { kind: 'category'; subtreeIds: string[] }
  | null;

async function fetchRelatedStage(
  filter: RelatedStageFilter,
  currentId: string,
  limit: number
): Promise<Product[]> {
  let query = supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('is_active', true)
    .neq('id', currentId);
  if (filter?.kind === 'category') {
    // Same junction + subtree semantics as fetchCatalogProducts. The count
    // embed uses product_id (see JUNCTION_COUNT_SELECT note).
    query = query
      .select(PRODUCT_SELECT + ', pc:product_categories!inner(category_id)')
      .in('pc.category_id', filter.subtreeIds);
  } else if (filter?.kind === 'brand') {
    query = query.eq('brand_id', filter.id);
  }
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
  return fetchRelatedProductsStore(
    // Key-shaping: only the fields that determine the result go into the
    // unstable_cache invocation key (JSON.stringify(args)) — a full Product
    // (with description HTML) would bloat every key.
    { id: product.id, category_id: product.category_id, brand_id: product.brand_id },
    limit
  );
}

/**
 * Caching step 2 (2026-08-31): 60s Data Cache keyed by the product identity
 * triple + limit; one entry per product (bounded by the catalog size).
 */
const fetchRelatedProductsStore = cachePublicRead(
  'catalog:related',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  async (
    identity: Pick<Product, 'id' | 'category_id' | 'brand_id'>,
    limit: number
  ): Promise<Product[]> => {
    const sameCategoryStage = identity.category_id
      ? fetchActiveCategories().then((activeCategories) =>
          fetchRelatedStage(
            {
              kind: 'category',
              subtreeIds: Array.from(collectSubtreeIds(activeCategories, identity.category_id!)),
            },
            identity.id,
            limit
          )
        )
      : Promise.resolve<Product[]>([]);
    const [sameCategory, sameBrand, newest] = await Promise.all([
      sameCategoryStage,
      identity.brand_id
        ? fetchRelatedStage({ kind: 'brand', id: identity.brand_id }, identity.id, limit)
        : Promise.resolve<Product[]>([]),
      fetchRelatedStage(null, identity.id, limit),
    ]);
    return collectRelated([sameCategory, sameBrand, newest], identity.id, limit);
  }
);

