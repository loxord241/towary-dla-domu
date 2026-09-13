/**
 * Search-term sanitization for the PostgREST `or=` expression
 * (app/lib/catalog.ts → fetchCatalogProducts).
 *
 * Contract: the sanitized term can never inject or corrupt the logic-tree
 * grammar (`,` `"` `(` `)` `%`), while ordinary search text — Cyrillic,
 * Latin, digits, spaces, hyphens, apostrophes, dots — passes through.
 * Grammar sensitivity itself was verified LIVE against Supabase/PostgREST
 * on 2026-08 (see PROJECT_CONTEXT.md, F3): raw `,` → PGRST100; raw `"`,
 * `(`, `)` silently corrupt the ilike pattern; raw `%` broadens matches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// catalog.ts creates its Supabase client at module load; provide the
// publishable-env placeholders BEFORE the import (no network happens).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';
const {
  sanitizeSearchTerm,
  buildSearchConditions,
  relaxSearchTerm,
  FALLBACK_MAX_RETRIES,
  FALLBACK_FUZZY_URL_BUDGET_BYTES,
  fuzzyTokenVariants,
  mapKeyboardLayout,
  buildFuzzyFallbackPlan,
} = await import('../app/lib/catalog.ts');

// ---- buildSearchConditions: multi-token AND search (UX fix: word order
// must not matter — «TEFAL мультипіч» and «мультипіч TEFAL» are equivalent).

test('buildSearchConditions: word order does not matter (same condition set)', () => {
  const a = buildSearchConditions('мультипіч TEFAL');
  const b = buildSearchConditions('TEFAL мультипіч');
  assert.notEqual(a, null);
  assert.notEqual(b, null);
  assert.deepEqual([...(a as string[])].sort(), [...(b as string[])].sort());
});

test('buildSearchConditions: every token becomes an AND-ed or() expression', () => {
  const conds = buildSearchConditions('парова щітка') as string[];
  assert.equal(conds.length, 2);
  for (const cond of conds) {
    // each token must match in name OR short_description OR description OR
    // sku OR yugcontract_id (P2-1: SKU / supplier-article search;
    // 2026-09: description search)
    assert.match(
      cond,
      /^name\.ilike\.%[^%]+%,short_description\.ilike\.%[^%]+%,description\.ilike\.%[^%]+%,sku\.ilike\.%[^%]+%,yugcontract_id\.ilike\.%[^%]+%$/
    );
  }
  const tokens = conds.map((c) => {
    const token = c.split('ilike.%')[1]?.split('%')[0];
    assert.ok(token !== undefined, 'token must be captured from the condition');
    return token;
  });
  assert.deepEqual(tokens.sort(), ['парова', 'щітка'].sort());
});

test('buildSearchConditions: single token keeps legacy shape', () => {
  assert.deepEqual(buildSearchConditions('щітка'), [
    'name.ilike.%щітка%,short_description.ilike.%щітка%,description.ilike.%щітка%,sku.ilike.%щітка%,yugcontract_id.ilike.%щітка%',
  ]);
});

// ---- P2-1 (2026-08-29): SKU / supplier-article search -----------------------
// Real data shape verified against production (2026-08-29): every product
// SKU is `YC-<yugcontract_id>` (e.g. `YC-7061899` / `7061899_du`), and the
// supplier article lives in the existing products.yugcontract_id column.

test('buildSearchConditions: full SKU with YC- prefix matches sku column', () => {
  assert.deepEqual(buildSearchConditions('YC-7061899'), [
    'name.ilike.%YC-7061899%,short_description.ilike.%YC-7061899%,description.ilike.%YC-7061899%,sku.ilike.%YC-7061899%,yugcontract_id.ilike.%YC-7061899%',
  ]);
});

test('buildSearchConditions: bare numeric SKU matches yugcontract_id', () => {
  const cond = buildSearchConditions('7061899') as string[];
  assert.equal(cond.length, 1);
  const firstCond = cond[0];
  assert.ok(firstCond !== undefined, 'expected a single condition');
  assert.match(firstCond, /sku\.ilike\.%7061899%/);
  assert.match(firstCond, /yugcontract_id\.ilike\.%7061899%/);
});

test('buildSearchConditions: SKU search is case-insensitive by construction', () => {
  // The sanitizer must NOT mutate the token either way (upper/lower pass
  // through verbatim); case-folding itself is ILIKE semantics at the DB.
  assert.deepEqual(buildSearchConditions('yc-7061899'), [
    'name.ilike.%yc-7061899%,short_description.ilike.%yc-7061899%,description.ilike.%yc-7061899%,sku.ilike.%yc-7061899%,yugcontract_id.ilike.%yc-7061899%',
  ]);
  // Both casings produce the same match SET against a real SKU column:
  // identical modulo case, which ILIKE ignores.
  const upper = buildSearchConditions('YC-7061899') as string[];
  const lower = buildSearchConditions('yc-7061899') as string[];
  assert.deepEqual(
    upper.map((c) => c.toLowerCase()),
    lower.map((c) => c.toLowerCase())
  );
});

test('buildSearchConditions: SKU token rides the same per-token AND semantics', () => {
  // «фен YC-7061899» — text token ANDed with the SKU token; word order free.
  const a = buildSearchConditions('фен YC-7061899') as string[];
  const b = buildSearchConditions('YC-7061899 фен') as string[];
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.equal(a.length, 2);
  for (const cond of a) {
    assert.match(cond, /^(name|sku)\.ilike\.%[^%]+%/);
    assert.match(cond, /yugcontract_id\.ilike\.%[^%]+%$/);
  }
});

test('buildSearchConditions: SKU search inherits or= grammar injection guard', () => {
  // The sanitizer replaces reserved grammar chars with spaces BEFORE the
  // token reaches the sku/yugcontract_id pattern, so an adversarial
  // "YC-7061899%,name.ilike" can never widen the match set.
  const conds = buildSearchConditions('YC-7061899%",sku.neq.NULL') as string[];
  assert.equal(conds.length, 2); // splits into safe tokens, never raw grammar
  for (const cond of conds) {
    assert.doesNotMatch(cond, /%,[a-z_]+\.neq\./);
  }
});

test('buildSearchConditions: empty / whitespace / specials-only → null', () => {
  assert.equal(buildSearchConditions(''), null);
  assert.equal(buildSearchConditions('   '), null);
  assert.equal(buildSearchConditions(',""'), null);
  assert.equal(buildSearchConditions('%","%('), null);
});

test('buildSearchConditions: duplicate tokens collapse', () => {
  const conds = buildSearchConditions('щітка щітка') as string[];
  assert.equal(conds.length, 1);
});

test('buildSearchConditions: token fan-out is capped at 10 (ILIKE cost bound)', () => {
  const many = Array.from({ length: 25 }, (_, i) => `слово${i + 1}`).join(' ');
  const conds = buildSearchConditions(many) as string[];
  assert.equal(conds.length, 10);
});

test('buildSearchConditions: cyrillic, digits, hyphens, apostrophes, dots preserved', () => {
  const conds = buildSearchConditions("фото-альбом 10x15 l'oreal") as string[];
  assert.equal(conds.length, 3);
  const joined = conds.join('|');
  assert.ok(joined.includes('фото-альбом'));
  assert.ok(joined.includes('10x15'));
  assert.ok(joined.includes("l'oreal"));
});

test('buildSearchConditions: adversarial input can never inject or= grammar', () => {
  const adversarial = [
    'Ніж TRAMONTINA CENTURY поварський6" (24010/106)',
    '"iphone 15", (в наявності) 100%',
    'foo,bar"baz',
    '%","%(',
  ];
  for (const input of adversarial) {
    const conds = buildSearchConditions(input);
    if (!conds) continue;
    for (const cond of conds) {
      // strip the known scaffolding, inspect only the pattern values
      const values = [...cond.matchAll(/ilike\.%([^%]*)%/g)].map((m) => m[1]).filter((v): v is string => v !== undefined);
      for (const value of values) {
        for (const ch of [',', '"', '(', ')', '%']) {
          assert.ok(
            !value.includes(ch),
            `pattern ${JSON.stringify(value)} contains reserved ${JSON.stringify(ch)}`
          );
        }
      }
    }
  }
});

test('buildSearchConditions: F3 corrupted-name case stays findable', () => {
  // The live-verified F3 name; its sanitized tokens must each be searchable.
  const conds = buildSearchConditions(
    'Ніж TRAMONTINA CENTURY поварський6" (24010/106)'
  ) as string[];
  const joined = conds.join('|');
  assert.ok(joined.includes('TRAMONTINA'));
  assert.ok(joined.includes('поварський6'));
  assert.ok(joined.includes('24010/106'));
});

test('sanitizeSearchTerm: comma becomes a space, tokens stay searchable', () => {
  assert.equal(sanitizeSearchTerm('foo,bar'), 'foo bar');
});

test('sanitizeSearchTerm: double quotes are stripped in all positions', () => {
  assert.equal(sanitizeSearchTerm('"foo"'), 'foo');
  assert.equal(sanitizeSearchTerm('foo"bar'), 'foo bar');
});

test('sanitizeSearchTerm: combined comma + quote', () => {
  assert.equal(sanitizeSearchTerm('foo,bar"baz'), 'foo bar baz');
});

test('sanitizeSearchTerm: parens and percent are stripped too', () => {
  assert.equal(sanitizeSearchTerm('(альбом)'), 'альбом');
  assert.equal(sanitizeSearchTerm('100%'), '100');
  assert.equal(sanitizeSearchTerm('фото (10x15)"'), 'фото 10x15');
});

test('sanitizeSearchTerm: PostgREST %-synonym (*) and ILIKE _ wildcards are stripped', () => {
  // '*' is a PostgREST ilike wildcard synonym (q=*** matched everything
  // pre-fix); '_' is the single-char ILIKE wildcard — same broadening class.
  assert.equal(sanitizeSearchTerm('***'), '');
  assert.equal(sanitizeSearchTerm('___'), '');
  assert.equal(sanitizeSearchTerm('a*b_c'), 'a b c');
  assert.equal(sanitizeSearchTerm('100_*'), '100');
});

test('sanitizeSearchTerm: ordinary product text is preserved', () => {
  assert.equal(sanitizeSearchTerm('Фотоальбом 10x15'), 'Фотоальбом 10x15');
  assert.equal(sanitizeSearchTerm('Парова щітка TEFAL DT2026E1'), 'Парова щітка TEFAL DT2026E1');
  assert.equal(sanitizeSearchTerm('philips-oneblade'), 'philips-oneblade');
  assert.equal(sanitizeSearchTerm("l'oreal"), "l'oreal");
  assert.equal(sanitizeSearchTerm('Вбуд. поверхня WHIRLPOOL AKT 8210 LX'), 'Вбуд. поверхня WHIRLPOOL AKT 8210 LX');
});

test('sanitizeSearchTerm: interior whitespace runs collapse to single spaces', () => {
  assert.equal(sanitizeSearchTerm('  a   b  '), 'a b');
  // adjacent specials must not leave multi-space gaps between tokens
  assert.equal(sanitizeSearchTerm('foo,",bar'), 'foo bar');
});

test('sanitizeSearchTerm: empty and whitespace-only input', () => {
  assert.equal(sanitizeSearchTerm(''), '');
  assert.equal(sanitizeSearchTerm('   '), '');
  assert.equal(sanitizeSearchTerm(',""'), '');
});

test('sanitizeSearchTerm: output can never inject or= grammar characters', () => {
  const adversarial = [
    'foo,bar',
    '"foo"',
    'foo"bar',
    'foo,bar"baz',
    '",("',
    '%","%("',
    '***',
    'a_b*c',
    'Ніж TRAMONTINA CENTURY поварський6" (24010/106)',
    '"iphone 15", (в наявності) 100%',
  ];
  for (const input of adversarial) {
    const out = sanitizeSearchTerm(input);
    for (const ch of [',', '"', '(', ')', '%', '*', '_']) {
      assert.ok(
        !out.includes(ch),
        `output ${JSON.stringify(out)} contains reserved ${JSON.stringify(ch)}`
      );
    }
  }
});

test('sanitizeSearchTerm: real corrupted-name case now yields a usable keyword term', () => {
  // Live-verified F3 case: this exact name was unfindable pre-fix because
  // the quote silently corrupted the ilike pattern.
  const name = 'Ніж TRAMONTINA CENTURY поварський6" (24010/106)';
  const out = sanitizeSearchTerm(name);
  assert.equal(out, 'Ніж TRAMONTINA CENTURY поварський6 24010/106');
  assert.ok(out.includes('TRAMONTINA'));
});

// ---- Typographic apostrophes (2026-09 audit) ------------------------------
// Ukrainian product names mix the typographic apostrophes ’ (U+2019) / ‘
// (U+2018) with the ASCII apostrophe ' (U+0027). ILIKE treats them as
// different characters, so `м’ясорубка` (U+2019 in the query) found nothing
// when the DB name used U+0027. Both are normalized to U+0027 BEFORE the
// special-char replacement, and the ASCII apostrophe stays a safe literal.

test('sanitizeSearchTerm: U+2019 (’) normalizes to ASCII apostrophe', () => {
  assert.equal(sanitizeSearchTerm('м\u2019ясорубка'), "м'ясорубка");
});

test('sanitizeSearchTerm: U+2018 (‘) normalizes to ASCII apostrophe', () => {
  assert.equal(sanitizeSearchTerm('м\u2018ясорубка'), "м'ясорубка");
});

test('sanitizeSearchTerm: typographic and ASCII apostrophe queries converge', () => {
  // The whole point: whichever apostrophe the user types, the sanitized
  // token (and therefore the ILIKE pattern) is identical.
  const ascii = sanitizeSearchTerm("м'ясорубка");
  assert.equal(sanitizeSearchTerm('м\u2019ясорубка'), ascii);
  assert.equal(sanitizeSearchTerm('м\u2018ясорубка'), ascii);
});

test('sanitizeSearchTerm: apostrophe normalization reaches buildSearchConditions', () => {
  const typographic = buildSearchConditions('м\u2019ясорубка') as string[];
  const ascii = buildSearchConditions("м'ясорубка") as string[];
  assert.deepEqual(typographic, ascii);
  assert.match(typographic[0] ?? '', /name\.ilike\.%м'ясорубка%/);
});

test('sanitizeSearchTerm: apostrophe normalization fires next to reserved chars', () => {
  // U+2019 must be normalized BEFORE the special-char replacement so a
  // mixed query still collapses to one clean token, not a split pattern.
  assert.equal(sanitizeSearchTerm('м\u2019ясорубка, TEFAL'), "м'ясорубка TEFAL");
});

test('buildSearchConditions: apostrophe token searches BOTH spellings', () => {
  // Mid-word apostrophe breaks substring contiguity: %м'ясорубка% cannot
  // match «М’ясорубка» data and vice versa (live-verified 2026-09-08 —
  // the two spellings yield disjoint result tails). A token containing an
  // apostrophe must therefore emit both spellings across every field.
  const conditions = buildSearchConditions("м'ясорубка") as string[];
  assert.match(conditions[0] ?? '', /name\.ilike\.%м'ясорубка%/);
  assert.match(conditions[0] ?? '', /name\.ilike\.%м\u2019ясорубка%/);
  // 5 searched fields × 2 spellings
  assert.equal((conditions[0] ?? '').split(',').length, 10);
});

test('buildSearchConditions: apostrophe-free token keeps the legacy single-pattern shape', () => {
  const conditions = buildSearchConditions('мясорубка') as string[];
  assert.equal(
    conditions[0],
    'name.ilike.%мясорубка%,short_description.ilike.%мясорубка%,' +
      'description.ilike.%мясорубка%,sku.ilike.%мясорубка%,' +
      'yugcontract_id.ilike.%мясорубка%'
  );
});

// ---- Task #40: typo fallback candidate generation (relaxSearchTerm) --------
//
// Contract: each retry trims the LAST character of the currently-longest
// trimmable token, CUMULATIVELY (longest token first, ties → earliest), at
// most FALLBACK_MAX_RETRIES variants, tokens are never shortened below
// FALLBACK_MIN_TOKEN_LEN. Progressive trimming is deliberate: verified on
// production data (2026-09-05), «сковоротка» has NO 1-edit neighbor among
// product names («сковорода» differs by 2 edits; «сковородка» appears
// nowhere at all), but the stem «сковоро» matches 252 eligible products —
// so the third retry must be «сковоро», not a trim of another token.
// Output is pure and must be re-fed through buildSearchConditions (which
// re-sanitizes) before use.

test('relaxSearchTerm: single token drops its last char first', () => {
  // «блендерр» → «блендер» — the flagship Task #40 case
  assert.ok(relaxSearchTerm('блендерр').includes('блендер'));
});

test('relaxSearchTerm: trims are cumulative across retries (same token shrinks)', () => {
  // «сковородка» is nowhere in production data; the ONLY path to the 252
  // «сковоро*» products is the third retry «сковоро» (SQL-verified 2026-09-05).
  assert.deepEqual(relaxSearchTerm('сковоротка'), [
    'сковоротк',
    'сковорот',
    'сковоро',
  ]);
  assert.deepEqual(relaxSearchTerm('блендерр'), ['блендер', 'бленде', 'бленд']);
});

test('relaxSearchTerm: short tokens never produce variants', () => {
  assert.deepEqual(relaxSearchTerm('чай'), []);
  assert.deepEqual(relaxSearchTerm('дом'), []);
});

test('relaxSearchTerm: 4-char token is at the floor and is never trimmed', () => {
  assert.deepEqual(relaxSearchTerm('мова'), []);
});

test('relaxSearchTerm: 5-char token trims exactly once (floor = 4)', () => {
  assert.deepEqual(relaxSearchTerm('щітка'), ['щітк']);
});

test('relaxSearchTerm: multi-token breadth first, then depth (longest first)', () => {
  // retry 1 trims the longest token; retry 2 switches to the never-trimmed
  // «tefal» (breadth before depth — a second broken token must still get
  // its trim); retry 3 returns to the (now longest, once-trimmed) «блендер».
  assert.deepEqual(relaxSearchTerm('tefal блендерр'), [
    'tefal блендер',
    'tefa блендер',
    'tefa бленде',
  ]);
});

test('relaxSearchTerm: retry budget caps the variant list', () => {
  const many = 'abcdefgh ijklmnop qrstuvwx yzabcdef'; // 4 equal-length tokens
  const variants = relaxSearchTerm(many);
  assert.equal(variants.length, FALLBACK_MAX_RETRIES);
  // all tokens tie at 8 chars → breadth-first: one trim per token, earliest
  assert.deepEqual(variants, [
    'abcdefg ijklmnop qrstuvwx yzabcdef',
    'abcdefg ijklmno qrstuvwx yzabcdef',
    'abcdefg ijklmno qrstuvw yzabcdef',
  ]);
});

test('relaxSearchTerm: empty / whitespace-only input yields nothing', () => {
  assert.deepEqual(relaxSearchTerm(''), []);
  assert.deepEqual(relaxSearchTerm('   '), []);
});

test('relaxSearchTerm: variants inherit the or= grammar injection guard', () => {
  const variants = relaxSearchTerm('abcdefgh,ijklm"op');
  assert.equal(variants.length, 3);
  for (const variant of variants) {
    for (const ch of [',', '"', '(', ')', '%']) {
      assert.ok(
        !variant.includes(ch),
        `variant ${JSON.stringify(variant)} contains reserved ${JSON.stringify(ch)}`
      );
    }
  }
});

test('UI: catalog page renders a fallback notice wired to appliedSearch', () => {
  const page = readFileSync(path.join(root, 'app/catalog/CatalogView.tsx'), 'utf8');
  // notice reads the lib flag…
  assert.match(page, /catalog\.appliedSearch/);
  assert.match(page, /Показані результати для/);
  // …while the original query stays visible in H1 and the filter chip
  assert.match(page, /Пошук: «\$\{filters\.search\}»/);
  assert.match(page, /«\$\{filters\.search\}»`, removeKey: 'q'/);
});

// ---- Fuzzy fallback (Phase 1 + Phase 2): pure candidate generation ----------
//
// Contract: tokens below FALLBACK_MIN_TOKEN_LEN never produce variants;
// deterministic KIND-FAIR emission (layout first, then per position:
// deletion → transposition → gap → substitution); deduped against the token
// itself; every candidate free of or=/ILIKE grammar characters; the probe
// plan ORs [original, ...variants] per token and bounds total emission by
// the encoded-URL byte budget FALLBACK_FUZZY_URL_BUDGET_BYTES.

test('fuzzyTokenVariants: transposition «блендре» yields «блендер»', () => {
  assert.ok(fuzzyTokenVariants('блендре').includes('блендер'));
});

test('fuzzyTokenVariants: deletion at any position «бленддер» yields «блендер»', () => {
  const variants = fuzzyTokenVariants('бленддер');
  assert.ok(variants.includes('блендер'));
  // interior deletion covered too: deleting the FIRST char proves position 0
  assert.ok(fuzzyTokenVariants('блндер').includes('лндер'));
});

test('fuzzyTokenVariants: missing letter «блндер» yields interior gap «бл_ндер»', () => {
  assert.ok(fuzzyTokenVariants('блндер').includes('бл_ндер'));
  // no leading/trailing gaps — they would only re-test deletions
  assert.ok(!fuzzyTokenVariants('блндер').some((v) => v.startsWith('_')));
  assert.ok(!fuzzyTokenVariants('блндер').some((v) => v.endsWith('_')));
});

test('fuzzyTokenVariants: substitution «сковоротка» yields «сковоро_ка»', () => {
  // Phase 2 flagship case: wrong letter, same word length. Pattern matches
  // «сковородка»-shaped text (note: production data has zero «сковородка» —
  // the live «сковоротка» case is covered by the progressive trim ladder
  // instead; this class covers mid-word wrong-letter typos like
  // «блендар» → «бленд_р» → «блендер»).
  const variants = fuzzyTokenVariants('сковоротка');
  assert.ok(variants.includes('сковоро_ка'));
  assert.ok(fuzzyTokenVariants('блендар').includes('бленд_р'));
});

test('fuzzyTokenVariants: substitutions are interior-only (subsumed at the edges)', () => {
  // position-0 substitution is subsumed by the position-0 DELETION variant
  // under ILIKE substring semantics (%Xrest% ⇒ contains rest), and the
  // last-position one by the last-position deletion (%prec% ⇒ contains pre)
  const variants = fuzzyTokenVariants('абвгде');
  assert.ok(variants.includes('а_вгде'), 'interior substitution present');
  assert.ok(!variants.includes('_бвгде'), 'leading substitution subsumed by deletion');
  assert.ok(!variants.includes('абвг_'), 'trailing substitution subsumed by deletion');
  // every emitted variant with _ replacing a char keeps the token length
  for (const v of variants) {
    if (v.includes('_') && v.length === 'абвгде'.length) {
      assert.equal(v.length, 6);
    }
  }
});

test('fuzzyTokenVariants: kind-fair positional emission order is pinned', () => {
  // layout first, then per position: deletion → transposition → gap →
  // substitution. «abcdefgh» layout-remaps to «фисвуапр»; position 0 has
  // no gap/substitution (leading), position 1 has all four kinds.
  const variants = fuzzyTokenVariants('abcdefgh');
  assert.deepEqual(variants.slice(0, 8), [
    'фисвуапр', // layout remap
    'bcdefgh', // pos 0: deletion
    'bacdefgh', // pos 0: transposition
    'acdefgh', // pos 1: deletion
    'acbdefgh', // pos 1: transposition
    'a_bcdefgh', // pos 1: gap (inserts before position 1)
    'a_cdefgh', // pos 1: substitution
    'abdefgh', // pos 2: deletion
  ]);
});

test('mapKeyboardLayout: QWERTY → ЙЦУКЕН «ktylth» → «лендер»', () => {
  assert.equal(mapKeyboardLayout('ktylth'), 'лендер');
  assert.ok(fuzzyTokenVariants('ktylth').includes('лендер'));
});

test('mapKeyboardLayout: ЙЦУКЕН → QWERTY «ЕУАФД» → «tefal»', () => {
  assert.equal(mapKeyboardLayout('ЕУАФД'), 'tefal');
});

test('mapKeyboardLayout: mixed/unmappable tokens yield null (no partial remap)', () => {
  assert.equal(mapKeyboardLayout('abc1'), null, 'digit is unmappable');
  assert.equal(mapKeyboardLayout('блендер'), null, '«б» remaps to the comma key — rejected, not corrupted');
  assert.equal(mapKeyboardLayout('фото-10'), null, 'hyphen/digit unmappable');
  assert.equal(mapKeyboardLayout(''), null);
});

test('fuzzyTokenVariants: tokens below the floor yield nothing', () => {
  assert.deepEqual(fuzzyTokenVariants('чай'), []);
  assert.deepEqual(fuzzyTokenVariants('дом'), []);
  // a 4-char token is AT the floor (>= 4) — eligible by design
  assert.ok(fuzzyTokenVariants('мова').length > 0);
});

test('fuzzyTokenVariants: doubled-letter deletions dedupe to one variant', () => {
  const variants = fuzzyTokenVariants('блендерр');
  assert.equal(
    variants.filter((v) => v === 'блендер').length,
    1,
    'deleting either «р» yields the same string — must appear once'
  );
});

test('fuzzyTokenVariants: deterministic output for the same input', () => {
  assert.deepEqual(
    fuzzyTokenVariants('блендре'),
    fuzzyTokenVariants('блендре')
  );
  // kind order is fixed: layout first, then deletions, transpositions, gaps
  const variants = fuzzyTokenVariants('tefalx');
  assert.equal(variants[0], 'еуафдч'); // layout remap comes first
});

test('fuzzyTokenVariants: no variant can carry or= grammar characters', () => {
  const inputs = [
    'блендерр',
    'блндер',
    'ktylth',
    'abcdefgh',
    "l'orealx", // apostrophe is safe, must not become grammar
    'YC-706189',
  ];
  for (const input of inputs) {
    for (const variant of fuzzyTokenVariants(input)) {
      for (const ch of [',', '"', '(', ')', '%']) {
        assert.ok(
          !variant.includes(ch),
          `variant ${JSON.stringify(variant)} of ${JSON.stringify(input)} contains reserved ${JSON.stringify(ch)}`
        );
      }
    }
  }
});

test('buildFuzzyFallbackPlan: all tokens below the floor → null (no probe)', () => {
  assert.equal(buildFuzzyFallbackPlan('чай дом'), null);
  assert.equal(buildFuzzyFallbackPlan(''), null);
});

test('buildFuzzyFallbackPlan: one or= per token, original first in the OR set', () => {
  const plan = buildFuzzyFallbackPlan('блндер');
  assert.notEqual(plan, null);
  assert.equal(plan?.conditions.length, 1);
  const cond = plan?.conditions[0];
  assert.ok(cond !== undefined);
  assert.ok(cond.startsWith('name.ilike.%блндер%'), 'original token first');
  assert.ok(cond.includes('name.ilike.%бл_ндер%'));
  assert.ok(cond.includes('short_description.ilike.%бл_ндер%'));
  // probe fields are name + short_description only (URL budget — see
  // FUZZY_PROBE_FIELDS); sku/yugcontract_id stay on the exact paths
  assert.ok(!cond.includes('sku.'));
  assert.ok(!cond.includes('yugcontract_id.'));
});

test('buildFuzzyFallbackPlan: substitution candidate reaches the probe conditions', () => {
  const plan = buildFuzzyFallbackPlan('сковоротка');
  assert.notEqual(plan, null);
  const cond = plan?.conditions[0];
  assert.ok(cond !== undefined);
  assert.ok(cond.includes('name.ilike.%сковоро_ка%'));
});

test('buildFuzzyFallbackPlan: long token plan stays inside the URL budget', () => {
  // «электросковородка» (17 chars) is the live reproducer of the Phase-1
  // overflow: the old 32×4-field shape produced a ~15.9KB or= value and the
  // probe died with UND_ERR_HEADERS_OVERFLOW (verified live 2026-09-05).
  // The plan must now exist, keep every token's condition non-empty, and
  // the TOTAL encoded or= payload must stay under the budget.
  const plan = buildFuzzyFallbackPlan('электросковородка');
  assert.notEqual(plan, null);
  assert.equal(plan?.conditions.length, 1);
  assert.ok((plan?.conditions[0]?.length ?? 0) > 0);
  assert.ok(
    plan?.candidates.some((c) => c.variant === 'лектросковородка'),
    'position-0 deletion (the only 1-edit bridge to «електросковородка»-shaped names) must be emitted'
  );
  const encoded = (plan?.conditions ?? [])
    .map((c) => encodeURIComponent(c).length)
    .reduce((a, b) => a + b, 0);
  assert.ok(
    encoded <= FALLBACK_FUZZY_URL_BUDGET_BYTES,
    `encoded conditions ${encoded} must fit the ${FALLBACK_FUZZY_URL_BUDGET_BYTES}-byte budget`
  );
});

test('buildFuzzyFallbackPlan: multi-token plan keeps every token condition non-empty and inside budget', () => {
  const plan = buildFuzzyFallbackPlan('abcdefgh ijklmnop qrstuvwx yzabcdef');
  assert.notEqual(plan, null);
  const conditions = plan?.conditions ?? [];
  assert.equal(conditions.length, 4);
  for (const cond of conditions) {
    assert.ok(cond.length > 0, 'every token keeps at least its original');
    assert.ok(cond.startsWith('name.ilike.%'), 'original first');
  }
  const encoded = conditions
    .map((c) => encodeURIComponent(c).length)
    .reduce((a, b) => a + b, 0);
  assert.ok(encoded <= FALLBACK_FUZZY_URL_BUDGET_BYTES);
});

test('buildFuzzyFallbackPlan: short tokens stay exact inside a mixed query', () => {
  const plan = buildFuzzyFallbackPlan('чай блндер');
  assert.notEqual(plan, null);
  assert.equal(plan?.conditions.length, 2);
  const shortCond = plan?.conditions[0];
  assert.ok(shortCond !== undefined);
  // «чай» has no variants → degrades to the probe's 2-field exact shape
  // (see FUZZY_PROBE_FIELDS)
  assert.equal(
    shortCond,
    'name.ilike.%чай%,short_description.ilike.%чай%'
  );
});

test('buildFuzzyFallbackPlan: round-robin emission starts with every original', () => {
  const plan = buildFuzzyFallbackPlan('bosch блндер');
  assert.notEqual(plan, null);
  const candidates = plan?.candidates ?? [];
  assert.deepEqual(candidates[0], { tokenIndex: 0, variant: 'bosch' });
  assert.equal(candidates[1]?.tokenIndex, 1);
  assert.equal(candidates[1]?.variant, 'блндер');
  // deterministic
  assert.deepEqual(
    buildFuzzyFallbackPlan('bosch блндер')?.candidates ?? [],
    candidates
  );
  for (const c of candidates) {
    for (const ch of [',', '"', '(', ')', '%']) {
      assert.ok(!c.variant.includes(ch));
    }
  }
});

test('buildFuzzyFallbackPlan: byte budget bounds the global emission', () => {
  // four 8-char junk tokens each generate ~29 candidates; the URL byte
  // budget must keep the emitted list (and the encoded or= payload) bounded
  const plan = buildFuzzyFallbackPlan('abcdefgh ijklmnop qrstuvwx yzabcdef');
  assert.notEqual(plan, null);
  const candidates = plan?.candidates ?? [];
  assert.ok(candidates.length > 0, 'some variants must be emitted');
  const encoded = (plan?.conditions ?? [])
    .map((c) => encodeURIComponent(c).length)
    .reduce((a, b) => a + b, 0);
  assert.ok(
    encoded <= FALLBACK_FUZZY_URL_BUDGET_BYTES,
    'emission must respect FALLBACK_FUZZY_URL_BUDGET_BYTES'
  );
});

test('buildFuzzyFallbackPlan: substitutions are not displaced by earlier kinds', () => {
  // regression for the Phase-2 displacement problem: the old flat
  // 32-candidate cap with block-ordered kinds emitted ZERO substitutions
  // for ≥8-char tokens. Kind-fair positional emission guarantees every
  // kind survives any budget cut.
  for (const token of ['abcdefgh', 'сковоротка', 'abcdefghijklmnopqrst']) {
    const plan = buildFuzzyFallbackPlan(token);
    assert.notEqual(plan, null);
    const variants = plan?.candidates.map((c) => c.variant) ?? [];
    const tokenLen = [...token].length;
    const hasSubstitution = variants.some(
      (v) => [...v].length === tokenLen && v.includes('_')
    );
    assert.ok(
      hasSubstitution,
      `substitution variant must survive the budget for ${token}`
    );
  }
});
