/**
 * Header search autocomplete (owner task 2026-09-11): GET
 * /api/search/suggest + SearchSuggest client island.
 *
 * Layers:
 *  - UNIT (pure helpers, app/lib/search-suggest.ts): term validation,
 *    or= condition shape, main-photo picking, response mapping (cap 8,
 *    malformed rows skipped), client fetcher contract.
 *  - RUNTIME fake-PostgREST (real supabase-js, same pattern as
 *    tests/admin-search-pagination.test.ts): the outgoing query carries
 *    the eligibility join (images!inner), is_active, the wallpaper
 *    exclusion (sku not like wc-%), the name/sku or= and the
 *    in-stock-first + name ordering with limit 8 — and the fake honours
 *    those semantics so exclusion/ordering are proven, not assumed.
 *  - STATIC invariants: route wiring (rate-limit rule, sanitize reuse,
 *    degrade-to-empty-items error contract, GET-only, no maxDuration),
 *    the no-JS GET form contract in SiteHeader, the a11y/motion
 *    contract of the client component.
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

const suggest = await import('../app/lib/search-suggest.ts');
const { sanitizeSearchTerm, WALLPAPER_SKU_PREFIX } = await import(
  '../app/lib/catalog.ts'
);

const readApp = (rel: string): string =>
  readFileSync(path.join(root, rel), 'utf8');

// ------------------------------------------------------------------ unit

test('isValidSuggestTerm: below 2 sanitized chars is rejected', () => {
  assert.equal(suggest.isValidSuggestTerm(''), false);
  assert.equal(suggest.isValidSuggestTerm('a'), false);
  assert.equal(suggest.isValidSuggestTerm('  '), false);
  assert.equal(suggest.isValidSuggestTerm('ab'), true);
  assert.equal(suggest.isValidSuggestTerm('щітка tefal'), true);
});

test('suggestOrCondition: name OR sku ilike with the sanitized term', () => {
  const condition = suggest.suggestOrCondition('tefal');
  assert.equal(condition, 'name.ilike.%tefal%,sku.ilike.%tefal%');
  // a sanitized multi-token term stays one literal pattern
  assert.equal(
    suggest.suggestOrCondition('щітка tefal'),
    'name.ilike.%щітка tefal%,sku.ilike.%щітка tefal%'
  );
});

test('pickSuggestImageUrl: main first, external hotlink passes through', () => {
  assert.equal(
    suggest.pickSuggestImageUrl([
      { image_url: 'products/b.jpg', is_main: false, sort_order: 0 },
      { image_url: 'https://b2b.yugcontract.ua/a.jpg', is_main: true, sort_order: 5 },
    ]),
    'https://b2b.yugcontract.ua/a.jpg'
  );
  assert.equal(
    suggest.pickSuggestImageUrl([
      { image_url: 'products/second.jpg', is_main: false, sort_order: 2 },
      { image_url: 'products/first.jpg', is_main: false, sort_order: 1 },
    ]),
    'http://localhost:54321/storage/v1/object/public/product_images/products/first.jpg'
  );
  assert.equal(suggest.pickSuggestImageUrl(null), null);
  assert.equal(suggest.pickSuggestImageUrl([]), null);
});

test('buildSuggestResponse: maps rows, skips malformed, caps at SUGGEST_LIMIT', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    slug: `p-${i}`,
    name: `Товар ${i}`,
    price: 100 + i,
    currency: 'UAH',
    availability_status: 'in_stock',
    images: [{ image_url: `products/${i}.jpg`, is_main: i === 0, sort_order: 0 }],
  }));
  const items = suggest.buildSuggestResponse(rows);
  assert.equal(items.length, suggest.SUGGEST_LIMIT);
  assert.equal(suggest.SUGGEST_LIMIT, 8);
  assert.deepEqual(items[0], {
    slug: 'p-0',
    name: 'Товар 0',
    price: 100,
    currency: 'UAH',
    availability_status: 'in_stock',
    imageUrl:
      'http://localhost:54321/storage/v1/object/public/product_images/products/0.jpg',
  });

  const malformed = suggest.buildSuggestResponse([
    { slug: '', name: 'x', price: 1, currency: 'UAH', availability_status: 'in_stock', images: null },
    { slug: 'ok', name: '', price: 1, currency: 'UAH', availability_status: 'in_stock', images: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { slug: 'ok2', name: 'ok2', currency: 'UAH', availability_status: 'in_stock', images: null } as any,
    { slug: 'ok3', name: 'ok3', price: 5, currency: 'UAH', availability_status: 'out_of_stock', images: null },
  ]);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0]?.slug, 'ok3');
  assert.equal(malformed[0]?.imageUrl, null);
});

// ------------------------------------------------- client fetch contract

/** Starts an HTTP server; returns { url, stop, requests, responder }. */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        stop: () =>
          new Promise((resolveStop, rejectStop) =>
            server.close(() => resolveStop()).on('error', rejectStop)
          ),
      });
    });
  });
}

test('fetchSearchSuggest: maps ok responses, degrades errors to []', async () => {
  const payload = JSON.stringify({
    items: [
      { slug: 'p1', name: 'Товар', price: 10, currency: 'UAH', availability_status: 'in_stock', imageUrl: null },
    ],
  });
  const server = await startServer((req, res) => {
    if (req.url?.includes('good')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    } else {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    }
  });
  try {
    const good = await suggest.fetchSearchSuggest('tefal', {
      url: `${server.url}/good`,
    });
    assert.equal(good.length, 1);
    assert.equal(good[0]?.slug, 'p1');

    const bad = await suggest.fetchSearchSuggest('tefal', {
      url: `${server.url}/bad`,
    });
    assert.deepEqual(bad, []);
  } finally {
    await server.stop();
  }
});

test('fetchSearchSuggest: never-stuck — stalled server resolves [] by timeout', async () => {
  const server = await startServer(() => {
    /* never respond */
  });
  try {
    const started = Date.now();
    const items = await suggest.fetchSearchSuggest('tefal', {
      url: `${server.url}/hang`,
      timeoutMs: 80,
    });
    assert.deepEqual(items, []);
    assert.ok(Date.now() - started < 2000, 'timeout must bound the request');
  } finally {
    await server.stop();
  }
});

// --------------------------------------------------- fake PostgREST (DB)

interface Row {
  [key: string]: unknown;
}

function evalOr(row: Row, expr: string): boolean {
  // shape produced by suggestOrCondition via supabase-js: or=(a.ilike.%v%,b.ilike.%v%)
  const inner = expr.startsWith('(') ? expr.slice(1, -1) : expr;
  return inner.split(',').some((pred) => {
    const m = pred.match(/^(\w+)\.ilike\.(%+)(.+)\2$/);
    if (!m?.[1] || !m[3]) return false;
    const value = row[m[1]];
    return String(value ?? '')
      .toLowerCase()
      .includes(m[3].toLowerCase());
  });
}

function orderRows(rows: Row[], orderSpec: string): Row[] {
  const keys = orderSpec.split(',').map((part) => {
    const [column, dir] = part.split('.');
    return { column: column as string, asc: dir !== 'desc' };
  });
  return [...rows].sort((a, b) => {
    for (const { column, asc } of keys) {
      const av = String(a[column] ?? '');
      const bv = String(b[column] ?? '');
      if (av === bv) continue;
      const cmp = av < bv ? -1 : 1;
      return asc ? cmp : -cmp;
    }
    return 0;
  });
}

function makeDataset(): Row[] {
  return [
    {
      slug: 'multivarka-tefal',
      name: 'Мультиварка TEFAL RK812',
      price: 3200,
      currency: 'UAH',
      availability_status: 'in_stock',
      is_active: true,
      sku: 'YC-111',
      images: [
        { image_url: 'products/tefal-2.jpg', is_main: false, sort_order: 0 },
        { image_url: 'products/tefal-main.jpg', is_main: true, sort_order: 1 },
      ],
    },
    {
      // matches the term but is OOS — must sort after the in-stock hit
      slug: 'tefal-pantry-oos',
      name: 'Tefal набор ножей',
      price: 999,
      currency: 'UAH',
      availability_status: 'out_of_stock',
      is_active: true,
      sku: 'YC-222',
      images: [{ image_url: 'products/knives.jpg', is_main: true, sort_order: 0 }],
    },
    {
      // name matches but INACTIVE — RLS/eligibility must exclude it
      slug: 'tefal-inactive',
      name: 'Tefal скрытый товар',
      price: 1,
      currency: 'UAH',
      availability_status: 'in_stock',
      is_active: false,
      sku: 'YC-333',
      images: [{ image_url: 'products/x.jpg', is_main: true, sort_order: 0 }],
    },
    {
      // wallpaper domain — excluded by the sku not-like filter
      slug: 'oboi-wc',
      name: 'Обои TEFAL collection',
      price: 500,
      currency: 'UAH',
      availability_status: 'in_stock',
      is_active: true,
      sku: 'wc-00042',
      images: [{ image_url: 'https://b2b.yugcontract.ua/wc.jpg', is_main: true, sort_order: 0 }],
    },
  ];
}

test('fetchSuggestItems: eligibility + wc- exclusion + or= + in-stock-first + limit', async () => {
  const requests: URL[] = [];
  const server = await startServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url);
    assert.equal(url.pathname, '/rest/v1/products');

    const rows = makeDataset().filter((row) => {
      const isActive = url.searchParams.get('is_active');
      if (isActive === 'eq.true' && row.is_active !== true) return false;
      const skuNot = url.searchParams.get('sku');
      if (skuNot === 'not.like.wc-%' && String(row.sku ?? '').startsWith('wc-')) {
        return false;
      }
      const orExpr = url.searchParams.get('or');
      if (orExpr && !evalOr(row, orExpr)) return false;
      return true;
    });

    const order = url.searchParams.get('order');
    const ordered = order ? orderRows(rows, order) : rows;
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? ordered.length);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ordered.slice(offset, offset + limit)));
  });

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(server.url, 'test-anon-key', {
      auth: { persistSession: false },
    });

    const items = await suggest.fetchSuggestItems(
      client as unknown as Parameters<typeof suggest.fetchSuggestItems>[0],
      'tefal'
    );

    // ---- outgoing request carries the full contract ----
    assert.equal(requests.length, 1);
    const q = requests[0]!.searchParams;
    const select = q.get('select') ?? '';
    assert.ok(
      select.includes('product_images!inner'),
      `eligibility join missing in select: ${select}`
    );
    assert.ok(select.includes('slug'), select);
    assert.ok(select.includes('availability_status'), select);
    assert.equal(q.get('is_active'), 'eq.true');
    assert.equal(q.get('sku'), 'not.like.wc-%');
    // supabase-js wraps the expression: or=(name.ilike.%v%,sku.ilike.%v%)
    assert.equal(
      q.get('or'),
      '(name.ilike.%tefal%,sku.ilike.%tefal%)'
    );
    assert.equal(
      q.get('order'),
      'availability_status.asc,name.asc,id.asc'
    );
    assert.equal(q.get('offset'), '0');
    assert.equal(q.get('limit'), String(suggest.SUGGEST_LIMIT));

    // ---- results: eligibility/wallpaper filtering + ordering + mapping ----
    assert.equal(items.length, 2);
    assert.equal(items[0]?.slug, 'multivarka-tefal'); // in_stock first
    assert.equal(items[0]?.imageUrl?.endsWith('tefal-main.jpg'), true);
    assert.equal(items[1]?.slug, 'tefal-pantry-oos'); // out_of_stock after
    assert.ok(!items.some((i) => i.slug === 'tefal-inactive'));
    assert.ok(!items.some((i) => i.slug === 'oboi-wc')); // wc- excluded
  } finally {
    await server.stop();
  }
});

test('fetchSuggestItems: DB error throws (route degrades to {items:[]})', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ code: 'PGRST100', message: 'failed to parse filter' })
    );
  });
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(server.url, 'test-anon-key', {
      auth: { persistSession: false },
    });
    await assert.rejects(
      suggest.fetchSuggestItems(
        client as unknown as Parameters<typeof suggest.fetchSuggestItems>[0],
        'tefal'
      ),
      /Failed to load search suggestions/
    );
  } finally {
    await server.stop();
  }
});

// -------------------------------------------------- static invariants

test('static: suggest route wiring (rate-limit, sanitize reuse, degrade contract)', () => {
  const route = readApp('app/api/search/suggest/route.ts');

  assert.match(route, /enforceRateLimit\(request, 'searchSuggest'\)/);
  assert.match(
    route,
    /import \{ sanitizeSearchTerm \} from '@\/app\/lib\/catalog';/
  );
  assert.match(route, /sanitizeSearchTerm\(rawQuery\)/);
  assert.match(route, /isValidSuggestTerm\(term\)/);
  // suggestions must never break typing: DB errors degrade to an empty list
  assert.match(route, /catch \(error\)/);
  assert.match(route, /console\.error\(/);
  assert.match(route, /\{ items: \[\] \}/);
  // GET-only autocomplete; the orchestrator owns serverless config
  assert.match(route, /export async function GET\(/);
  assert.doesNotMatch(route, /export async function POST\(/);
  assert.doesNotMatch(route, /maxDuration/);
});

test('static: rate-limit rule 60/min keyed IP+route', () => {
  // app/lib/rate-limit.ts is not importable under plain node (next/server),
  // so the rule is pinned on the source text; the route-side usage is
  // pinned by the enforceRateLimit assertion above.
  const rateLimit = readApp('app/lib/rate-limit.ts');
  assert.match(rateLimit, /searchSuggest: \[\{ max: 60, windowMs: 60_000 \}\]/);
});

test('static: wallpaper sync + eligibility join + limit constant', () => {
  assert.equal(suggest.WALLPAPER_SKU_LIKE, `${WALLPAPER_SKU_PREFIX}%`);
  // the route-side sanitize is the SAME function the catalog uses
  assert.equal(
    suggest.suggestOrCondition(sanitizeSearchTerm('a,b"c')),
    suggest.suggestOrCondition('a b c')
  );
  assert.match(suggest.SUGGEST_SELECT, /product_images!inner/);
  assert.doesNotMatch(suggest.SUGGEST_SELECT, /variants/);
  assert.equal(suggest.SUGGEST_LIMIT, 8);
  assert.equal(suggest.SUGGEST_DEBOUNCE_MS, 250);
});

test('static: SiteHeader keeps the no-JS GET form and wraps SearchSuggest', () => {
  const header = readApp('app/components/SiteHeader.tsx');
  assert.match(header, /<form action="\/catalog" method="get"/);
  assert.match(header, /<SearchSuggest defaultValue=\{searchQuery\} \/>/);
  assert.doesNotMatch(header, /SearchIcon/);
});

test('static: SearchSuggest island — a11y combobox, debounce, motion, /catalog nav', () => {
  const component = readApp('app/components/SearchSuggest.tsx');
  assert.match(component, /'use client'/);
  assert.match(component, /name="q"/); // form submission without JS keeps working
  assert.match(component, /role="combobox"/);
  assert.match(component, /aria-expanded=\{listOpen\}/);
  assert.match(component, /aria-activedescendant=/);
  assert.match(component, /role="listbox"/);
  assert.match(component, /SUGGEST_DEBOUNCE_MS/);
  assert.match(component, /fetchSearchSuggest/);
  assert.match(component, /dropdown-in motion-reduce:animate-none/);
  assert.match(component, /router\.push\(`\/catalog\?q=/);
  // progressive enhancement: Enter with no active row falls through to the form
  assert.match(component, /type="submit"/);
});
