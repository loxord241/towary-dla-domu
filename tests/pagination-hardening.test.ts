/**
 * Silent-truncation hardening tests.
 *
 * The mock client simulates the REAL Supabase behaviour that caused the
 * production bug: a single response never returns more than `cap` rows,
 * even when .range() asks for a wider window (live-verified: PAGE=5000
 * returned exactly 1000 of 4323 products).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const { fetchAllRows } = await import('../app/lib/yugcontract/import-run.ts');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

interface MockState {
  requests: number;
  windows: [number, number][];
}

/** Chainable mock: server honours the window start but caps rows at `cap`. */
function makeMockClient(rows: unknown[], cap = 1000) {
  const state: MockState = { requests: 0, windows: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(_table: string) {
      return {
            select(_select: string) {
          const builder = {
                    order(_col: string, _opts?: unknown) {
              return builder;
            },
            range(from: number, to: number) {
              state.requests += 1;
              state.windows.push([from, to]);
              const windowSize = to - from + 1;
              const slice = rows.slice(from, from + Math.min(windowSize, cap));
              return {
                data: slice,
                error: null as { message: string } | null,
                returns<T>() {
                  return { data: slice as T[], error: null };
                },
              };
            },
          };
          return builder;
        },
      };
    },
  };
  return { client, state };
}

function makeRows(n: number): { id: number }[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
}

test('fetchAllRows: 2500 rows → 3 requests → all 2500 returned, no gaps/dups', async () => {
  const rows = makeRows(2500);
  const { client, state } = makeMockClient(rows);
  const out = await fetchAllRows<{ id: number }>(
    client,
    'products',
    'id'
  );
  assert.equal(state.requests, 3);
  assert.equal(out.length, 2500);
  assert.deepEqual(out.map((r) => r.id), rows.map((r) => r.id));
});

test('fetchAllRows: exactly 1000 rows → data complete after the boundary probe', async () => {
  // With cap-semantics a FULL page is indistinguishable from "more data
  // exists", so the loop MUST issue one extra probe returning 0 rows.
  // (A Content-Range header could avoid the probe; supabase-js .range()
  // pattern used project-wide cannot.) Data correctness is what matters.
  const rows = makeRows(1000);
  const { client, state } = makeMockClient(rows);
  const out = await fetchAllRows<{ id: number }>(client, 't', 'id');
  assert.equal(state.requests, 2);
  const boundaryWindow = state.windows[1];
  assert.ok(boundaryWindow !== undefined);
  assert.ok(boundaryWindow[0] !== undefined);
  assert.equal(boundaryWindow[0], 1000);
  assert.equal(out.length, 1000);
});

test('fetchAllRows: 1001 rows → 2 requests → 1001 returned', async () => {
  const rows = makeRows(1001);
  const { client, state } = makeMockClient(rows);
  const out = await fetchAllRows<{ id: number }>(client, 't', 'id');
  assert.equal(state.requests, 2);
  assert.equal(out.length, 1001);
  assert.deepEqual(out[out.length - 1], { id: 1001 });
});

test('fetchAllRows: windows are contiguous [0..999],[1000..1999],… (no off-by-one)', async () => {
  const rows = makeRows(2001);
  const { client, state } = makeMockClient(rows);
  await fetchAllRows(client, 't', 'id');
  assert.deepEqual(
    state.windows.map(([f, t]) => [f, t]),
    [
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]
  );
});

test('fetchAllRows: empty table → single request, empty result', async () => {
  const { client, state } = makeMockClient([]);
  const out = await fetchAllRows<unknown>(client, 't', 'id');
  assert.equal(state.requests, 1);
  assert.equal(out.length, 0);
});

// ---- project-wide static invariants -----------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

test('INVARIANT: no PAGE/PAGE_SIZE declaration > 1000 in app/ or scripts/', () => {
  for (const file of [
    ...walk(path.join(root, 'app')),
    ...readdirSync(path.join(root, 'scripts'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(root, 'scripts', f)),
  ]) {
    const src = readFileSync(file, 'utf8');
    // declarations only — comments may legitimately mention old values
    for (const m of src.matchAll(
      /(?:const|let)\s+(PAGE(?:_SIZE)?|PAGE_WINDOW)\s*=\s*(\d+)/g
    )) {
      const v = Number(m[2]);
      assert.ok(
        v <= 1000,
        `${path.relative(root, file)}: ${m[1]}=${v} — PostgREST отдаёт максимум 1000 строк за ответ`
      );
    }
  }
});

test('INVARIANT: preview route pages with PAGE_SIZE=1000 and terminates on it', () => {
  const src = readFileSync(
    path.join(root, 'app/api/admin/yugcontract/preview/route.ts'),
    'utf8'
  );
  assert.match(src, /const PAGE_SIZE = 1000;/);
  assert.match(src, /range\(from, from \+ PAGE_SIZE - 1\)/);
  assert.match(src, /batch\.length < PAGE_SIZE/);
});

test('INVARIANT: admin list queries have an id tiebreaker after created_at', () => {
  for (const rel of [
    'app/api/admin/products/route.ts',
    'app/api/admin/orders/route.ts',
  ]) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    if (!src.includes(".order('created_at'")) continue;
    assert.ok(
      src.includes(".order('id'"),
      `${rel}: offset-paginated created_at sort требует .order('id') tiebreaker`
    );
  }
});

test('INVARIANT: admin products UI no longer masks truncation via rows-length total', () => {
  const ui = readFileSync(
    path.join(root, 'app/admin/(dashboard)/products/page.tsx'),
    'utf8'
  );
  assert.ok(!ui.includes('?? rows.length'));
  // always sends explicit paging (server-side search+sort+pagination)
  assert.match(ui, /page=\$\{params\.page\}&size=\$\{params\.size\}/);
});

// ---- F11: verify.ts categories loop must use the canonical ≤1000 shape ----

test('INVARIANT F11: verify.ts has no pagination window >1000 and categories-loop is canonical', () => {
  const src = readFileSync(path.join(root, 'scripts/yugcontract-verify.ts'), 'utf8');

  // No oversized inline windows may exist anywhere in the file (the old
  // bug: range(from, from + 4999) with termination < 5000 — PostgREST
  // caps every response at max_rows, so the loop always stopped after
  // page 1 and any table above 1000 rows was silently truncated).
  assert.ok(!/\+\s*4999/.test(src), 'F11: найдено окно from+4999');
  assert.ok(!/<\s*5000\b/.test(src), 'F11: найдена termination <5000');
  assert.ok(!/\+=\s*5000\b/.test(src), 'F11: найден шаг +=5000');
  assert.match(src, /const PAGE_WINDOW = 1000;/, 'pageAll должен остаться на PAGE_WINDOW=1000');

  // Categories loop uses the canonical paged shape.
  const start = src.indexOf('// categories hierarchy');
  const end = src.indexOf('const ycCats', start);
  const block = src.slice(start, end);
  assert.ok(block.length > 0, 'categories hierarchy block отсутствует');
  assert.match(block, /const PAGE = 1000;/, 'F11: categories-loop обязан использовать PAGE=1000');
  assert.match(block, /range\(from, from \+ PAGE - 1\)/, 'F11: окно должно быть range(from, from + PAGE - 1)');
  assert.match(block, /\.length < PAGE\) return/, 'F11: termination обязан быть length < PAGE (exact-1000 → probe следующей страницы)');
  assert.match(block, /from \+= PAGE;/, 'F11: шаг окна обязан быть from += PAGE');
  assert.match(block, /\.order\('id'\)/, 'F11: детерминированный ORDER BY по уникальному id обязателен');
});

test('INVARIANT F11: pageAll closures remain ordered and bounded (regression)', () => {
  const src = readFileSync(path.join(root, 'scripts/yugcontract-verify.ts'), 'utf8');
  const pageAllStart = src.indexOf('async function pageAll');
  const pageAllEnd = src.indexOf('// ---------- DB integrity ----------');
  const pageAllBody = src.slice(pageAllStart, pageAllEnd);
  assert.match(pageAllBody, /from \+= PAGE_WINDOW/);
  assert.match(pageAllBody, /\.range\(from, from \+ PAGE_WINDOW - 1\)/);
  assert.match(pageAllBody, /batch\.length < PAGE_WINDOW\) return all/);
  // every closure supplies .order('id') — no new unordered caller allowed
  const closures = src.split('pageAll<').length - 1;
  const orders = (src.match(/\.order\('id'\)/g) ?? []).length;
  assert.ok(
    orders >= closures,
    `F11 regression: ${orders} .order('id') < ${closures} pageAll-вызовов`
  );
});

//
// Live-verified failure mode (2026-08): OFFSET paging WITHOUT ORDER BY
// returns overlapping/gapped windows across requests — three identical
// reads of 23848 product_images rows yielded (72 dups + 73 missed +
// 17 phantom multi-main), then clean results twice. Any diff-aware
// planner fed such a view produces phantom INSERTs / false anomalies.

/**
 * Query chains where .order() is not lexically adjacent to .range():
 *  - app/lib/catalog.ts fetchCatalogProducts applies one of four
 *    order(+id tiebreaker) chains in the sort switch immediately before
 *    `query.range(...)` on the same builder object;
 *  - scripts/yugcontract-verify.ts pageAll() is a generic pager whose
 *    ORDER BY is supplied by every caller's make() closure (verified).
 */
const ORDER_EXEMPT: { file: string; anchor: string }[] = [
  { file: 'app/lib/catalog.ts', anchor: 'query.range((page - 1)' },
  { file: 'scripts/yugcontract-verify.ts', anchor: 'make().range(from' },
];

function collectRangeCallSites(src: string): { index: number; line: number; firstArg: string }[] {
  const out: { index: number; line: number; firstArg: string }[] = [];
  for (const m of src.matchAll(/\.range\(\s*([^\s,)]+)/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    const firstArg = m[1];
    assert.ok(firstArg !== undefined);
    out.push({ index: m.index, line, firstArg });
  }
  return out;
}

test('INVARIANT: every multi-page .range() reader has a stable .order() on its chain', () => {
  const files = [
    ...walk(path.join(root, 'app')),
    ...readdirSync(path.join(root, 'scripts'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(root, 'scripts', f)),
  ];
  const offenders: string[] = [];

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const src = readFileSync(file, 'utf8');
    for (const site of collectRangeCallSites(src)) {
      // Literal-bound windows (.range(0, 999)) are single requests —
      // completeness is bounded by construction, ordering irrelevant.
      if (/^\d|^['"`]/.test(site.firstArg)) continue;

      // Enclosing statement: text between the surrounding semicolons.
      const start = src.lastIndexOf(';', site.index) + 1;
      const end = src.indexOf(';', site.index);
      const segment = src.slice(
        start,
        end === -1 ? Math.min(src.length, site.index + 400) : end
      );

      if (/\.order\s*\(/.test(segment)) continue;

      const exempt = ORDER_EXEMPT.some((a) => a.file === rel);
      if (!exempt) {
        offenders.push(`${rel}:${site.line}`);
        continue;
      }
      const anchor = ORDER_EXEMPT.find((a) => a.file === rel)!.anchor;
      assert.ok(
        src.includes(anchor),
        `${rel}: exemption stale — anchor "${anchor}" отсутствует, уберите из ORDER_EXEMPT или добавьте .order()`
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `multi-page .range() без .order() на цепочке (нестабильные окна OFFSET-пагинации):\n${offenders.join('\n')}`
  );
});

test('INVARIANT: allowlisted pagers keep their .order() contracts', () => {
  // catalog.ts: each sort branch must chain .order('id') tiebreaker.
  const catalog = readFileSync(path.join(root, 'app/lib/catalog.ts'), 'utf8');
  const tiebreakers = catalog.match(/\.order\('id'/g) ?? [];
  assert.ok(
    tiebreakers.length >= 4,
    `catalog.ts: ожидалось ≥4 .order('id') веток сортировки, найдено ${tiebreakers.length}`
  );

  // verify.ts pageAll: every make() closure must supply .order(...) —
  // count closures vs ordered queries so a new unordered caller fails.
  const verify = readFileSync(path.join(root, 'scripts/yugcontract-verify.ts'), 'utf8');
  const pageAllCalls = (verify.match(/pageAll</g) ?? []).length + (verify.match(/await pageAll\(/g) ?? []).length;
  const orderedClosures = (verify.match(/\.order\('id'\)/g) ?? []).length;
  assert.ok(
    orderedClosures >= pageAllCalls,
    `verify.ts: ${orderedClosures} .order('id') замыканий < ${pageAllCalls} вызовов pageAll — новый paged reader без ORDER BY?`
  );
});

// ---- F4/F5: no unbounded SELECT on full-set readers -------------------------

test('INVARIANT F4: admin products featured/active branches are paged with deterministic order', () => {
  const src = readFileSync(path.join(root, 'app/api/admin/products/route.ts'), 'utf8');
  // Branches must delegate to the paged full-set reader (never an inline
  // unbounded select, never a .limit() masquerade).
  for (const action of ['featured', 'active']) {
    const start = src.indexOf(`case '${action}'`);
    assert.ok(start !== -1, `case '${action}' отсутствует`);
    const nextCase = src.indexOf("case '", start + 10);
    const block = src.slice(start, nextCase === -1 ? src.length : nextCase);
    assert.ok(
      block.includes('fetchAllJoined(ctx.serviceClient'),
      `F4 action=${action}: ветка должна использовать пагинированный fetchAllJoined`
    );
    assert.ok(!block.includes('.limit('), `F4 action=${action}: .limit() маскировка запрещена`);
    if (action === 'featured') {
      assert.ok(block.includes('featuredOnly: true'), 'F4 featured: потерян featured-фильтр');
    }
  }
  // The paged reader itself: windows + deterministic tiebreaker + filters.
  const helperStart = src.indexOf('async function fetchAllJoined');
  const helperEnd = src.indexOf('export async function GET', helperStart);
  const helper = src.slice(helperStart, helperEnd);
  assert.ok(helper.includes('.range(from'), 'F4: helper без пагинации');
  assert.ok(/PAGE\s*=\s*1000/.test(helper), 'F4: PAGE должен быть ≤1000 (константа 1000)');
  assert.ok(helper.includes(".order('created_at', { ascending: false })"), 'F4: сортировка created_at desc изменена');
  assert.ok(/\.order\('id', \{ ascending: false \}\)/.test(helper), "F4: нет .order('id') tiebreaker");
  assert.ok(helper.includes(".eq('is_active', true)"), 'F4: потерян фильтр is_active');
});

test('INVARIANT F5: catalog fetchProducts is paged with deterministic order and kept filters', () => {
  const src = readFileSync(path.join(root, 'app/lib/catalog.ts'), 'utf8');
  const start = src.indexOf('async function fetchProducts');
  assert.ok(start !== -1, 'fetchProducts отсутствует');
  const end = src.indexOf('/** Sanitize a user-supplied search term', start);
  const body = src.slice(start, end === -1 ? src.length : end);
  assert.ok(body.includes('.range(from'), 'F5: fetchProducts без пагинации');
  assert.ok(body.includes(".order('created_at', { ascending: false })"), 'F5: изменена сортировка created_at desc');
  assert.ok(/\.order\('id', \{ ascending: false \}\)/.test(body), "F5: нет .order('id') tiebreaker");
  assert.ok(body.includes(".eq('is_active', true)"), 'F5: потерян фильтр is_active');
  assert.ok(
    body.includes('options.featuredOnly') && body.includes(".eq('is_featured', true)"),
    'F5: потерян featuredOnly-фильтр'
  );
});

test('RUNTIME F5: fetchFeaturedProducts reads ALL featured rows across capped windows', async () => {
  // Real HTTP: catalog.ts talks to a local fake-PostgREST that honours
  // the requested window start but silently caps every response at 1000
  // rows — exactly how Supabase behaved in production. supabase-js sends
  // windows as ?offset=&limit= query params (verified live), NOT a Range
  // header.
  const TOTAL = 2500;
  const rows = Array.from({ length: TOTAL }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    name: `n${i + 1}`,
    slug: `s${i + 1}`,
  }));
  const http = await import('node:http');
  const state = { requests: 0, offsets: [] as number[], limits: [] as number[], orders: [] as string[] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    state.requests += 1;
    state.orders.push(String(url.searchParams.get('order') ?? ''));
    const from = Number(url.searchParams.get('offset') ?? 0);
    const lim = Number(url.searchParams.get('limit') ?? 1000);
    state.offsets.push(from);
    state.limits.push(lim);
    const slice = rows.slice(from, Math.min(from + 1000, from + lim, rows.length));
    const last = from + slice.length - 1;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Range': `${slice.length > 0 ? `${from}-${last}` : '*/0'}/${rows.length}`,
    });
    res.end(JSON.stringify(slice));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';
    const { fetchFeaturedProducts } = await import('../app/lib/catalog.ts');
    const products = await fetchFeaturedProducts();
    assert.equal(products.length, TOTAL, 'featured-набор обрезан капом ответа');
    assert.deepEqual(state.offsets, [0, 1000, 2000], 'окна должны идти 0/1000/2000 без перекрытий и дыр');
    assert.ok(state.limits.every((l) => l === 1000), 'limit каждого запроса должен быть 1000');
    assert.ok(
      state.orders.every((o) => o.includes('created_at.desc') && o.includes('id.desc')),
      `каждый запрос обязан нести детерминированный порядок, получено: ${JSON.stringify(state.orders)}`
    );
  } finally {
    server.close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).closeAllConnections?.();
  }
});

test('INVARIANT: F1 readers (content/images pipeline) are explicitly ordered', () => {
  const expectations: { file: string; pattern: RegExp; why: string }[] = [
    {
      file: 'app/lib/yugcontract/content-import.ts',
      pattern: /\.in\('product_id', part\)\s*\n[\s\S]*?\.order\('id'\)\s*\n[\s\S]*?\.range\(from, from \+ PAGE - 1\)/,
      why: 'loadProductImagesFor: .order("id") между .in() и .range()',
    },
    {
      file: 'scripts/yugcontract-content-images.ts',
      pattern: /\.order\('yugcontract_id'\)\s*\n\s*\.range\(from, from \+ PAGE - 1\)/,
      why: 'staging full-read: .order("yugcontract_id") перед .range()',
    },
    {
      file: 'scripts/yugcontract-content-images.ts',
      pattern: /\.in\('product_id', part\)\s*\n[\s\S]*?\.order\('id'\)\s*\n[\s\S]*?\.range\(from, from \+ PAGE - 1\)/,
      why: 'existing-images reader: .order("id") между .in() и .range()',
    },
    {
      file: 'scripts/yugcontract-content-apply.ts',
      pattern: /\.order\('yugcontract_id'\)\s*\n\s*\.range\(from, from \+ PAGE - 1\)/,
      why: 'staging ids reader: .order("yugcontract_id") перед .range()',
    },
    {
      file: 'scripts/yugcontract-content-fetch.ts',
      pattern: /\.order\('id'\)\s*\n\s*\.range\(from, from \+ PAGE - 1\)/,
      why: 'products reader: .order("id") перед .range()',
    },
  ];
  for (const e of expectations) {
    const src = readFileSync(path.join(root, e.file), 'utf8');
    assert.match(src, e.pattern, `${e.file}: ${e.why}`);
  }
});
