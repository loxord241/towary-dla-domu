/**
 * Admin search + pagination regression tests.
 *
 * THE BUG (2026-08): admin products search filtered the 20 ALREADY-LOADED
 * rows client-side, so an item on page 1500 was unfindable. Brands and
 * categories loaded the whole table and filtered client-side (unbounded
 * SELECT — its own F-invariant violation).
 *
 * THE CONTRACT UNDER TEST: search must be applied at the DATABASE level
 * BEFORE pagination — DB WHERE/or-filter → COUNT(filtered) → range window
 * → ≤20 rows. These tests drive the REAL supabase-js query builder against
 * a local fake PostgREST that honours or=/order/offset/limit exactly like
 * the live service (same pattern as RUNTIME F5 in pagination-hardening),
 * and assert that the outgoing requests themselves carry the filter and
 * windows — i.e. filtering provably happens before pagination.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';

const { createClient } = await import('@supabase/supabase-js');
const adminList = await import('../app/lib/admin-list.ts');

// ---------------------------------------------------------------- fake DB

interface Row {
  [key: string]: unknown;
}

function pad(i: number): string {
  return String(i + 1).padStart(12, '0');
}
function uuidAt(prefix: string, i: number): string {
  return `00000000-0000-4000-8000-${prefix}${pad(i)}`;
}

interface FakeDataset {
  products: Row[];
  brands: Row[];
  categories: Row[];
}

/**
 * Builds a dataset where the DEFAULT listing order (created_at desc,
 * id desc) equals index order, so "index ≥ 20" == "beyond page 1".
 */
function makeDataset(nProducts: number, nBrands: number, nCategories: number): FakeDataset {
  const brands: Row[] = Array.from({ length: nBrands }, (_, i) => ({
    id: uuidAt('b', i),
    name: i === nBrands - 1 ? 'ZZZ Rare Brand' : `Brand ${i + 1}`,
    slug: i === nBrands - 1 ? 'zzz-rare-brand' : `brand-${i + 1}`,
    created_at: new Date(Date.UTC(2026, 1, 1) - i * 1000).toISOString(),
  }));
  const categories: Row[] = Array.from({ length: nCategories }, (_, i) => ({
    id: uuidAt('c', i),
    name: i === nCategories - 1 ? 'Рідкісна категорія' : `Категорія ${i + 1}`,
    slug: i === nCategories - 1 ? 'rare-slug-xyz' : `cat-${i + 1}`,
    sort_order: i,
    created_at: new Date(Date.UTC(2026, 1, 2) - i * 1000).toISOString(),
  }));
  const products: Row[] = Array.from({ length: nProducts }, (_, i) => ({
    id: uuidAt('p', i),
    name: i === 32 ? 'Мультипіч TEFAL Ultra 32' : `Товар звичайний №${i + 1}`,
    sku: `SKU-${i + 1}`,
    slug: `tovar-${i + 1}`,
    yugcontract_id: String(900000 + i),
    price: i,
    stock_quantity: i % 7,
    created_at: new Date(Date.UTC(2026, 1, 3) - i * 1000).toISOString(),
    brand_id: brands[i % nBrands].id as string,
    category_id: categories[i % nCategories].id as string,
  }));
  return { products, brands, categories };
}

// ------------------------------------------------------- fake PostgREST

interface LoggedRequest {
  method: string;
  table: string;
  params: URLSearchParams;
}

/** Paren-aware split of an or= expression on top-level commas. */
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expr) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

function evalPredicate(row: Row, pred: string): boolean {
  const m = pred.match(/^([A-Za-z_][\w.]*)\.(ilike|in|eq)\.([\s\S]+)$/);
  if (!m) throw new Error(`fake PostgREST: unparsable predicate ${JSON.stringify(pred)}`);
  const [, field, op, rawValue] = m;
  const value = row[field];
  if (op === 'ilike') {
    const inner = rawValue.replace(/^\%/, '').replace(/\%$/, '');
    return String(value ?? '')
      .toLowerCase()
      .includes(inner.toLowerCase());
  }
  if (op === 'in') {
    const list = rawValue.replace(/^\(/, '').replace(/\)$/, '').split(',');
    return value != null && list.includes(String(value));
  }
  return String(value) === rawValue;
}

/** supabase-js wraps the expression: or=(a.op.v,b.op.v) — unwrap once. */
function stripOuterParens(expr: string): string {
  const e = expr.trim();
  if (!e.startsWith('(')) return e;
  // only strip when the opening paren matches the FINAL character
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

function evalOr(row: Row, expr: string): boolean {
  return splitTopLevel(stripOuterParens(expr)).some(
    (p) => p.trim() !== '' && evalPredicate(row, p.trim())
  );
}

function compareRows(a: Row, b: Row, orderSpec: [string, boolean][]): number {
  for (const [col, asc] of orderSpec) {
    const av = a[col];
    const bv = b[col];
    if (av === bv) continue;
    const cmp = String(av) < String(bv) ? -1 : 1;
    return asc ? cmp : -cmp;
  }
  return 0;
}

function parseOrder(orderParam: string | null): [string, boolean][] {
  if (!orderParam) return [];
  return orderParam.split(',').map((token) => {
    const [col, dir] = token.split('.');
    return [col, dir !== 'desc'] as [string, boolean];
  });
}

/**
 * Local fake of the Supabase/PostgREST REST surface used by admin-list:
 * GET data windows (?offset&limit&or&order) and HEAD exact counts
 * (Prefer: count=exact → Content-Range slash-star total), filters applied
 * server-side BEFORE the window is cut — the exact semantics whose
 * absence caused the original bug.
 */
async function startFakePostgrest(dataset: FakeDataset) {
  const log: LoggedRequest[] = [];
  const tables: Record<string, Row[]> = {
    products: dataset.products,
    brands: dataset.brands,
    categories: dataset.categories,
  };
  // embeds are attached like PostgREST many-to-one embedding does
  const embeds: Record<string, { byId: Map<string, Row>; key: string; alias: string }[]> = {
    products: [
      { byId: new Map(dataset.brands.map((b) => [String(b.id), b])), key: 'brand_id', alias: 'brands' },
      { byId: new Map(dataset.categories.map((c) => [String(c.id), c])), key: 'category_id', alias: 'categories' },
    ],
    brands: [],
    categories: [],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = url.pathname.match(/\/rest\/v1\/(\w+)$/);
    const table = m?.[1] ?? '';
    const rows = tables[table];
    if (!rows) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `unknown table ${table}` }));
      return;
    }

    let filtered = rows;
    const orParams = url.searchParams.getAll('or');
    if (orParams.length > 0) {
      filtered = filtered.filter((row) => orParams.every((expr) => evalOr(row, expr)));
    }
    // generic scalar filters used by resolution queries (eq/is/ilike)
    for (const [key, value] of url.searchParams.entries()) {
      if (['select', 'or', 'order', 'offset', 'limit', 'apikey'].includes(key)) continue;
      const fm = value.match(/^(ilike|eq)\.(.*)$/);
      if (!fm) continue;
      const [, op, v] = fm;
      filtered = filtered.filter((row) =>
        op === 'ilike'
          ? String(row[key] ?? '')
              .toLowerCase()
              .includes(v.replace(/^\%/, '').replace(/\%$/, '').toLowerCase())
          : String(row[key]) === v
      );
    }

    log.push({ method: req.method ?? 'GET', table, params: new URLSearchParams(url.searchParams) });

    const wantsCount = (req.headers.prefer ?? '').includes('count=exact');
    if (req.method === 'HEAD' || wantsCount === true) {
      res.writeHead(200, { 'Content-Range': `*/${filtered.length}` });
      res.end();
      return;
    }

    const spec = parseOrder(url.searchParams.get('order'));
    const sorted = spec.length > 0 ? [...filtered].sort((a, b) => compareRows(a, b, spec)) : [...filtered];

    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 1000);
    const windowRows = sorted.slice(offset, Math.min(offset + limit, sorted.length));

    const enriched =
      table === 'products'
        ? windowRows.map((row) => {
            const out = { ...row };
            for (const e of embeds.products) {
              const target = e.byId.get(String(out[e.key]));
              (out as Record<string, unknown>)[e.alias] = target ?? null;
            }
            return out;
          })
        : windowRows;

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Range': `${offset}-${offset + windowRows.length - 1}/${filtered.length}`,
    });
    res.end(JSON.stringify(enriched));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const client = createClient(`http://127.0.0.1:${address.port}`, 'test-anon-key', {
    auth: { persistSession: false },
  });
  return {
    client,
    log,
    close: async () => {
      server.close();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).closeAllConnections?.();
    },
  };
}

// ------------------------------------------------------------- helpers

function lastRequest(log: LoggedRequest[], table: string, method = 'GET'): LoggedRequest | undefined {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i].table === table && log[i].method === method) return log[i];
  }
  return undefined;
}

function decodedOr(req: LoggedRequest | undefined): string[] {
  if (!req) return [];
  return req.params.getAll('or');
}

// ============================================================== PRODUCTS

test('PRODUCT: item beyond page 1 is found by server-side search (total=matches, page 1 holds it)', async () => {
  // 45 products; the TEFAL item sits at index 32 → position 33 in default
  // order → NOT in the first 20. The old UI could never show it without
  // manual paging; the fixed pipeline must find it on page 1 of the search.
  const dataset = makeDataset(45, 5, 5);
  const target = dataset.products[32];
  const fake = await startFakePostgrest(dataset);
  try {
    const result = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 20,
      search: 'tefal',
    });

    assert.equal(result.total, 1, 'total должен считаться ПО фильтру, а не по всей таблице');
    assert.equal(result.page, 1);
    assert.equal(result.size, 20);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].id, target.id);

    // The COUNT request itself must have carried the search filter.
    const countReq = lastRequest(fake.log, 'products', 'HEAD');
    const countOr = decodedOr(countReq);
    assert.ok(countOr.length >= 1, 'count-запрос обязан нести or= фильтр поиска');
    assert.ok(
      countOr.some((expr) => expr.includes('%tefal%')),
      `count or= должен содержать паттерн %tefal%, получено ${JSON.stringify(countOr)}`
    );

    // The DATA request must carry BOTH the same filter AND the page window.
    const dataReq = lastRequest(fake.log, 'products', 'GET');
    const dataOr = decodedOr(dataReq);
    assert.deepEqual(dataOr, countOr, 'data-запрос должен нести ровно тот же фильтр, что и count');
    assert.equal(dataReq?.params.get('offset'), '0');
    assert.equal(dataReq?.params.get('limit'), '20');
  } finally {
    await fake.close();
  }
});

test('PRODUCT: pagination continues INSIDE the filtered set (page 2 = offset 20 of matches)', async () => {
  const dataset = makeDataset(45, 3, 3);
  // 25 products named with «пошук» → total=25 → pages=2 (20+5)
  for (let i = 0; i < 25; i += 1) dataset.products[i].name = `Пошуковий товар №${i + 1}`;
  const fake = await startFakePostgrest(dataset);
  try {
    const page2 = await adminList.listAdminProducts(fake.client, {
      page: 2,
      size: 20,
      search: 'пошуковий',
    });
    assert.equal(page2.total, 25);
    assert.equal(page2.products.length, 5);
    const dataReq = lastRequest(fake.log, 'products', 'GET');
    assert.equal(dataReq?.params.get('offset'), '20', 'страница 2 должна вырезать окно ИЗ отфильтрованного набора');
    assert.equal(dataReq?.params.get('limit'), '20');
    assert.ok(decodedOr(dataReq)[0].includes('%пошуковий%'));
  } finally {
    await fake.close();
  }
});

test('PRODUCT: no search → no or= filter, total = full table, standard window', async () => {
  const dataset = makeDataset(45, 3, 3);
  const fake = await startFakePostgrest(dataset);
  try {
    const result = await adminList.listAdminProducts(fake.client, { page: 1, size: 20 });
    assert.equal(result.total, 45);
    assert.equal(result.products.length, 20);
    assert.deepEqual(decodedOr(lastRequest(fake.log, 'products', 'GET')), [], 'без поиска or= не отправляется');
  } finally {
    await fake.close();
  }
});

test('PRODUCT: multi-token search ANDs tokens (two chained or= expressions)', async () => {
  const dataset = makeDataset(45, 3, 3);
  const fake = await startFakePostgrest(dataset);
  try {
    const result = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 20,
      search: 'tefal ultra',
    });
    assert.equal(result.total, 1);
    assert.equal(result.products[0].name.includes('Ultra'), true);
    const dataReq = lastRequest(fake.log, 'products', 'GET');
    assert.equal(decodedOr(dataReq).length, 2, 'два токена → два AND-ированных or=');
  } finally {
    await fake.close();
  }
});

test('PRODUCT: search input is sanitized — reserved or= grammar can never reach the wire', async () => {
  const dataset = makeDataset(45, 3, 3);
  const fake = await startFakePostgrest(dataset);
  try {
    const adversarial = 'tefal",(ultra)%';
    // must not throw and must not corrupt the grammar
    const result = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 20,
      search: adversarial,
    });
    assert.equal(result.total, 1); // sanitized to «tefal ultra» → still finds it
    const exprs = decodedOr(lastRequest(fake.log, 'products', 'GET'));
    assert.equal(exprs.length, 2);
    for (const expr of exprs) {
      for (const pattern of expr.match(/ilike\.%([^%]*)%/g) ?? []) {
        const inner = pattern.slice('ilike.%'.length, -1);
        for (const ch of [',', '"', '(', ')', '%']) {
          assert.ok(!inner.includes(ch), `паттерн ${JSON.stringify(inner)} містить зарезервований ${JSON.stringify(ch)}`);
        }
      }
    }
  } finally {
    await fake.close();
  }
});

test('PRODUCT: specials-only search degrades to NO filter (full list)', async () => {
  const dataset = makeDataset(45, 3, 3);
  const fake = await startFakePostgrest(dataset);
  try {
    const result = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 20,
      search: '%","%(',
    });
    assert.equal(result.total, 45);
    assert.deepEqual(decodedOr(lastRequest(fake.log, 'products', 'GET')), []);
  } finally {
    await fake.close();
  }
});

test('PRODUCT: requested page beyond filtered result clamps to last valid page', async () => {
  const dataset = makeDataset(45, 3, 3);
  const fake = await startFakePostgrest(dataset);
  try {
    const result = await adminList.listAdminProducts(fake.client, {
      page: 99,
      size: 20,
      search: 'tefal', // 1 match → 1 page
    });
    assert.equal(result.total, 1);
    assert.equal(result.page, 1, 'страница 99 обязана зажаться до 1');
    assert.equal(result.products.length, 1);
  } finally {
    await fake.close();
  }
});

test('PRODUCT: zero matches → total=0, empty items, honest empty state input', async () => {
  const dataset = makeDataset(45, 3, 3);
  const fake = await startFakePostgrest(dataset);
  try {
    const result = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 20,
      search: 'несуществующий-токен-xyz',
    });
    assert.equal(result.total, 0);
    assert.deepEqual(result.products, []);
    assert.equal(result.page, 1);
  } finally {
    await fake.close();
  }
});

test('PRODUCT: deterministic order on every request (sort map + id tiebreaker)', async () => {
  const dataset = makeDataset(45, 3, 3);
  const fake = await startFakePostgrest(dataset);
  try {
    await adminList.listAdminProducts(fake.client, { page: 1, size: 20 });
    assert.match(
      lastRequest(fake.log, 'products', 'GET')?.params.get('order') ?? '',
      /created_at\.desc.*id\.desc/,
      'дефолт: created_at desc + id tiebreaker'
    );

    await adminList.listAdminProducts(fake.client, { page: 1, size: 20, sort: 'price_asc' });
    assert.match(
      lastRequest(fake.log, 'products', 'GET')?.params.get('order') ?? '',
      /^price\.asc,id\.asc$/,
      'price_asc обязан нести детерминированный tiebreaker'
    );
  } finally {
    await fake.close();
  }
});

// ================================================================ BRANDS

test('BRAND: brand beyond the first 20 is found by server-side search', async () => {
  // 30 brands; ZZZ Rare Brand is LAST (position 30 → page 2 unsearched).
  const dataset = makeDataset(10, 30, 5);
  const target = dataset.brands[29];
  const fake = await startFakePostgrest(dataset);
  try {
    const result = await adminList.listAdminBrands(fake.client, {
      page: 1,
      size: 20,
      search: 'zzz rare',
    });
    assert.equal(result.total, 1, 'total по брендам считается по фильтру');
    assert.equal(result.brands.length, 1);
    assert.equal(result.brands[0].id, target.id);
    const countOr = decodedOr(lastRequest(fake.log, 'brands', 'HEAD'));
    const dataOr = decodedOr(lastRequest(fake.log, 'brands', 'GET'));
    assert.deepEqual(dataOr, countOr);
    assert.equal(lastRequest(fake.log, 'brands', 'GET')?.params.get('limit'), '20');
  } finally {
    await fake.close();
  }
});

test('BRAND: clearing the search returns the full paginated list again', async () => {
  const dataset = makeDataset(10, 30, 5);
  const fake = await startFakePostgrest(dataset);
  try {
    const cleared = await adminList.listAdminBrands(fake.client, { page: 1, size: 20, search: '' });
    assert.equal(cleared.total, 30, 'очистка поиска → полный список');
    assert.equal(cleared.brands.length, 20);
  } finally {
    await fake.close();
  }
});

// ============================================================ CATEGORIES

test('CATEGORY: category beyond the first 20 is found by server-side search (incl. slug)', async () => {
  const dataset = makeDataset(5, 5, 48);
  const target = dataset.categories[47]; // slug rare-slug-xyz, позиция 48
  const fake = await startFakePostgrest(dataset);
  try {
    const bySlug = await adminList.listAdminCategories(fake.client, {
      page: 1,
      size: 20,
      search: 'rare-slug-xyz',
    });
    assert.equal(bySlug.total, 1);
    assert.equal(bySlug.categories[0].id, target.id);

    const byName = await adminList.listAdminCategories(fake.client, {
      page: 1,
      size: 20,
      search: 'рідкісна категорія',
    });
    assert.equal(byName.total, 1);
    assert.equal(byName.categories[0].id, target.id);
  } finally {
    await fake.close();
  }
});

test('CATEGORY: large-table pagination inside filtered set (48 cats, page 2)', async () => {
  // 60 категорий с общим токеном в имени → 60 совпадений → 3 страницы
  const dataset = makeDataset(5, 5, 60);
  for (const cat of dataset.categories) cat.name = `Спецкатегорія ${cat.slug}`;
  const fake = await startFakePostgrest(dataset);
  try {
    const page2 = await adminList.listAdminCategories(fake.client, {
      page: 2,
      size: 20,
      search: 'спецкатегорія',
    });
    assert.equal(page2.total, 60);
    assert.equal(page2.categories.length, 20);
    assert.equal(lastRequest(fake.log, 'categories', 'GET')?.params.get('offset'), '20');
  } finally {
    await fake.close();
  }
});

// ============================================== param parsing & clamping

test('parseAdminListParams: defaults, caps and whitelists', () => {
  const parsed = adminList.parseAdminListParams(new URLSearchParams(''), ['default', 'name_asc']);
  assert.deepEqual(parsed, { page: 1, size: 20, search: '', sort: 'default' });

  const full = adminList.parseAdminListParams(
    new URLSearchParams('page=3&size=50&search=%20tefal%20&sort=name_asc'),
    ['default', 'name_asc']
  );
  assert.deepEqual(full, { page: 3, size: 50, search: 'tefal', sort: 'name_asc' });

  const hostile = adminList.parseAdminListParams(
    new URLSearchParams('page=-4&size=5000&sort=DROP TABLE'),
    ['default']
  );
  assert.deepEqual(
    hostile,
    { page: 1, size: 100, search: '', sort: 'default' },
    'хостильные параметры → безопасные дефолты, size зажат капом 100'
  );

  const oversizedPage = adminList.parseAdminListParams(new URLSearchParams('page=999999'), ['default']);
  assert.equal(oversizedPage.page, 999999, 'завышенная page валидна — её зажмёт clamp по total на сервере');

  const fractional = adminList.parseAdminListParams(new URLSearchParams('size=0.5&page=1.5'), ['default']);
  assert.deepEqual(fractional, { page: 1, size: 20, search: '', sort: 'default' }, 'дробные page/size отклоняются');
});

// ==================================================== static invariants

test('INVARIANT: admin routes delegate listing to the shared lib (no inline client-side filtering)', () => {
  for (const [route, fn] of [
    ['app/api/admin/products/route.ts', 'listAdminProducts'],
    ['app/api/admin/brands/route.ts', 'listAdminBrands'],
    ['app/api/admin/categories/route.ts', 'listAdminCategories'],
  ] as const) {
    const src = readFileSync(path.join(root, route), 'utf8');
    assert.ok(src.includes(`${fn}(`), `${route} должен использовать ${fn} из app/lib/admin-list`);
  }
});

test('INVARIANT: admin UIs send server-side search/sort/page and keep PAGE_SIZE=20', () => {
  for (const rel of [
    'app/admin/(dashboard)/products/page.tsx',
    'app/admin/(dashboard)/brands/page.tsx',
    'app/admin/(dashboard)/categories/page.tsx',
  ]) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    assert.equal(src.includes('const PAGE_SIZE = 20;'), true, `${rel}: PAGE_SIZE=20 сохранён`);
    assert.match(src, /search=\$\{encodeURIComponent/, `${rel}: поиск уходит на сервер (search= параметр)`);
    assert.match(src, /&sort=/, `${rel}: сортировка уходит на сервер`);
  }
});

test('INVARIANT: admin UIs reset to page 1 when the debounced search changes', () => {
  for (const rel of [
    'app/admin/(dashboard)/products/page.tsx',
    'app/admin/(dashboard)/brands/page.tsx',
    'app/admin/(dashboard)/categories/page.tsx',
  ]) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    assert.match(
      src,
      /useAdminListUrlState\(/,
      `${rel}: состояние списка обязано жить в URL через useAdminListUrlState`
    );
  }
  // The reset itself lives in the shared hook: a committed new search
  // always patches { search: next, page: 1 }.
  const hook = readFileSync(
    path.join(root, 'app/lib/use-admin-list-state.ts'),
    'utf8'
  );
  assert.match(hook, /search:\s*next,\s*page:\s*1/);
});
