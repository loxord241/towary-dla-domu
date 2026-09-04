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
  extras: { short_description?: string | null; brand?: { name: string } | null }
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
    images: [{ id: `img-${id}`, product_id: id, image_url: 'img', is_main: true, sort_order: 0 }],
  };
}

const ROWS: Row[] = [
  cardRow('100', 'Блендер Bosch SilentMix', { brand: { name: 'Bosch' }, short_description: 'плавний пуск' }),
  cardRow('101', 'Блендер Philips Pro', { brand: { name: 'Philips' } }),
  cardRow('102', 'Чашка керамічна', {}),
  cardRow('103', 'Мультипіч TEFAL 300', { brand: { name: 'TEFAL' } }),
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

const { fetchCatalogProducts, FALLBACK_MAX_RETRIES } = await import(
  '../app/lib/catalog.ts'
);

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

test('FALLBACK: floor of 4 chars — a 5-char token trims exactly once', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({ search: 'щітка' });
  // 'щітка'(5) → one variant 'щітк'(4) → no deeper trimming to 3/2/1 chars
  assert.equal(countCalls(before).length, 2);
  assert.equal(page.total, 0);
  assert.equal(page.appliedSearch ?? null, null);
});

test('FALLBACK: retry budget is capped at FALLBACK_MAX_RETRIES', async () => {
  const before = reqLog.length;
  const page = await fetchCatalogProducts({
    search: 'abcdefgh ijklmnop qrstuvwx yzabcdef', // 4 trimmable junk tokens
  });
  assert.equal(countCalls(before).length, 1 + FALLBACK_MAX_RETRIES);
  assert.equal(page.total, 0);
  assert.equal(page.appliedSearch ?? null, null);
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
  assert.equal(page.appliedSearch, 'мультипіч TEFAL');
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
