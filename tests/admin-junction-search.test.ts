/**
 * Admin junction-aware category filtering/search (2026-08-26).
 *
 * CONTRACT UNDER TEST:
 *  - an explicit categoryId filter matches a product when ANY of its
 *    product_categories direct assignments falls inside the category's
 *    subtree (builder-level filter, NOT inside or=);
 *  - duplicates are impossible (P3 holds TWO subtree links, appears once);
 *  - pagination/count run over the final unique set;
 *  - token-search keeps its exact or= union semantics with the legacy
 *    category branch expanded to whole subtrees.
 *
 * Same real-supabase-js-over-fake-PostgREST pattern as
 * admin-search-pagination.test.ts (RUNTIME F5 heritage).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';

const { createClient } = await import('@supabase/supabase-js');
const adminList = await import('../app/lib/admin-list.ts');

interface Row {
  [key: string]: unknown;
}

function uuid(prefix: string, n: number): string {
  // last segment must be EXACTLY 12 chars
  const tail = `${prefix}${String(n).padStart(12 - prefix.length, '0')}`;
  return `00000000-0000-4000-8000-${tail}`;
}

// Tree: rootB («Батьківська») → c1, c2 ; rootO («Інша») → oLeaf
const C_ROOT_B = uuid('ca', 1);
const C_B_1 = uuid('cb', 1);
const C_B_2 = uuid('cb', 2);
const C_ROOT_O = uuid('cc', 1);
const C_O_LEAF = uuid('cd', 1);

const categories: Row[] = [
  { id: C_ROOT_B, parent_id: null, name: 'Батьківська категорія', slug: 'batkivska', sort_order: 0, is_active: true },
  { id: C_B_1, parent_id: C_ROOT_B, name: 'Дитина 1', slug: 'dytyna-1', sort_order: 1, is_active: true },
  { id: C_B_2, parent_id: C_ROOT_B, name: 'Дитина 2', slug: 'dytyna-2', sort_order: 2, is_active: true },
  { id: C_ROOT_O, parent_id: null, name: 'Інша', slug: 'insha', sort_order: 3, is_active: true },
  { id: C_O_LEAF, parent_id: C_ROOT_O, name: 'Листок', slug: 'lystok', sort_order: 4, is_active: true },
];

function product(i: number, legacyCategoryId: string | null): Row {
  return {
    id: uuid('p', i),
    name: `Товар №${i}`,
    sku: `SKU-${i}`,
    slug: `tovar-${i}`,
    price: i,
    stock_quantity: i,
    created_at: new Date(Date.UTC(2026, 1, 3) - i * 1000).toISOString(),
    category_id: legacyCategoryId,
  };
}

// P4 belongs ONLY to the «Інша» branch (legacy + junction agree).
// P5's legacy column points OUTSIDE the «Батьківська» subtree; its ONLY
// junction assignment is inside it — token search must still find it.
const products: Row[] = [
  { ...product(1, C_B_1) }, // in subtree via c1
  { ...product(2, C_B_2) }, // in subtree via c2
  { ...product(3, C_B_1) }, // TWO direct subtree links -> must appear ONCE
  { ...product(4, C_O_LEAF) }, // outside «Батьківська» subtree
  { ...product(5, C_O_LEAF) }, // default outside; one NON-default junction link inside below
  { ...product(6, C_O_LEAF) }, // EXCLUSIVELY non-default assignment (only junction C_B_2)
];

// Direct assignments (P3 intentionally double-linked inside the subtree)
const productCategories: Row[] = [
  { product_id: uuid('p', 1), category_id: C_B_1 },
  { product_id: uuid('p', 2), category_id: C_B_2 },
  { product_id: uuid('p', 3), category_id: C_B_1 },
  { product_id: uuid('p', 3), category_id: C_B_2 },
  { product_id: uuid('p', 4), category_id: C_O_LEAF },
  { product_id: uuid('p', 5), category_id: C_B_1 }, // P5: NON-default only inside subtree
  { product_id: uuid('p', 6), category_id: C_B_2 }, // P6: its ONLY assignment is non-default
];

// --- minimal or= evaluator (same semantics as admin-search-pagination) ---
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
function stripOuterParens(expr: string): string {
  const e = String(expr).trim();
  if (!e.startsWith('(')) return e;
  let depth = 0;
  for (let i = 0; i < e.length; i += 1) {
    if (e[i] === '(') depth += 1;
    else if (e[i] === ')') {
      depth -= 1;
      if (depth === 0 && i !== e.length - 1) return e;
    }
  }
  return depth === 0 ? e.slice(1, -1) : e;
}
function evalPredicate(row: Row, pred: string): boolean {
  const m = pred.match(/^([A-Za-z_][\w.]*)\.(ilike|in|eq)\.([\s\S]+)$/);
  if (!m) throw new Error(`fake: unparsable predicate ${pred}`);
  const [, field, op, rawValue] = m;
  const value = row[field];
  if (op === 'ilike') {
    const inner = rawValue.replace(/^\%/, '').replace(/\%$/, '');
    return String(value ?? '').toLowerCase().includes(inner.toLowerCase());
  }
  if (op === 'in') {
    const list = rawValue.replace(/^\(/, '').replace(/\)$/, '').split(',');
    return value != null && list.includes(String(value));
  }
  return String(value) === rawValue;
}

async function startFake(): Promise<{ client: import('@supabase/supabase-js').SupabaseClient; close: () => Promise<void>; urls: string[] }> {
  const tables: Record<string, Row[]> = {
    products,
    brands: [],
    categories,
    product_categories: productCategories as unknown as Row[],
  };
  const urls: string[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = url.pathname.match(/\/rest\/v1\/(\w+)$/);
    const table = m?.[1] ?? '';
    const rows = tables[table];
    urls.push(`${table}?${url.searchParams.toString()}`);
    if (!rows) {
      res.writeHead(404);
      res.end();
      return;
    }

    let filtered = [...rows];
    const orParams = url.searchParams.getAll('or');
    if (orParams.length > 0) {
      filtered = filtered.filter((row) =>
        orParams.every((expr) =>
          splitTopLevel(stripOuterParens(expr)).some(
            (p) => p.trim() !== '' && evalPredicate(row, p.trim())
          )
        )
      );
    }
    for (const [key, value] of url.searchParams.entries()) {
      if (['select', 'or', 'order', 'offset', 'limit', 'apikey'].includes(key)) continue;

      // builder-level embedded filter: pc.<col>=in.(...)
      if (key === 'pc.category_id') {
        if (!value.startsWith('in.')) throw new Error(`fake: unexpected ${key}=${value}`);
        const list = value.slice(4).replace(/^\(/, '').replace(/\)$/, '').split(',');
        const allowed = new Set(list);
        const linked = new Set(productCategories.filter((pc) => allowed.has(String(pc.category_id))).map((pc) => String(pc.product_id)));
        filtered = filtered.filter((row) => linked.has(String(row.id)));
        continue;
      }
      if (key === 'category_id' || key === 'yugcontract_id') {
        if (value.startsWith('in.')) {
          const list = value.slice(4).replace(/^\(/, '').replace(/\)$/, '').split(',');
          filtered = filtered.filter((row) => list.includes(String(row[key])));
        } else if (value === 'is.null') {
          filtered = filtered.filter((row) => row[key] === null);
        }
        continue;
      }
      const fm = value.match(/^(ilike|eq)\.(.*)$/);
      if (!fm) continue;
      const [, op, v] = fm;
      filtered = filtered.filter((row) =>
        op === 'ilike'
          ? String(row[key] ?? '').toLowerCase().includes(v.replace(/^\%/, '').replace(/\%$/, '').toLowerCase())
          : String(row[key]) === v
      );
    }

    const wantsCount = (req.headers.prefer ?? '').includes('count=exact');
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Range': `*/${filtered.length}` });
      res.end();
      return;
    }

    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 1000);
    // order by created_at desc like PRODUCT_SORTS.default
    filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const window = filtered.slice(offset, offset + limit);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Range': `${offset}-${offset + window.length - 1}/${filtered.length}`,
    });
    res.end(JSON.stringify(window));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    client: createClient(`http://127.0.0.1:${address.port}`, 'test-anon-key', {
      auth: { persistSession: false },
    }),
    urls,
    close: async () => {
      server.close();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).closeAllConnections?.();
    },
  };
}

test('ADMIN-JUNCTION: explicit categoryId filter matches every subtree assignment without dupes', async () => {
  const fake = await startFake();
  try {
    const result = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 20,
      categoryId: C_ROOT_B,
    });
    // P1-P3 by their defaults; P5/P6 also match through their NON-default
    // links inside the subtree.
    assert.equal(result.total, 5, 'P1+P2+P3+P5+P6 по прямим зв’язкам піддерева');
    assert.equal(result.products.length, 5);
    const ids = new Set(result.products.map((p) => p.id));
    assert.equal(ids.size, 5, 'жодних дублів при множинних зв’язках');
    assert.ok(
      ids.has(String(products[0].id)) &&
        ids.has(String(products[1].id)) &&
        ids.has(String(products[2].id)),
      'повний набір товарів гілки'
    );
    assert.ok(
      ids.has(String(products[4].id)) && ids.has(String(products[5].id)),
      'не-default зв’язки теж потрапляють у фільтр піддерева'
    );
    assert.ok(!ids.has(String(products[3].id)), 'товар іншої гілки виключено');

    // Both count and data carry the same pc.* filter.
    const countUrl = fake.urls.find((u) => u.startsWith('products?'));
    const dataUrls = fake.urls.filter((u) => u.startsWith('products?'));
    assert.ok(dataUrls.some((u) => u.includes(encodeURIComponent(C_B_1))), 'піддерево у фільтрі запиту');
  } finally {
    await fake.close();
  }
});

test('ADMIN-JUNCTION: token-search expands matched categories to full subtrees', async () => {
  const fake = await startFake();
  try {
    const result = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 50,
      search: 'батьківська',
    });
    // Token matches rootB by NAME; subtree covers P1/P2/P3 via their defaults
    // AND P5/P6 via their NON-default junction links. P4 must stay out.
    assert.equal(result.total, 5);
    const ids = new Set(result.products.map((p) => p.id));
    assert.ok(ids.has(String(products[4].id)), 'P5 знайдений по НЕ-default категорії');
    assert.ok(ids.has(String(products[5].id)), 'P6 знайдений по НЕ-default категорії');
    assert.ok(!ids.has(String(products[3].id)));
  } finally {
    await fake.close();
  }
});

test('ADMIN-JUNCTION: token-search finds a product assigned EXCLUSIVELY via non-default category (no dupes)', async () => {
  const fake = await startFake();
  try {
    // «дитина» matches C_B_1 and C_B_2 by name; P6 has NO default in that
    // subtree — it is reachable ONLY through its single non-default link.
    const result = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 50,
      search: 'дитина',
    });
    assert.equal(result.total, 5, 'P1,P2,P3,P5,P6 — без дублів і без P4');
    const ids = result.products.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'жодного дубля');
    assert.ok(ids.includes(String(products[5].id)), 'P6 знайдений виключно за додатковою категорією');
    assert.ok(!ids.includes(String(products[3].id)), 'P4 не потрапляє у піддерево');
  } finally {
    await fake.close();
  }
});

test('ADMIN-JUNCTION: token-search scalar fields (name/sku/brand/slug) unaffected', async () => {
  const fake = await startFake();
  try {
    const bySku = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 50,
      search: 'sku-5',
    });
    assert.equal(bySku.total, 1);
    assert.equal(bySku.products[0].id, String(products[4].id));

    const byNameToken = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 50,
      search: 'товар',
    });
    assert.equal(byNameToken.total, 6);
    const nameIds = byNameToken.products.map((p) => p.id);
    assert.equal(new Set(nameIds).size, nameIds.length);

    const miss = await adminList.listAdminProducts(fake.client, {
      page: 1,
      size: 50,
      search: 'ззовні-немає-такого',
    });
    assert.equal(miss.total, 0);
  } finally {
    await fake.close();
  }
});

test('ADMIN-JUNCTION: products route exposes categoryId param (source)', () => {
  const s = readFileSync('app/api/admin/products/route.ts', 'utf8');
  assert.match(s, /categoryId/);
});

test('ADMIN-JUNCTION: admin-list drives the filter through the shared tree helpers (source)', () => {
  const s = readFileSync('app/lib/admin-list.ts', 'utf8');
  assert.match(s, /collectSubtreeIds/);
  assert.match(s, /pc\.category_id/);
});
