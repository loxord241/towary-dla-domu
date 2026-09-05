/**
 * Task #40: zero-result typo fallback for /catalog search — RUNTIME tests.
 *
 * Contract under test (drives the REAL supabase-js pipeline against a local
 * fake PostgREST, same pattern as tests/admin-search-pagination.test.ts):
 *   - the fallback runs ONLY when the original search matched 0 products;
 *   - each retry replaces (never adds to) the search conditions with the
 *     relaxed term — the broken variant kept the unmatched term in the AND
 *     tree and pinned the count to zero forever;
 *   - a successful retry re-points BOTH the count and the data query at the
 *     relaxed term and reports it via `appliedSearch` for the UI notice;
 *   - queries that already match, and queries too short to relax, never
 *     trigger extra requests;
 *   - pagination stays consistent with the adopted (relaxed) total.
 *
 * The fake honours or= (multiple params AND together, comma-separated
 * predicates OR across fields), HEAD/Prefer counts via Content-Range and
 * offset/limit windows — the exact semantics whose absence broke search
 * filtering before (see admin-search-pagination.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

interface Row {
  [key: string]: unknown;
}

// --- dataset: names contain the FULL token, never the doubled-letter typo ---
function cardRow(
  id: string,
  name: string,
  extras: {
    short_description?: string | null;
    brand?: { name: string } | null;
    created_at?: string;
  }
): Row {
  return {
    id,
    name,
    slug: id,
    price: 100,
    old_price: null,
    currency: 'UAH',
    availability_status: 'in_stock',
    is_active: true,
    short_description: extras.short_description ?? null,
    sku: `YC-${id}`,
    yugcontract_id: id,
    brand: extras.brand ?? null,
    created_at: extras.created_at ?? '2026-01-10T00:00:00Z',
    images: [{ id: `img-${id}`, product_id: id, image_url: 'img', is_main: true, sort_order: 0 }],
  };
}

const ROWS: Row[] = [
  // «блендер» set. r100 is the OLDER blender but carries a description that
  // also matches fuzzy tokens — the ranking test relies on score beating
  // recency (r100 must sort FIRST despite being oldest).
  cardRow('100', 'Блендер Bosch SilentMix', {
    brand: { name: 'Bosch' },
    short_description: 'блендер',
    created_at: '2026-01-01T00:00:00Z',
  }),
  cardRow('101', 'Блендер Philips Pro', {
    brand: { name: 'Philips' },
    created_at: '2026-01-05T00:00:00Z',
  }),
  cardRow('102', 'Чашка керамічна', {}),
  cardRow('103', 'Мультипіч TEFAL 300', { brand: { name: 'TEFAL' } }),
  // Dedicated to the appliedSearch display tests: a doubled-letter word so
  // the intact token «сковорідка» matches verbatim while the LONGER gap
  // candidate «сковорідк_а» matches too — the original must still win.
  // Deliberately contains none of the other tests' probe tokens («блендер»,
  // «мультипіч», «tefal», …) so every pre-existing total stays unchanged.
  cardRow('200', 'Сковорідкаа Tebo', {
    created_at: '2026-01-12T00:00:00Z',
  }),
  // Display tie-break fixtures (2026-09-05): equal-length literal-vs-wildcard
  // ties need two DIFFERENT words per token, because a literal candidate is a
  // transposition (or deletion) of the token while a same-length wildcard is
  // its substitution — one word cannot be both. Engineered minimal pairs:
  //   «tefla» → substitution «te_la» hits «Tesla» (300), transposition
  //   «tefal» hits «TEFAL» (103) — literal must win the tie;
  //   «ztefal» → deletions «tefal» and «zefal» — two literals, earliest wins;
  //   «zebo» → gaps «ze_bo» and «zeb_o» both hit «Zebbo» — two wildcards,
  //   earliest wins (the display then recovers the real word «zebbo»).
  // None of these words collides with the other tests' probe tokens, so every
  // pre-existing total stays unchanged.
  cardRow('300', 'Павербанк Tesla Slim', {
    created_at: '2026-01-13T00:00:00Z',
  }),
  cardRow('301', 'Насос Zefal Papillon', {
    created_at: '2026-01-14T00:00:00Z',
  }),
  cardRow('302', 'Дуршлаг Zebbo', {
    created_at: '2026-01-15T00:00:00Z',
  }),
  // Wildcard-display recovery fixtures (2026-09-05):
  //   - 303: the token «сковорока» probes the gap «сковоро_ка», whose regex
  //     matches INSIDE the compound word «Електросковородка» — recovery must
  //     yield the matched substring «сковородка», not the whole word;
  //   - 304–306: the token «zumo» probes the gap «zu_mo», which matches THREE
  //     different words («zumbo», «zummo» ×2 rows) — the most FREQUENT
  //     recovered word must win («zummo»), even though the singleton «zumbo»
  //     row comes FIRST in dataset order (a first-occurrence policy would
  //     wrongly show it). 304 is deliberately the oldest of the three.
  cardRow('303', 'Електросковородка Зліт', {
    created_at: '2026-01-16T00:00:00Z',
  }),
  cardRow('304', 'Термокружка Zumbo', {
    created_at: '2026-01-16T00:00:00Z',
  }),
  cardRow('305', 'Термокружка Zummo', {
    created_at: '2026-01-17T00:00:00Z',
  }),
  cardRow('306', 'Термокружка Zummo Pro', {
    created_at: '2026-01-18T00:00:00Z',
  }),
];

// --- fake PostgREST ---------------------------------------------------------

function stripOuterParens(expr: string): string {
  const e = expr.trim();
  if (!e.startsWith('(')) return e;
  let depth = 0;
  for (let i = 0; i < e.length; i += 1) {
    if (e[i] === '(') depth += 1;
    else if (e[i] === ')') {
      depth -= 1;
      if (depth === 0 && i !== e.length - 1) return e; // closes early
    }
  }
  return depth === 0 ? e.slice(1, -1) : e;
}

/** SQL ILIKE value → RegExp: `_` = exactly one unknown char, case-folded. */
function ilikeValueToRegExp(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/_/g, '.'), 'i');
}

function orExprMatches(row: Row, expr: string): boolean {
  const inner = stripOuterParens(expr);
  return inner.split(',').some((pred) => {
    const marker = '.ilike.';
    const dot = pred.indexOf(marker);
    if (dot === -1) throw new Error(`unexpected predicate: ${pred}`);
    const field = pred.slice(0, dot);
    const value = pred
      .slice(dot + marker.length)
      .replace(/^%/, '')
      .replace(/%$/, '');
    return ilikeValueToRegExp(value).test(String(row[field] ?? ''));
  });
}

function matchRows(ors: string[]): Row[] {
  return ROWS.filter((row) => ors.every((expr) => orExprMatches(row, expr)));
}

interface LoggedRequest {
  method: string;
  prefer: string;
  or: string[];
}

const reqLog: LoggedRequest[] = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const entry: LoggedRequest = {
    method: req.method ?? 'GET',
    prefer: String(req.headers.prefer ?? ''),
    or: url.searchParams.getAll('or'),
  };
  reqLog.push(entry);

  const wantsCount =
    entry.method === 'HEAD' || entry.prefer.includes('count=exact');
  if (wantsCount) {
    res.writeHead(200, { 'Content-Range': `*/${matchRows(entry.or).length}` });
    res.end();
    return;
  }

  const matched = matchRows(entry.or);
  const from = Number(url.searchParams.get('offset') ?? 0);
  const lim = Number(url.searchParams.get('limit') ?? 1000);
  const slice = matched.slice(from, Math.min(from + lim, matched.length));
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Range': `${slice.length > 0 ? `${from}-${from + slice.length - 1}` : '*/0'}/${matched.length}`,
  });
  res.end(JSON.stringify(slice));
});
server.unref();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

// catalog.ts creates its Supabase client at module load — the URL must be
// final BEFORE the import, so the whole file runs against the fake above.
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${
  (server.address() as { port: number }).port
}`;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';

const {
  fetchCatalogProducts,
  FALLBACK_MAX_RETRIES,
  identifyAppliedSearch,
  recoverWildcardDisplay,
} = await import('../app/lib/catalog.ts');

const countCalls = (from: number): LoggedRequest[] =>
  reqLog
    .slice(from)
    .filter((r) => r.method === 'HEAD' || r.prefer.includes('count=exact'));

test('FALLBACK: «блендерр» (0 hits) retries with «блендер» and returns results', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'блендерр' });
  const counts = countCalls(before);

  // exactly one retry: the original count + one relaxed count
  assert.equal(counts.length, 2);
  const originalCount = counts[0];
  const retryCount = counts[1];
  assert.ok(originalCount !== undefined && retryCount !== undefined, 'original + retry count calls expected');
  // the ORIGINAL count carried the typo token…
  assert.ok(originalCount.or.some((e) => e.includes('%блендерр%')));
  // …the retry REPLACED it with the trimmed term
  assert.ok(retryCount.or.some((e) => e.includes('%блендер%')));
  assert.ok(!retryCount.or.some((e) => e.includes('%блендерр%')));

  assert.equal(page.total, 2);
  assert.equal(page.products.length, 2);
  assert.equal(page.appliedSearch, 'блендер');

  // the data query must use the SAME relaxed conditions (count/data sync)
  const dataCall = reqLog[reqLog.length - 1];
  assert.ok(dataCall !== undefined, 'data request must be logged');
  assert.ok(dataCall.or.some((e) => e.includes('%блендер%')));
  assert.ok(!dataCall.or.some((e) => e.includes('%блендерр%')));
});

test('FALLBACK: matching query runs exactly one count, never relaxes', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'блендер' });
  assert.equal(countCalls(before).length, 1);
  assert.equal(page.total, 2);
  assert.equal(page.appliedSearch ?? null, null);
});

test('FALLBACK: short query below the floor is never relaxed', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'чай' });
  // 'чай' (3 chars) → relaxSearchTerm yields [] → no retry counts
  assert.equal(countCalls(before).length, 1);
  assert.equal(page.total, 0);
  assert.equal(page.appliedSearch ?? null, null);
  // existing EmptyState contract: no products, honest zero
  assert.equal(page.products.length, 0);
});

test('FALLBACK: floor of 4 chars — a 5-char token trims exactly once, then one fuzzy probe', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'щітка' });
  // 'щітка'(5) → one trim variant 'щітк'(4) → miss → ONE batched fuzzy
  // probe (layout/deletions/transpositions/gaps) → miss → stop. 3 counts.
  assert.equal(countCalls(before).length, 3);
  assert.equal(page.total, 0);
  assert.equal(page.appliedSearch ?? null, null);
});

test('FALLBACK: retry budget is capped — trim ladder + ONE fuzzy probe', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({
    search: 'abcdefgh ijklmnop qrstuvwx yzabcdef', // 4 trimmable junk tokens
  });
  // 1 original + FALLBACK_MAX_RETRIES trim counts + 1 fuzzy probe = 5.
  // The probe misses (junk tokens share no affixes with the dataset), so
  // NO further requests happen — the budget bound is observable here.
  assert.equal(countCalls(before).length, 1 + FALLBACK_MAX_RETRIES + 1);
  assert.equal(page.total, 0);
  assert.equal(page.appliedSearch ?? null, null);

  // probe shape: one or= param per token, OR-ing [original, ...variants]
  const probe = countCalls(before)[countCalls(before).length - 1];
  assert.ok(probe !== undefined, 'fuzzy probe count call expected');
  assert.equal(probe.or.length, 4);
  const firstParam = probe.or[0];
  assert.ok(firstParam !== undefined);
  assert.ok(firstParam.includes('%abcdefgh%'), 'original stays in the probe OR set');
  assert.ok(firstParam.includes('%bcdefgh%'), 'deletion variant present');
  assert.ok(firstParam.includes('%фисвуапр%'), 'layout remap present');
});

test('FALLBACK: multi-token relaxes only the broken token (AND preserved)', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'bosch блендерр' });
  const counts = countCalls(before);

  assert.equal(counts.length, 2); // original + first (successful) retry
  const retryCount = counts[1];
  assert.ok(retryCount !== undefined, 'retry count call expected');
  const retryOr = retryCount.or.join('|');
  assert.ok(retryOr.includes('%bosch%'), 'intact token must stay verbatim');
  assert.ok(retryOr.includes('%блендер%'), 'broken token must be relaxed');
  assert.ok(!retryOr.includes('%блендерр%'), 'typo must not survive the retry');

  // AND semantics: only the Bosch blender matches BOTH tokens
  assert.equal(page.total, 1);
  assert.equal(page.appliedSearch, 'bosch блендер');
});

test('FALLBACK: rotation identifies the problem token even when it is shorter', async () => {
  // 'мультипіч' matches, 'TEFALX' doesn't — the retry must try trimming the
  // SECOND-longest token after the first variant missed.
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'мультипіч TEFALX' });
  const counts = countCalls(before);

  assert.equal(counts.length, 1 + 2); // original + two variants, second hits
  assert.equal(page.total, 1);
  assert.equal(page.appliedSearch, 'мультипі TEFAL');
});

test('FALLBACK: pagination stays consistent with the adopted relaxed total', async () => {
  const page1 = await fetchCatalogProducts({
    search: 'блендерр',
    size: 1,
    page: 1,
  });
  assert.equal(page1.total, 2);
  assert.equal(page1.products.length, 1);
  assert.equal(page1.page, 1);

  const page2 = await fetchCatalogProducts({
    search: 'блендерр',
    size: 1,
    page: 2,
  });
  assert.equal(page2.total, 2);
  assert.equal(page2.products.length, 1);
  assert.equal(page2.page, 2);
  assert.equal(page2.appliedSearch, 'блендер');
});

test('FALLBACK: specials-only query keeps the no-filter contract', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: '%","%(' });
  // buildSearchConditions → null → NO search filter at all → every product
  assert.equal(page.total, ROWS.length);
  assert.equal(page.appliedSearch ?? null, null);
  assert.equal(countCalls(before).length, 1);
});

// ---- Fuzzy fallback (Phase 1): transposition / deletion / gap / layout -----
//
// Contract: the fuzzy probe runs ONLY after the original query and every
// trim variant matched zero rows; it costs exactly ONE extra count request;
// the adopted probe conditions flow into BOTH the count and the data query;
// appliedSearch is identified from the returned rows.

test('FUZZY: leading transposition «лбендер» finds «блендер» via one batched probe', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'лбендер' });
  const counts = countCalls(before);

  // 1 original + 3 progressive trim misses («лбенде», «лбенд», «лбен» —
  // none is a stem of any dataset name) + 1 fuzzy probe — NO retry storm
  assert.equal(counts.length, 5);
  const probe = counts[4];
  assert.ok(probe !== undefined);
  assert.ok(
    probe.or.some((e) => e.includes('%блендер%')),
    'probe must OR the transposition candidate «блендер»'
  );
  // the probe OR-set always keeps the token's ORIGINAL (trim-era tokens are
  // indistinguishable from del@last variants, so absence cannot be asserted)
  const probePreds = probe.or.flatMap((e) => e.split(','));
  assert.ok(
    probePreds.some((p) => p.endsWith('.ilike.%лбендер%')),
    'probe keeps the original token in the OR set'
  );

  assert.equal(page.total, 2);
  assert.equal(page.products.length, 2);
  // «блендер» (transposition) is emitted BEFORE the «бленде»-shaped
  // deletion candidates? No — position-major puts del@0 first; «бендер»
  // misses, so the first MATCHING candidate is the transposition.
  assert.equal(page.appliedSearch, 'блендер');
});

test('FUZZY: missing letter «блндер» via ILIKE gap «_», count/data consistent', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'блндер' });
  const counts = countCalls(before);

  // original + 2 trim misses («блнде», «блнд» — floor stops the ladder) + probe
  assert.equal(counts.length, 4);
  const probe = counts[3];
  assert.ok(probe !== undefined);
  assert.ok(
    probe.or.some((e) => e.includes('%бл_ндер%')),
    'probe must include the one-char gap candidate'
  );

  // BOTH count and data queries carry the SAME probe condition set
  assert.equal(page.total, 2);
  const dataCall = reqLog[reqLog.length - 1];
  assert.ok(dataCall !== undefined);
  assert.ok(
    dataCall.or.some((e) => e.includes('%бл_ндер%')),
    'data query must use the adopted probe conditions'
  );

  assert.equal(page.appliedSearch, 'блендер');
  assert.deepEqual(page.products.map((p) => p.id), ['100', '101']);
  // The gap candidate «бл_ндер» wins selection (for a missing-letter token
  // the literal «блендер» is NOT a 1-edit candidate — insertion of the
  // unknown letter is not invertible — so the gap pattern is the only 7-char
  // match), but the DISPLAY recovers the real word from the matched rows:
  // the candidate's regex re-run over «Блендер…» yields «блендер». The probe
  // conditions above keep the wildcard form.
});

test('FUZZY: extra letter at the start «бблендер» via deletion', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'бблендер' });
  const counts = countCalls(before);

  assert.equal(counts.length, 5); // original + 3 trim misses + probe
  const probe = counts[4];
  assert.ok(probe !== undefined);
  assert.ok(probe.or.some((e) => e.includes('%блендер%')));

  assert.equal(page.total, 2);
  assert.equal(page.appliedSearch, 'блендер');

});

test('FUZZY: wrong keyboard layout «ktylth» → «лендер»', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'ktylth' });
  const counts = countCalls(before);

  assert.equal(counts.length, 4); // original + 2 trim misses + probe
  const probe = counts[3];
  assert.ok(probe !== undefined);
  assert.ok(
    probe.or.some((e) => e.includes('%лендер%')),
    'probe must OR the layout-remapped candidate'
  );

  assert.equal(page.total, 2);
  assert.equal(page.appliedSearch, 'лендер');
});

test('FUZZY: multi-token probes every token, intact tokens stay exact', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'bosch блндер' });
  const counts = countCalls(before);

  // 1 original + 3 trim variants (breadth: блнде, bosch, then блнд) + 1 probe
  assert.equal(counts.length, 5);
  const probe = counts[4];
  assert.ok(probe !== undefined);
  assert.equal(probe.or.length, 2, 'one or= param per token');
  const boschParam = probe.or[0];
  const typoParam = probe.or[1];
  assert.ok(boschParam !== undefined && typoParam !== undefined);
  assert.ok(
    boschParam.includes('%bosch%'),
    'intact token keeps its exact ILIKE in the probe OR set'
  );
  assert.ok(typoParam.includes('%бл_ндер%'));

  // AND semantics: only the Bosch blender satisfies both tokens
  assert.equal(page.total, 1);
  assert.deepEqual(page.products.map((p) => p.id), ['100']);
  assert.equal(page.appliedSearch, 'bosch блендер');
});

test('FUZZY: ranking ranks against adopted appliedSearch, beating recency', async () => {
  // «блндер» → gap candidate «бл_ндер» wins selection, the display recovers
  // the real word «блендер» from the matched rows → rank tokens «блендер».
  // r100 (OLDEST, 2026-01-01) scores higher: its description also hits the
  // token. Plain recency would put r101 first — ranking must invert that.
  const page = await fetchCatalogProducts({ search: 'блндер' });
  assert.equal(page.total, 2);
  assert.deepEqual(page.products.map((p) => p.id), ['100', '101']);
});

test('FUZZY: pagination stays consistent with the adopted probe total', async () => {
  const page1 = await fetchCatalogProducts({
    search: 'блндер',
    size: 1,
    page: 1,
  });
  assert.equal(page1.total, 2);
  assert.equal(page1.products.length, 1);
  assert.equal(page1.page, 1);
  assert.equal(page1.appliedSearch, 'блендер');

  const page2 = await fetchCatalogProducts({
    search: 'блндер',
    size: 1,
    page: 2,
  });
  assert.equal(page2.total, 2);
  assert.equal(page2.products.length, 1);
  assert.equal(page2.page, 2);
  // page 2's only row is «Блендер Philips Pro» — the recovered word is the
  // same, so the notice is stable across pages even though recovery runs on
  // each page's own rows.
  assert.equal(page2.appliedSearch, 'блендер');
  const dataCall = reqLog[reqLog.length - 1];
  assert.ok(dataCall !== undefined);
  assert.ok(dataCall.or.some((e) => e.includes('%бл_ндер%')));
});

test('FUZZY: probe never fires when the trim ladder already matched', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'блендерр' });
  assert.equal(countCalls(before).length, 2); // original + successful trim only
  assert.equal(page.appliedSearch, 'блендер');
});

test('FUZZY: tokens below the floor produce no probe at all', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'чай дом' });
  assert.equal(countCalls(before).length, 1);
  assert.equal(page.total, 0);
  assert.equal(page.appliedSearch ?? null, null);
});

// ---- Fuzzy appliedSearch DISPLAY: human-readable candidate choice ----------
//
// Contract: the notice term is a DISPLAY decision only — probe conditions,
// total and pagination are unchanged. Per token: an intact original always
// displays verbatim; otherwise the LONGEST matching candidate wins (a
// deletion stem is shorter than the word it came from — the audit case where
// the notice showed a truncated stem instead of a readable word); at equal
// length the LITERAL (no «_») candidate beats the wildcard one; same
// length and same wildcard-ness keep the earliest emitted candidate. A
// WILDCARD winner is then rewritten into the REAL word it matched: the
// candidate's regex is re-run over the probe rows and the most FREQUENT
// recovered word displays («бл_ндер» → «блендер») — ties keep the word seen
// first; when nothing can be recovered (probe/data race) the honest
// wildcard stays. Literal winners are never touched.

test('FUZZY display: longest matched candidate wins over the earlier stem («бендер»)', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'бендер' });
  // original + 2 trim misses («бенде», «бенд») + 1 probe
  assert.equal(countCalls(before).length, 4);
  assert.equal(page.total, 2);
  // The deletion stem «ендер» (emitted first, at position 0) matches too,
  // but the longer gap candidate «б_ендер» wins selection; since the winner
  // is a wildcard, the display recovers the real word from the matched rows
  // («Блендер…») — the notice reads «блендер», not the technical «б_ендер».
  assert.equal(page.appliedSearch, 'блендер');
});

test('FUZZY display: only the stem matched — it is shown honestly («нендер»)', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'нендер' });
  // original + 2 trim misses + 1 probe
  assert.equal(countCalls(before).length, 4);
  assert.equal(page.total, 2);
  // «ендер» (deletion stem) is the ONLY candidate matching any row — no
  // longer candidate exists, so the notice must show the stem itself rather
  // than keeping the unmatched original.
  assert.equal(page.appliedSearch, 'ендер');
  assert.deepEqual(page.products.map((p) => p.id), ['100', '101']);
});

test('FUZZY display: intact token stays verbatim even when a longer variant matches', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'сковорідка tebbo' });
  // 3 trim retries (breadth-first across both tokens) all miss, then probe
  assert.equal(countCalls(before).length, 1 + FALLBACK_MAX_RETRIES + 1);
  assert.equal(page.total, 1);
  assert.deepEqual(page.products.map((p) => p.id), ['200']);
  // Token «сковорідка» matches row 200 verbatim, but the LONGER gap
  // candidate «сковорідк_а» matches too (the row word is «сковорідкаа») —
  // an intact token must never be rewritten into a wildcard form. (The old
  // first-match rule showed «коворідка»; a longest-without-original-first
  // policy would show «сковорідк_а».) The broken token keeps its only
  // matched candidate «tebo».
  assert.equal(page.appliedSearch, 'сковорідка tebo');
});

test('FUZZY display: literal beats equal-length wildcard («tefla»)', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'tefla' });
  // original + 1 trim miss («tefl») + 1 probe
  assert.equal(countCalls(before).length, 3);
  // The substitution wildcard «te_la» is emitted BEFORE the transposition
  // «tefal» (position-major: sub at position 2 precedes the transposition at
  // position 3); both are 5 chars and both match a row — «te_la» hits
  // «Tesla» (row 300), «tefal» hits «TEFAL» (row 103). The old earliest-wins
  // tie rule displayed the wildcard «te_la»; the literal word must win.
  assert.equal(page.total, 2);
  assert.equal(page.appliedSearch, 'tefal');
});

test('FUZZY display: two literals tie — earliest emitted wins («ztefal»)', async () => {
  const page = await fetchCatalogProducts({ search: 'ztefal' });
  // Deletions «tefal» (position 0) and «zefal» (position 1) both match (rows
  // 103 and 301) at the same length; the literal-preference rule must not
  // reorder same-kind ties — the earliest emitted stays.
  assert.equal(page.total, 2);
  assert.equal(page.appliedSearch, 'tefal');
});

test('FUZZY display: two wildcards tie — earliest emitted wins («zebo»)', async () => {
  const page = await fetchCatalogProducts({ search: 'zebo' });
  // Both gap candidates «ze_bo» (position 2) and «zeb_o» (position 3) are 5
  // chars and match «Zebbo» (row 302); both carry «_», so the literal rule
  // does not apply and the earliest emitted stays (a last-longest or
  // prefer-later policy would show «zeb_o»). (The short deletion «ebo» also
  // matches «Tebo» (row 200) but loses on length.) The wildcard winner is
  // then recovered: row 200 holds no «ze?bo» shape at all, row 302 yields
  // the real word «zebbo» — per-row non-matches are simply skipped.
  assert.equal(page.total, 2);
  assert.equal(page.appliedSearch, 'zebbo');
});

// ---- Wildcard display RECOVERY: pure-helper contracts (2026-09-05) ---------
//
// The wildcard rewrite lives in two PURE helpers exported for these tests:
// identifyAppliedSearch (candidate selection + recovery integration) and
// recoverWildcardDisplay (regex re-run over the matched rows). The runtime
// tests above pin the wired behavior; these pin the edges the fake-PostgREST
// harness cannot reach (a probe/data race, compound-word internals).

test('FUZZY display recovery: frequency beats first occurrence across rows («zumo»)', async () => {
  // Probe gap «zu_mo» matches three DIFFERENT words: «zumbo» (row 304, FIRST
  // in dataset order) and «zummo» (rows 305, 306). Unranked path (explicit
  // sort) feeds rows in dataset order, so a first-occurrence policy would
  // display «zumbo»; the most FREQUENT word «zummo» must win instead.
  const before = reqLog.length;
  const page = await fetchCatalogProducts({
    search: 'zumo',
    sort: 'price_asc',
  });
  // 4-char token is below no-trim floor: 1 original + 1 probe, no trims.
  assert.equal(countCalls(before).length, 2);
  assert.equal(page.total, 3);
  assert.equal(page.appliedSearch, 'zummo');

  // Ranked path (default sort) feeds rows in created_at desc order — the
  // frequency choice must be independent of row ordering.
  const ranked = await fetchCatalogProducts({ search: 'zumo' });
  assert.equal(ranked.total, 3);
  assert.equal(ranked.appliedSearch, 'zummo');
});

test('FUZZY display recovery: substring inside a compound word («сковоро_ка»)', () => {
  const row303 = ROWS.find((r) => r.id === '303');
  assert.ok(row303 !== undefined);
  // The gap candidate «сковоро_ка» matches INSIDE «Електросковородка…» —
  // recovery must yield the matched substring «сковородка» (exactly the
  // candidate's length: one «.» per «_», no quantifiers), never the whole
  // compound word and never a fabricated form.
  const recovered = recoverWildcardDisplay('сковоро_ка', [
    { id: '303', name: String(row303.name) },
  ]);
  assert.equal(recovered, 'сковородка');
});

test('FUZZY display recovery: no match in rows (data race) → null → wildcard fallback', () => {
  // A race between the probe and the data query can hand identifyAppliedSearch
  // rows that no longer contain the matched word: recovery must return null
  // (the caller keeps the honest wildcard candidate) — never a guessed word,
  // never a crash.
  assert.equal(recoverWildcardDisplay('бл_ндер', [{ id: 'x', name: 'Кофемолка' }]), null);
  assert.equal(recoverWildcardDisplay('бл_ндер', []), null);
  // Literal candidates never go through recovery at all.
  assert.equal(recoverWildcardDisplay('блендер', [{ id: 'x', name: 'Кофемолка' }]), null);

  // End-to-end guard on the same principle: rows matching nothing keep the
  // original token display contract (null notice), never a fabricated term.
  const applied = identifyAppliedSearch([{ id: 'x', name: 'Кофемолка' }], {
    tokens: ['блндер'],
    candidates: [{ tokenIndex: 0, variant: 'бл_ндер' }],
    conditions: [],
  });
  assert.equal(applied, null);
});

test('FUZZY display recovery: literal winner is untouched by recovery', () => {
  // Rows hold BOTH tie words: the literal «tefal» and the wildcard «te_la»
  // both match, equal length — the literal wins selection, and recovery must
  // not rewrite it (no «_», so recoverWildcardDisplay is never consulted;
  // the notice shows the plain word, not the wildcard's own match «tesla»).
  const applied = identifyAppliedSearch(
    [
      { id: '300', name: 'Павербанк Tesla Slim' },
      { id: '103', name: 'Мультипіч TEFAL 300' },
    ],
    {
      tokens: ['tefla'],
      candidates: [
        { tokenIndex: 0, variant: 'te_la' },
        { tokenIndex: 0, variant: 'tefal' },
      ],
      conditions: [],
    }
  );
  assert.equal(applied, 'tefal');
});
