//
// Search pipeline: term sanitization, PostgREST or= conditions, the
// zero-result trim ladder + 1-edit fuzzy probe and JS relevance ranking.
//

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
 *
 * Typographic apostrophes (2026-09 audit): ’ (U+2019) and ‘ (U+2018) are
 * normalized to the ASCII apostrophe BEFORE the special-char replacement —
 * Ukrainian names commonly mix both spellings («м’ясорубка» vs «м'ясорубка»),
 * and ILIKE treats them as different characters, so a U+2019 query could not
 * find products stored with U+0027 (and vice versa). The apostrophe itself
 * stays a safe literal in the pattern.
 */
export function sanitizeSearchTerm(term: string): string {
  return term
    .replace(/[\u2018\u2019]/g, "'")
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
  return tokens.map((token) => {
    // Apostrophe dual-spelling recall (2026-09-08): the supplier data mixes
    // «М'ясорубка» (U+0027) and «М’ясорубка» (U+2019), and a mid-word
    // apostrophe breaks substring contiguity — %м'ясорубка% can never match
    // a plain-spelling mention and vice versa. A token containing an
    // apostrophe is therefore searched in BOTH spellings (the sanitizer has
    // already canonicalized ’→', so the second variant re-introduces ’).
    // Tokens without an apostrophe keep the single-pattern shape exactly.
    const variants =
      token.includes("'") ? [token, token.replace(/'/g, '’')] : [token];
    const fields = [
      'name',
      'short_description',
      'description',
      'sku',
      'yugcontract_id',
    ];
    return fields
      .flatMap((field) => variants.map((v) => `${field}.ilike.%${v}%`))
      .join(',');
  });
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
 * fetches up to this many matched rows in ONE request, ranks them and
 * slices the page in JS. Searches matching more rows than the cap keep the
 * plain SQL ordering (in-stock first, then created_at desc, id desc)
 * instead of ranking a truncated set — at that width the match quality is
 * nearly uniform anyway.
 *
 * 300, not 1000 (2026-09-08, owner decision «б»): the ranked scan is the
 * only storefront read that fetches `description` (~1.3 KB/row live) —
 * purely to score the description-hit tier. 300 rows cap that scan at
 * ~390 KB per search instead of ~1.3 MB (egress audit item №3); wider
 * match sets keep full server-side pagination with no ranked window.
 */
export const SEARCH_RANK_SCAN_LIMIT = 300;

/** Fields the ranking reads; a superset of the catalog card projection. */
export interface SearchRankable {
  id: string;
  name: string;
  short_description?: string | null;
  description?: string | null;
  sku?: string | null;
  yugcontract_id?: string | null;
  created_at?: string | null;
  /** Secondary sort tier (2026-09 audit): CATALOG_CARD_SELECT already
      projects this column; optional so pure scoring callers can omit it. */
  availability_status?: string | null;
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
 * PURE: order matched rows by relevance (best first). Ties resolve with a
 * deterministic secondary key — availability (in-stock first, the 2026-09
 * default-sort contract the «Спочатку в наявності» label promises), then
 * created_at desc, then id desc — so page windows of the ranked path stay
 * reproducible (the ranked scan reads the COMPLETE match set whenever it
 * runs: total ≤ cap, so determinism, not SQL-order congruence, is what keeps
 * pagination stable). The availability tier is deliberately SECONDARY:
 * relevance is never overridden (an exact out-of-stock match still beats a
 * weak in-stock one); only equally-relevant rows are reordered so in-stock
 * matches surface first. Rows without the field count as available
 * (backward compatible). Returns a new array; the input is not mutated.
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
    // 'in_stock' < 'out_of_stock' lexicographically, but the tier must be
    // explicit: ONLY 'out_of_stock' demotes, anything else (in_stock,
    // limited, unknown, absent) stays in the available tier.
    const aOut = a.row.availability_status === 'out_of_stock' ? 1 : 0;
    const bOut = b.row.availability_status === 'out_of_stock' ? 1 : 0;
    if (aOut !== bOut) return aOut - bOut; // available first
    const aAt = a.row.created_at ?? '';
    const bAt = b.row.created_at ?? '';
    if (aAt !== bAt) return aAt < bAt ? 1 : -1; // newer first
    if (a.row.id !== b.row.id) return a.row.id < b.row.id ? 1 : -1; // id desc
    return 0;
  });
  return scored.map((entry) => entry.row);
}
