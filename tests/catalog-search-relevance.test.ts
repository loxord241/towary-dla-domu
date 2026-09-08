/**
 * Search relevance ranking (2026-09 audit, search C1) — RUNTIME tests.
 *
 * Contract under test (drives the REAL supabase-js pipeline against a local
 * fake PostgREST, same pattern as tests/catalog-search-fallback.test.ts):
 *   - with an active search and the DEFAULT «нові» sort, matched rows are
 *     ordered by textual relevance instead of raw recency;
 *   - the match SET, count, pagination and typo-fallback behavior are
 *     unchanged — only the ORDER of results changes;
 *   - an explicitly chosen sort (price) keeps SQL ordering: relevance never
 *     overrides an explicit user choice;
 *   - a search whose match set exceeds SEARCH_RANK_SCAN_LIMIT keeps the
 *     plain SQL ordering (ranking a truncated set would be arbitrary);
 *   - no search → the non-search path is untouched (recency order).
 *
 * The fake honours or= (comma-separated predicates OR across fields, params
 * AND together), order= (column.dir, comma-joined), HEAD/Prefer counts via
 * Content-Range and offset/limit windows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

interface Row {
  [key: string]: unknown;
}

function cardRow(
  id: string,
  name: string,
  createdAt: string,
  extras: {
    short_description?: string | null;
    sku?: string;
    yugcontract_id?: string;
    price?: number;
    availability_status?: string;
  } = {}
): Row {
  return {
    id,
    name,
    slug: id,
    price: extras.price ?? 100,
    old_price: null,
    currency: 'UAH',
    availability_status: extras.availability_status ?? 'in_stock',
    short_description: extras.short_description ?? null,
    sku: extras.sku ?? `YC-${id}`,
    yugcontract_id: extras.yugcontract_id ?? id,
    created_at: createdAt,
    brand: null,
    images: [
      { id: `img-${id}`, product_id: id, image_url: 'img', is_main: true, sort_order: 0 },
    ],
  };
}

// --- dataset (recency ≠ relevance on purpose) -------------------------------
const ROWS: Row[] = [
  // «блендер» set: the exact match is the OLDEST row — recency ordering is
  // exactly inverted vs relevance. m1/m2/m3 also contain «блендер» (they are
  // the multi-token set for «tefal блендер»), so they appear in both tests.
  cardRow('r1', 'Соковижималка Philips', '2026-01-05T00:00:00Z'), // no match
  cardRow('r2', 'Блендер', '2026-01-01T00:00:00Z', { price: 500 }), // exact
  cardRow('r3', 'Блендер занурювальний', '2026-01-02T00:00:00Z', { price: 400 }),
  cardRow('r4', 'Міксер з чашею блендер', '2026-01-04T00:00:00Z'), // contains
  // multi-token set for «tefal блендер»:
  cardRow('m1', 'TEFAL блендер', '2026-01-06T00:00:00Z'), // full phrase = exact
  cardRow('m2', 'Блендер TEFAL Про', '2026-01-07T00:00:00Z', { price: 200 }),
  cardRow('m3', 'Блендер погружний', '2026-01-08T00:00:00Z', {
    short_description: 'від TEFAL',
    price: 300,
  }), // one name token + one desc token
  cardRow('m4', 'TEFAL кавомолка', '2026-01-09T00:00:00Z'), // «блендер»-no
  // SKU set for «7061899»:
  cardRow('s1', 'Ніж GORENJE', '2026-01-10T00:00:00Z', {
    sku: 'YC-7061899',
    yugcontract_id: '7061899',
  }), // SKU-only match
  cardRow('s2', 'Ножі 7061899 серія', '2026-01-11T00:00:00Z'), // name contains
  // identical twins: equal scores → created_at desc, then id desc
  cardRow('t1', 'Дублёр блендер', '2026-01-12T00:00:00Z'),
  cardRow('t2', 'Дублёр блендер', '2026-01-12T00:00:00Z'),
  // availability-tier set for «аерогриль»: equal (exact) scores, the
  // in-stock row is the OLDER one — the tier must invert recency.
  cardRow('a1', 'Аерогриль', '2026-01-01T00:00:00Z'), // in stock, older
  cardRow('a2', 'Аерогриль', '2026-01-02T00:00:00Z', {
    availability_status: 'out_of_stock',
  }), // OOS, newer
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
    return String(row[field] ?? '')
      .toLowerCase()
      .includes(value.toLowerCase());
  });
}

function matchRows(ors: string[]): Row[] {
  return ROWS.filter((row) => ors.every((expr) => orExprMatches(row, expr)));
}

/** order=price.asc,id.asc — supabase-js emits one order key per .order(). */
function applyOrder(rows: Row[], orders: string[]): Row[] {
  const keys = orders
    .flatMap((entry) => entry.split(','))
    .map((part) => {
      const [col, dir = 'asc'] = part.split('.');
      assert.ok(col !== undefined, 'order column must be present');
      return { col, desc: dir.startsWith('desc') };
    });
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const { col, desc } of keys) {
      const av = a[col];
      const bv = b[col];
      if (av === bv) continue;
      const cmp = String(av) < String(bv) ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
  return sorted;
}

interface LoggedRequest {
  method: string;
  prefer: string;
  or: string[];
  order: string[];
  offset: number;
  limit: number;
}

const reqLog: LoggedRequest[] = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const entry: LoggedRequest = {
    method: req.method ?? 'GET',
    prefer: String(req.headers.prefer ?? ''),
    or: url.searchParams.getAll('or'),
    order: url.searchParams.getAll('order'),
    offset: Number(url.searchParams.get('offset') ?? 0),
    limit: Number(url.searchParams.get('limit') ?? 1000),
  };
  reqLog.push(entry);

  const matched = applyOrder(matchRows(entry.or), entry.order);

  if (entry.method === 'HEAD' || entry.prefer.includes('count=exact')) {
    res.writeHead(200, { 'Content-Range': `*/${matched.length}` });
    res.end();
    return;
  }

  const slice = matched.slice(
    entry.offset,
    Math.min(entry.offset + entry.limit, matched.length)
  );
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Range': `${slice.length > 0 ? `${entry.offset}-${entry.offset + slice.length - 1}` : '*/0'}/${matched.length}`,
  });
  res.end(JSON.stringify(slice));
});
server.unref();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${
  (server.address() as { port: number }).port
}`;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';

const {
  fetchCatalogProducts,
  searchRelevanceScore,
  rankSearchResults,
  SEARCH_RANK_SCAN_LIMIT,
} = await import('../app/lib/catalog.ts');

const countCalls = (from: number): LoggedRequest[] =>
  reqLog
    .slice(from)
    .filter((r) => r.method === 'HEAD' || r.prefer.includes('count=exact'));

const dataCalls = (from: number): LoggedRequest[] =>
  reqLog.slice(from).filter((r) => r.method === 'GET');

// «блендер» matches: r2 (exact 1900) > prefix tier {m3 01-08, m2 01-07,
// r3 01-02} > contains tier {t2/t1 01-12, m1 01-06, r4 01-04}.
const BLENDER_RANKED = ['r2', 'm3', 'm2', 'r3', 't2', 't1', 'm1', 'r4'];

// ---- PURE scoring / ranking -------------------------------------------------

test('SCORE: exact name > prefix > contains > sku > short_description', () => {
  const query = 'блендер';
  const exact = searchRelevanceScore({ id: '1', name: 'Блендер' }, query);
  const prefix = searchRelevanceScore({ id: '2', name: 'Блендер Bosch' }, query);
  const contains = searchRelevanceScore({ id: '3', name: 'Чаша для блендера' }, query);
  const sku = searchRelevanceScore(
    { id: '4', name: 'Міксер X', sku: 'YC-7061899', yugcontract_id: '7061899' },
    '7061899'
  );
  const desc = searchRelevanceScore(
    { id: '5', name: 'Міксер X', short_description: 'блендер для кухні' },
    query
  );
  assert.ok(exact > prefix, `${exact} !> ${prefix}`);
  assert.ok(prefix > contains, `${prefix} !> ${contains}`);
  assert.ok(contains > sku, `${contains} !> ${sku}`);
  assert.ok(sku > desc, `${sku} !> ${desc}`);
});

test('SCORE: multi-token query considers the overall query, not only token 1', () => {
  const query = 'tefal блендер';
  const phrase = searchRelevanceScore({ id: '1', name: 'TEFAL блендер' }, query);
  const allTokens = searchRelevanceScore(
    { id: '2', name: 'Блендер TEFAL Про' }, // reversed order → no phrase hit
    query
  );
  const oneNameToken = searchRelevanceScore(
    { id: '3', name: 'Блендер погружний' },
    query
  );
  const descToken = searchRelevanceScore(
    { id: '4', name: 'Міксер X', short_description: 'від TEFAL' },
    query
  );
  // phrase containment beats scattered tokens; covering both tokens beats one
  assert.ok(phrase > allTokens, `${phrase} !> ${allTokens}`);
  assert.ok(allTokens > oneNameToken, `${allTokens} !> ${oneNameToken}`);
  assert.ok(oneNameToken > descToken, `${oneNameToken} !> ${descToken}`);
});

test('SCORE: sku and yugcontract_id hits are equivalent tiers', () => {
  const sku = searchRelevanceScore(
    { id: '1', name: 'X', sku: 'YC-7061899' },
    '7061899'
  );
  const ycid = searchRelevanceScore(
    { id: '2', name: 'X', yugcontract_id: '7061899_du' },
    '7061899'
  );
  assert.equal(sku, ycid);
});

test('SCORE: reserved grammar chars are neutralized before scoring', () => {
  // the raw URL term can carry specials; scoring must mirror the conditions,
  // which only ever see the sanitized tokens
  const raw = searchRelevanceScore({ id: '1', name: 'Блендер' }, 'блендер%"');
  const clean = searchRelevanceScore({ id: '1', name: 'Блендер' }, 'блендер');
  assert.equal(raw, clean);
});

test('RANK: deterministic order, ties keep created_at desc then id desc', () => {
  const rows = [
    { id: 'a', name: 'Блендер X', created_at: '2026-01-01T00:00:00Z' },
    { id: 'b', name: 'Блендер', created_at: '2026-01-01T00:00:00Z' }, // same ts
    { id: 'c', name: 'Блендер', created_at: '2026-01-02T00:00:00Z' }, // newest
  ];
  const ranked = rankSearchResults(rows, 'блендер').map((r) => r.id);
  // c first (newest of the exact matches), then b (id desc), then a (weaker)
  assert.deepEqual(ranked, ['c', 'b', 'a']);
});

test('RANK: input array is never mutated', () => {
  const rows = [
    { id: 'a', name: 'Міксер', created_at: '2026-01-02T00:00:00Z' },
    { id: 'b', name: 'Блендер', created_at: '2026-01-01T00:00:00Z' },
  ];
  const copy = [...rows];
  rankSearchResults(rows, 'блендер');
  assert.deepEqual(rows, copy);
});

// ---- Availability tier (2026-09 audit) — SECONDARY after relevance ---------
// The sort control promises «Спочатку в наявності», but the ranked search
// path ignored availability. Now equal-relevance ties put in-stock rows
// first; relevance itself is never overridden.

test('RANK: equal scores → in-stock first, even when it is the older row', () => {
  const ranked = rankSearchResults(
    [
      { id: 'oos', name: 'Аерогриль', created_at: '2026-01-02T00:00:00Z', availability_status: 'out_of_stock' },
      { id: 'stk', name: 'Аерогриль', created_at: '2026-01-01T00:00:00Z', availability_status: 'in_stock' },
    ],
    'аерогриль'
  ).map((r) => r.id);
  assert.deepEqual(ranked, ['stk', 'oos']);
});

test('RANK: availability tier never overrides relevance', () => {
  const ranked = rankSearchResults(
    [
      { id: 'stk-weak', name: 'Чаша для блендера', created_at: '2026-01-09T00:00:00Z', availability_status: 'in_stock' },
      { id: 'oos-exact', name: 'Блендер', created_at: '2026-01-01T00:00:00Z', availability_status: 'out_of_stock' },
    ],
    'блендер'
  ).map((r) => r.id);
  // the exact out-of-stock match must keep beating the weak in-stock one
  assert.deepEqual(ranked, ['oos-exact', 'stk-weak']);
});

test('RANK: rows without availability_status count as available (backward compat)', () => {
  const ranked = rankSearchResults(
    [
      { id: 'oos', name: 'Аерогриль XL', created_at: '2026-01-02T00:00:00Z', availability_status: 'out_of_stock' },
      { id: 'bare', name: 'Аерогриль Pro', created_at: '2026-01-01T00:00:00Z' },
    ],
    'аерогриль'
  ).map((r) => r.id);
  assert.deepEqual(ranked, ['bare', 'oos']);
});

test('RANK: only out_of_stock demotes; unknown/limited statuses stay available', () => {
  const ranked = rankSearchResults(
    [
      { id: 'limited', name: 'Аерогриль L', created_at: '2026-01-01T00:00:00Z', availability_status: 'limited' },
      { id: 'oos', name: 'Аерогриль O', created_at: '2026-01-02T00:00:00Z', availability_status: 'out_of_stock' },
    ],
    'аерогриль'
  ).map((r) => r.id);
  assert.deepEqual(ranked, ['limited', 'oos']);
});

// ---- RUNTIME: ranking through fetchCatalogProducts --------------------------

test('RANK: «блендер» orders by relevance, not by recency', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'блендер' });
  assert.equal(countCalls(before).length, 1); // fallback NOT triggered
  assert.equal(page.appliedSearch ?? null, null);
  assert.equal(page.total, 8);
  assert.deepEqual(page.products.map((p) => p.id), BLENDER_RANKED);
});

test('RANK: pagination slices the ranked order consistently', async () => {
  const before = reqLog.length;
  const page1 = await fetchCatalogProducts({ search: 'блендер', size: 2, page: 1 });
  const page2 = await fetchCatalogProducts({ search: 'блендер', size: 2, page: 2 });
  assert.equal(page1.total, page2.total);
  assert.deepEqual(
    page1.products.map((p) => p.id),
    BLENDER_RANKED.slice(0, 2)
  );
  assert.deepEqual(
    page2.products.map((p) => p.id),
    BLENDER_RANKED.slice(2, 4)
  );
  // ranked path requests the scan window (0..limit), not a 2-row page
  const scan = dataCalls(before)[0];
  assert.ok(scan !== undefined, 'scan request must be logged');
  assert.equal(scan.offset, 0);
  assert.equal(scan.limit, SEARCH_RANK_SCAN_LIMIT);
});

test('RANK: multi-word query ranks full-phrase matches first', async () => {
  const page = await fetchCatalogProducts({ search: 'tefal блендер' });
  assert.deepEqual(
    page.products.map((p) => p.id),
    ['m1', 'm2', 'm3']
  );
});

test('RANK: sku query keeps name matches above sku-only matches', async () => {
  const page = await fetchCatalogProducts({ search: '7061899' });
  assert.deepEqual(
    page.products.map((p) => p.id),
    ['s2', 's1']
  );
});

test('RANK: equal scores tiebreak by created_at desc then id desc', async () => {
  const page = await fetchCatalogProducts({ search: 'дублёр' });
  assert.deepEqual(
    page.products.map((p) => p.id),
    ['t2', 't1']
  );
});

test('RANK: equal scores also tier by availability (in stock first, runtime)', async () => {
  // a1 in-stock (older) must lead a2 out-of-stock (newer): the tier inverts
  // recency for equally-relevant rows (2026-09 audit, «Спочатку в наявності»).
  const page = await fetchCatalogProducts({ search: 'аерогриль' });
  assert.equal(page.total, 2);
  assert.deepEqual(
    page.products.map((p) => p.id),
    ['a1', 'a2']
  );
});

test('RANK: typo-fallback results are ranked by the APPLIED (relaxed) term', async () => {
  const page = await fetchCatalogProducts({ search: 'блендерр' });
  assert.equal(page.appliedSearch, 'блендер');
  assert.deepEqual(page.products.map((p) => p.id), BLENDER_RANKED);
});

test('RANK: explicit sort overrides relevance (price_asc stays price-ordered)', async () => {
  const page = await fetchCatalogProducts({
    search: 'блендер',
    sort: 'price_asc',
  });
  // price 100 {m1,r4,t1,t2} → 200 {m2} → 300 {m3} → 400 {r3} → 500 {r2},
  // id asc within the 100 tier — deliberately NOT the relevance order
  assert.deepEqual(
    page.products.map((p) => p.id),
    ['m1', 'r4', 't1', 't2', 'm2', 'm3', 'r3', 'r2']
  );
});

test('RANK: match set wider than the scan cap keeps plain recency order', async () => {
  // 1001 bulk rows that all match «item» → total > SEARCH_RANK_SCAN_LIMIT
  const bulk: Row[] = Array.from({ length: SEARCH_RANK_SCAN_LIMIT + 1 }, (_, i) =>
    cardRow(
      `bulk-${String(i).padStart(4, '0')}`,
      `Item ${String(i).padStart(4, '0')}`,
      new Date(Date.UTC(2025, 0, 1, 0, 0, 0, i)).toISOString()
    )
  );
  // one bulk row is an EXACT match — ranking would put it first, recency must not
  bulk[bulk.length - 1] = cardRow('bulk-exact', 'Item', '2025-01-01T00:00:00.000Z');
  ROWS.push(...bulk);

  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'item' });
  assert.equal(page.total, SEARCH_RANK_SCAN_LIMIT + 1);
  assert.equal(countCalls(before).length, 1);
  // legacy path: server-side pagination window, not a full scan
  const dataCall = dataCalls(before)[0];
  assert.ok(dataCall !== undefined, 'data request must be logged');
  assert.equal(dataCall.offset, 0);
  assert.equal(dataCall.limit, 12);
  // newest bulk row first — the exact-match row (oldest ts) must NOT lead
  // (index derived from the cap constant: the last generated row is
  // replaced by the exact-match row, so the newest survivor is cap-1)
  assert.equal(
    page.products[0]?.id,
    `bulk-${String(SEARCH_RANK_SCAN_LIMIT - 1).padStart(4, '0')}`
  );
  assert.notEqual(page.products[0]?.id, 'bulk-exact');
});

test('RANK: no search → non-search path untouched (recency order)', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({});
  const dataCall = dataCalls(before)[0];
  assert.ok(dataCall !== undefined, 'data request must be logged');
  assert.equal(dataCall.limit, 12); // page-sized window, not a scan
  assert.equal(page.products[0]?.id, 't2'); // newest first
});
