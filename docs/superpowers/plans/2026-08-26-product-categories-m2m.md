# Product Categories M2M + Category Tree UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (chosen: inline
> execution, user mandated uninterrupted run to completion). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Many-to-many product↔categories (junction `product_categories`), subtree-aware
storefront/admin filtering, importer recategorization, admin multiselect, admin category
ordering UI, collapsible CategorySelect tree — without breaking `category=slug` URL contract
or `products.category_id` (kept as legacy/default during transition).

**Architecture:** Junction table stores DIRECT assignments only (leaf YC category per product;
multi-assignable via admin). Parent/descendant inclusion is computed in JS from the existing
active-category list (`collectSubtreeIds`) and pushed into PostgREST as an `!inner` embed
filter on `product_categories` — same proven pattern as the existing `images!inner` join.
Every write path (admin POST/PUT, importer insert/recategorize, backfill) dual-writes
`products.category_id` (always = first/primary assignment, never NULL-ed silently) and the
junction until a future cleanup migration.

**Tech Stack:** Next 16 App Router (route handlers, server components), supabase-js v2,
Tailwind 4, React 19; tests = node:test (`npm test`), source-invariant style (readFileSync +
assert.match) plus pure-function unit tests.

**Spec:** approved decisions in chat 2026-08-26 (audit report +
user-approved resolutions: recategorization INCLUDED, backfill AFTER 016, JS-closure no RPC,
full admin multiselect, importer fix for unresolved category).

## Global Constraints

- Миграции применяются вручную через Supabase SQL Editor; файлы в `database/migrations/NNN_*.sql`,
  idempotent (`IF NOT EXISTS`), стиль заголовка как в 010/015.
- НИКАКИХ data writes внутри миграции 016 (backfill отдельным шагом ПОСЛЕ ручного применения).
- НИКАКИХ production DB writes до Task 12 (gate) — только после явного применения 016.
- RLS обязателен на новой таблице: проектная ловушка `ALTER DEFAULT PRIVILEGES ... GRANT SELECT TO public`
  (final_001:297) ⇒ ENABLE RLS + SELECT policy В ТОЙ ЖЕ миграции; никаких write-политик для anon/authenticated.
- Sort_order колонка УЖЕ существует (`categories.sort_order`) — новой колонки не создавать.
- Правило порядка: `sort_order ASC → name localeCompare uk → id` (общий компаратор `compareCategories`).
  `created_at` УБРАТЬ из ordering rules везде, где конкурирует с этим правилом.
- URL контракт не менять: одиночный `category=<slug>`.
- Не ломать: SEO canonical/noindex (`app/lib/seo.ts`), mobile sheet, recent/reviews/popular,
  checkout/orders, importer price/stock (RRP-only) логику.
- Service-role ключ только серверно (`requireAdminApi()`), никогда в client bundle.
- Тесты: node:test, запуск `npm test`; шаблоны наблюдения кода: `readFileSync` + `assert.match`.
- Типовой запрет: без лишних комментариев в новом коде (repo-style допускает содержательные WHY-комменты).
- Explicit `.ts` extension требуется в imports под node:test ESM для lib-модулей тестируемых напрямую.

---

### Task 1: Migration 016 + static-invariant test

**Files:**
- Create: `database/migrations/016_product_categories.sql`
- Test: `tests/migration-016-invariants.test.ts`

**Interfaces:**
- Produces: таблица `product_categories(product_id, category_id, PK, FK CASCADE ×2, index(category_id))`,
  RLS on + anon/authenticated SELECT policy «активный продукт И активная категория».
  Никаких других объектов.

- [ ] **Step 1: Написать фейлящий инвариант-тест**

```ts
// tests/migration-016-invariants.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(process.cwd(), 'database/migrations/016_product_categories.sql'),
  'utf8'
);

test('MIGRATION-016: creates junction with composite PK', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS product_categories/i);
  assert.match(sql, /PRIMARY KEY\s*\(\s*product_id,\s*category_id\s*\)/i);
});

test('MIGRATION-016: FKs to products and categories are ON DELETE CASCADE', () => {
  const fks = sql.match(/REFERENCES\s+(products|categories)\s*\(\s*id\s*\)\s+ON DELETE CASCADE/gi) ?? [];
  assert.equal(fks.length, 2);
});

test('MIGRATION-016: category_id index exists', () => {
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_product_categories_category_id\s+ON product_categories\(category_id\)/i);
});

test('MIGRATION-016: RLS enabled with explicit SELECT-only policy', () => {
  assert.match(sql, /ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /FOR SELECT/i);
  assert.match(sql, /is_active\s*=\s*(TRUE|true)/i);
  // No INSERT/UPDATE/DELETE policies, no grants beyond select
  assert.doesNotMatch(sql, /FOR (INSERT|UPDATE|DELETE)/i);
});

test('MIGRATION-016: contains NO data writes (backfill is a separate op)', () => {
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\b(?!\s*updated_at)/i);
});
```

- [ ] **Step 2:** Run `node --test tests/migration-016-invariants.test.ts` — FAIL (файла нет).
- [ ] **Step 3: Создать миграцию** (заголовок по стилю 010/015):

```sql
-- 016_product_categories.sql
-- Many-to-many product<->categories. Stores DIRECT assignments only:
-- parent/descendant visibility is computed in application code from the
-- category tree (collectSubtreeIds), never materialized here.
-- Legacy transition: products.category_id is kept in sync as the
-- default/primary category until a future cleanup migration.
--
-- NOTE: no data backfill in this file (separate operation AFTER this
-- migration is applied manually via Supabase SQL Editor).
--
-- Project footgun (final_001: ALTER DEFAULT PRIVILEGES GRANT SELECT TO
-- public): every new table starts world-readable unless RLS is enabled
-- immediately. Hence ENABLE RLS + explicit policy in the SAME migration.

CREATE TABLE IF NOT EXISTS product_categories (
    product_id  UUID NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_product_categories_category_id
  ON product_categories(category_id);

ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon and authenticated can read active product-category links"
  ON product_categories;

CREATE POLICY "Anon and authenticated can read active product-category links"
  ON product_categories
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (SELECT 1 FROM products p   WHERE p.id  = product_id  AND p.is_active = TRUE)
    AND
    EXISTS (SELECT 1 FROM categories c WHERE c.id = category_id AND c.is_active = TRUE)
  );

-- No INSERT/UPDATE/DELETE policies: writes go through the service-role
-- (admin API + importer), never through user sessions.
```

- [ ] **Step 4:** Test PASS. Commit `feat(db): 016 product_categories junction (schema only)`.

---

### Task 2: Чистые помощники дерева — `collectSubtreeIds` + collapsible `buildCategoryOptions`

**Files:**
- Modify: `app/lib/category-tree.ts`
- Modify: `tests/category-tree.test.ts` (добавить, ничего не удаляя)

**Interfaces:**
- Produces:
  - `collectSubtreeIds(categories: Category[], seedId: string): Set<string>` — seed + все потомки
    (depth >1 поддержан), защищён от циклов и сирот, детерминирован.
  - `buildCategoryOptions(categories, opts?: { expanded?: ReadonlySet<string> })` — при переданном
    `expanded` дети включаются только если их родитель ∈ expanded; БЕЗ opts — прежнее поведение
    (полное дерево), все существующие вызовы/тесты работают.

- [ ] **Step 1: Фейлящие тесты** (добавить в конец существующего файла):

```ts
import { collectSubtreeIds } from '../app/lib/category-tree.ts';

test('SUBTREE: seed + all descendants, depth > 1', () => {
  const tree = [
    cat('root', 'Root', null),
    cat('mid', 'Mid', 'root'),
    cat('leaf', 'Leaf', 'mid'),
    cat('deep', 'Deep', 'leaf'),
    cat('other', 'Other', null),
  ];
  const ids = collectSubtreeIds(tree, 'root');
  assert.ok(['root', 'mid', 'leaf', 'deep'].every((i) => ids.has(i)));
  assert.ok(!ids.has('other'));
});

test('SUBTREE: leaf seed returns only itself', () => {
  const ids = collectSubtreeIds(FIXTURE, 'blender');
  assert.deepEqual([...ids], ['blender']);
});

test('SUBTREE: orphan seed (missing from set) -> only itself', () => {
  const ids = collectSubtreeIds(FIXTURE, 'ghost');
  assert.deepEqual([...ids], ['ghost']);
});

test('SUBTREE: cycle protection terminates and every reachable node is included once', () => {
  const cyclic = [
    cat('a', 'A', 'b'),
    cat('b', 'B', 'a'),
    cat('solo', 'Solo', null),
  ];
  const ids = collectSubtreeIds(cyclic, 'a');
  assert.equal(ids.size, 2);
});

test('OPTIONS: expanded set hides unexpanded children', () => {
  const expanded = new Set(['root-tech']);
  const options = buildCategoryOptions(FIXTURE, { expanded });
  assert.ok(options.some((o) => o.id === 'blender'));
  assert.ok(!options.some((o) => o.id === 'kettles')); // not expanded
  assert.ok(!options.some((o) => o.id === 'pots-a'));  // kitchen branch collapsed
});

test('OPTIONS: no expanded option keeps full-tree behavior', () => {
  const full = buildCategoryOptions(FIXTURE);
  assert.deepEqual(buildCategoryOptions(FIXTURE, {}).map((o) => o.id), full.map((o) => o.id));
});
```

- [ ] **Step 2:** `node --test tests/category-tree.test.ts` — новые FAIL, прежние PASS.
- [ ] **Step 3: Реализация** — добавить после `compareSiblings` (экспортировать компаратор:

```ts
export function compareCategories(a: Category, b: Category): number
```

— используйте её внутри вместо локальной `compareSiblings`, чтобы переиспользовать в admin-order):

```ts
export function collectSubtreeIds(categories: Category[], seedId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  const known = new Set(categories.map((c) => c.id));
  for (const c of categories) {
    if (c.parent_id && known.has(c.parent_id)) {
      const list = childrenOf.get(c.parent_id) ?? [];
      list.push(c.id);
      childrenOf.set(c.parent_id, list);
    }
  }
  const out = new Set<string>([seedId]);
  const stack = [seedId];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const child of childrenOf.get(cur) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}
```

В `buildCategoryOptions`: сигнатура
`(categories: Category[], opts?: { expanded?: ReadonlySet<string> })`;
при наличии `expanded` строка
`for (const child of (childrenOf.get(node.id) ?? []).sort(compareCategories))`
оборачивается guard'ом `if (!opts?.expanded || opts.expanded.has(node.id))`;
плюс корни-дети фильтруются так же. Существующий walk-код неизменен.

- [ ] **Step 4:** полный файл теста PASS. Commit `feat(category-tree): subtree collection + collapsible options`.

---

### Task 3: Единообразие sort_order в storefront-fetch

**Files:**
- Modify: `app/lib/catalog.ts:619-633` (`fetchActiveCategories`)
- Test: `tests/sort-order-invariants.test.ts` (новый)

- [ ] **Step 1: Фейлящий тест**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('SORT-ORDER: fetchActiveCategories does not use created_at as competing order', () => {
  const src = readFileSync('app/lib/catalog.ts', 'utf8');
  const fn = src.slice(src.indexOf('export async function fetchActiveCategories'),
                       src.indexOf('export async function fetchActiveBrands'));
  assert.match(fn, /\.order\('sort_order', \{ ascending: true \}\)/);
  assert.doesNotMatch(fn, /created_at/);
});
```

- [ ] **Step 2:** FAIL. **Step 3:** заменить `.order('created_at', { ascending: false })` на
  `.order('id', { ascending: true })` (детерминированный fallback; коммерческий порядок — только sort_order).
- [ ] **Step 4:** PASS, `npm test` целиком зелёный. Commit `fix(catalog): drop created_at tiebreak from category ordering`.

---

### Task 4: Storefront фильтрация через junction (каталог + count + related)

**Files:**
- Modify: `app/lib/catalog.ts` (PRODUCT_SELECT area, fetchCatalogProducts, fetchRelatedStage/fetchRelatedProducts)
- Test: `tests/junction-filter.test.ts` (новый, source-invariant)

**Interfaces:**
- Consumes: `collectSubtreeIds` (Task 2), `findCategoryIdBySlug` (сущ.)
- Produces: внутренние константы `CATEGORY_JUNCTION_EMBED_DATA = ', pc:product_categories!inner(category_id)'`
  и `CATEGORY_JUNCTION_EMBED_COUNT = ', pc:product_categories!inner(id)'`; фильтр
  `.in('pc.category_id', subtreeIds)` на ОБОИХ запросах (data+count), только когда `categoryId` задан.
  `ProductJoinedRow` получает опциональное поле `pc`, вычищаемое в `normalizeProduct`.

- [ ] **Step 1: Фейлящие тесты**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = () => readFileSync('app/lib/catalog.ts', 'utf8');

test('JUNCTION-FILTER: catalog applies subtree ids to BOTH count and data queries', () => {
  const s = src();
  const countPart = s.slice(s.indexOf('-- total count with identical filters'),
                            s.indexOf('const total = count ?? 0;'));
  const dataPart = s.slice(s.indexOf('// ---- paged data query ----'),
                           s.indexOf('// Every sort gets `id` as a deterministic tiebreaker'));
  for (const part of [countPart, dataPart]) {
    assert.doesNotMatch(part, /\.eq\('category_id', categoryId\)/, 'strict FK eq removed');
    assert.match(part, /\.in\('pc\.category_id', subtreeIds\)/);
  }
});

test('JUNCTION-FILTER: related products stage-1 goes through subtree, not FK equality', () => {
  const s = src();
  assert.doesNotMatch(s, /eq\('category_id', /);
  assert.match(s, /collectSubtreeIds/);
});

test('JUNCTION-FILTER: normalizeProduct strips the pc embed', () => {
  assert.match(src(), /\bpc\b[^]*?= null|const \{ pc: _pc[\s\S]*?\.\.\.rest/);
});
```

- [ ] **Step 2:** FAIL. **Step 3: Реализация** (эскиз точных правок):

```ts
import { collectSubtreeIds } from './category-tree';
// + imports нужны ТОЛЬКО как side-effect свободные функции; полный список активных
// категорий достаётся один раз рядом с остальными dictionary-фичами:
let query = supabase.from('products').select(PRODUCT_SELECT).eq('is_active', true);
if (categoryId) {
  const cats = await fetchActiveCategories();
  const subtreeIds = Array.from(collectSubtreeIds(cats, categoryId));
  if (subtreeIds.length === 0 || subtreeIds.length === 1 && ??? ) // см. ниже
  query = query.select(PRODUCT_SELECT + ', pc:product_categories!inner(category_id)')
               .in('pc.category_id', subtreeIds);
}
```

Точная структура правок:
1. Над `fetchCatalogProducts` определить константы эмбедов (см. Interfaces).
2. В `fetchCatalogProducts` оба блока `if (categoryId)` заменить на:

```ts
let subtreeIds: string[] = [];
if (categoryId) {
  const cats = await fetchActiveCategories();           // один словарь на оба запроса
  subtreeIds = Array.from(collectSubtreeIds(cats, categoryId));
}
```

countQuery: `countQuery = countQuery.select(ELIGIBLE_COUNT_SELECT + ', pc:product_categories!inner(id)', {...same})`
→ затем `if (categoryId && subtreeIds.length > 0) countQuery = countQuery.in('pc.category_id', subtreeIds);`
(`subtreeIds.length === 0` невозможен — seed всегда включён; активность категории уже проверена slug-lookup'ом).
Data query аналогично с `PRODUCT_SELECT + ', pc:product_categories!inner(category_id)'`.
3. `ProductJoinedRow` в catalog.ts:

```ts
& {
  ...
  pc?: { category_id: string }[] | null;
};
```

`normalizeProduct`: первой строкой `const { pc: _pc, ...rest } = row;` (eslint-disable line если линт ругнётся),
далее `return { ...rest, ... }` как раньше.
4. Related: `fetchRelatedStage(filter, ..., opts?: { subtreeIds?: string[] })`:

```ts
if (opts?.subtreeIds && opts.subtreeIds.length > 0) {
  query = query
    .select(PRODUCT_SELECT.replace('*', '*', ) /* нет: просто append */)
    ...
}
```

Точно:

```ts
async function fetchRelatedStage(
  filter: { kind: 'brand'; id: string } | { kind: 'category'; subtreeIds: string[] } | null,
  currentId: string,
  limit: number
): Promise<Product[]> {
  let selectStr = PRODUCT_SELECT;
  let query = supabase.from('products').select(selectStr).eq('is_active', true).neq('id', currentId);
  if (filter?.kind === 'category') {
    query = query.select(PRODUCT_SELECT + ', pc:product_categories!inner(category_id)');
    query = query.in('pc.category_id', filter.subtreeIds);
  } else if (filter?.kind === 'brand') {
    query = query.eq('brand_id', filter.id);
  }
  ... // остальное прежнее (order/range/returns/map normalizeProduct)
}

export async function fetchRelatedProducts(product, limit = RELATED_LIMIT) {
  const sameCategory = product.category_id
    ? await (async () => {
        const cats = await fetchActiveCategories();
        return fetchRelatedStage({ kind: 'category', subtreeIds: Array.from(collectSubtreeIds(cats, product.category_id!)) }, product.id, limit);
      })()
    : Promise.resolve<Product[]>([]);
  ... // brand/newest как раньше; Promise.all сохранён
}
```

5. Комментарий-почему возле эмбеда (замена старого комментария про plain FK): мульти-категории
   живут в product_categories; legacy `products.category_id` содержит ТОЛЬКО default — фильтр по
   нему находил бы не все товары; паттерн `!inner` совпадает с проверенным живьём images-join
   (count не раздувается, дубли отсутствуют — PostgREST dedup верхнего уровня при o2m embed).

- [ ] **Step 4:** `node --test tests/junction-filter.test.ts` PASS; весь `npm test` PASS
  (зафиксировать, что существующие catalog-тесты не зависят от удалённых веток).
- [ ] Commit `feat(catalog): subtree-aware category filtering through product_categories`.

---

### Task 5: Importer — resilience при неразрешённой категории

**Files:**
- Modify: `app/lib/yugcontract/import-plan.ts` (mapFeedProducts/splitProductWrites/типы)
- Modify: `app/lib/yugcontract/import-run.ts` (select'ы ExistingProductRowLite + plan-path ~L700-773)
- Test: `tests/yugcontract-unresolved-category.test.ts` (новый)

**Правило (approved):**
- NEW продукт без разрешимой категории → НЕ создаётся (как сейчас), причина логируется в
  `unresolvedRefs` (сообщение уточнить: «новий товар не создано: категорія X не знайдена»).
- EXISTING продукт с неразрешимой категорией → поля (name/price/old_price/stock/availability)
  обновляются КАК ОБЫЧНО; категории не трогаются; запись попадает в отдельный список
  `unresolvedCategoryUpdates: SkipEntry[]` (НЕ молча — счётчик и сообщение в outcome message батча).
- Никогда не затирать существующую категорию на NULL.

- [ ] **Step 1: Фейлящие тесты**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitProductWrites } from '../app/lib/yugcontract/import-plan.ts';

function mapped(id: string, catYcId: string | null = '42') {
  return {
    yugcontract_id: id, sku: `YC-${id}`, slug: `slug-${id}`, name: `n-${id}`,
    price: 10, old_price: null, stock_quantity: 5,
    availability_status: 'in_stock', brandKey: null, catYcId,
  };
}
function existing(id: string, ycId: string, categoryId: string | null) {
  return {
    id, yugcontract_id: ycId, sku: `YC-${ycId}`, name: `n-${ycId}`, slug: `slug-${ycId}`,
    price: 10, old_price: null, stock_quantity: 5, availability_status: 'in_stock',
    category_id: categoryId,
  };
}

test('UNRESOLVED-CAT: existing product still gets field updates when category unresolved', () => {
  const res = splitProductWrites([mapped('1')], [existing('p1', '1', 'old-cat')], () => ({ brand_id: null, category_id: null }));
  assert.equal(res.updates.length, 1, 'field update must survive');
  assert.equal(res.updates[0].fields.category_id, undefined);
  assert.equal(res.unresolvedRefs.length, 0);
  assert.equal(res.unresolvedCategoryUpdates.length, 1);
  assert.match(res.unresolvedCategoryUpdates[0].reason, /42 не знайдено/);
});

test('UNRESOLVED-CAT: new product without resolvable category is skipped with reason', () => {
  const res = splitProductWrites([mapped('9')], [], () => ({ brand_id: null, category_id: null }));
  assert.equal(res.inserts.length, 0);
  assert.match(res.unresolvedRefs[0].reason, /новий товар не створено/);
});

test('UNRESOLVED-CAT: no silent null-overwrite ever', () => {
  const res = splitProductWrites([mapped('1')], [existing('p1', '1', 'old-cat')], () => ({ brand_id: null, category_id: null }));
  assert.notEqual(JSON.stringify(res.updates[0].fields), JSON.stringify({ category_id: null }));
});
```

Прим.: интерфейс `ExistingProductRow` пополняется `category_id: string | null`.
- [ ] **Step 2:** FAIL. **Step 3: Реализация:**
  - `splitProductWrites`: убрать ранний skip-before-split; структура веток:

```ts
const refs = resolveRefs(row);
const existing = existingByYc.get(row.yugcontract_id);
if (!existing) {
  if (refs.category_id === null) {
    split.unresolvedRefs.push({ id: row.yugcontract_id,
      reason: `новий товар не створено: категорію ${row.catYcId ?? '—'} не знайдено в БД` });
    continue;
  }
  /* прежний insert-path (RRP check unchanged) */
  continue;
}
/* existing-path: поля как раньше */
if (Object.keys(fields).length > 0 || <category ops planned>) { push update }
```

  - Новый массив `unresolvedCategoryUpdates: SkipEntry[]` в `ProductWriteSplit`.
  - Точную рекатегоризацию (поля `category_id` + junction ops) добавляет Task 6 — здесь ONLY
    restore of field-updates + классификация. При конфликте сообщений тестов Task 5 приоритет.
- [ ] **Step 4:** PASS. Commit `fix(importer): price/stock sync survives unresolved category`.

---

### Task 6: Importer — junction writes + recategorization

**Files:**
- Modify: `app/lib/yugcontract/import-plan.ts` (ResolvedInsert/ProductUpdateOp/ProductWriteSplit)
- Modify: `app/lib/yugcontract/import-run.ts` (runProductsBatch L~474-600; read-only plan path L~660-773)
- Test: `tests/yugcontract-junction-sync.test.ts` (новый)

**Контракт recategorization (approved #1):**
- Существующему товару с НОВОЙ листовой категорией: `products.category_id = новый UUID` (update)
  И синхронная замена junction-связей (старая строка удалена, новая вставлена) — «replace-all»
  семантика для YC-строк (одна прямая связь = YC-листовая категория).
- Атомарность: в границах чекпоинт-батча (идемпотентный повтор). Частичный сбой строки считается
  `errors` как прочие update-сбои, retry батча безопасен.
- Парентовых связей НЕ создавать.

- [ ] **Step 1: Фейлящие тесты**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitProductWrites } from '../app/lib/yugcontract/import-plan.ts';
// helpers mapped()/existing() из Task 5 импортировать нельзя (локальные) — скопировать компактно

test('RECATEGORY: changed category produces category_id update + junction replace op', () => {
  const res = splitProductWrites([mapped('1')],
    [existing('p1', '1', 'uuid-old')],
    () => ({ brand_id: null, category_id: 'uuid-new' }));
  assert.equal(res.updates.length, 1);
  assert.equal(res.updates[0].fields.category_id, 'uuid-new');
  assert.deepEqual(res.updates[0].categorySync, { oldCategoryId: 'uuid-old', newCategoryId: 'uuid-new' });
});

test('RECATEGY(neg): same category -> no categorySync op emitted', () => {
  const res = splitProductWrites([mapped('1')],
    [existing('p1', '1', 'uuid-new')],
    () => ({ brand_id: null, category_id: 'uuid-new' }));
  assert.equal(res.updates[0].fields.category_id, undefined);
  assert.equal(res.updates[0].categorySync, undefined);
});

test('RECATEGORY: insert op carries category for junction insert', () => {
  const res = splitProductWrites([mapped('2')], [],
    () => ({ brand_id: null, category_id: 'uuid-c' }));
  assert.equal(res.inserts[0].category_id, 'uuid-c');
});

test('RECATEGORY: unresolved category on existing -> neither category_id nor junction touched', () => {
  const res = splitProductWrites([mapped('1')],
    [existing('p1', '1', 'uuid-old')],
    () => ({ brand_id: null, category_id: null }));
  assert.equal(res.updates[0].categorySync, undefined);
});
```

- [ ] **Step 2:** FAIL. **Step 3: Реализация:**
  - `ProductUpdateOp += categorySync?: { oldCategoryId: string | null; newCategoryId: string }`.
  - В existing-ветке: `existing.category_id` доступен благодаря Task 5 типу;
    `if (refs.category_id !== null && (existing.category_id ?? null) !== refs.category_id)`
    → `fields.category_id = refs.category_id; op.categorySync = {...}`.
  - `import-run.ts` runProductsBatch:
    1. Select'ы existing+squat rows добавить `category_id` (обе ветки L488-513 + lite-type).
    2. После inserts: собрать `pcRows = split.inserts.map(r=>({product_id:r.returned_id...}))` —
       `insertChunked(client,'products',part,'id')` уже возвращает id; сделать
       `insertChunked(client, 'product_categories', inserts.map((r,idx)=>({product_id: returnedIds[idx], category_id: r.category_id})), 'product_id')`
       (вставлять чанками по возвращённым id).
    3. В цикле updates (L544-564) после успешного update:
       `if (op.categorySync) { delete all pc rows for product (`.delete().eq('product_id', op.id)`); insert `{product_id, category_id: newCategoryId}` }`,
       ошибки копятся в `errors` без прерывания.
    4. Outcome message добавить счётчик: `recategorized=N` когда ≥1 categorySync.
    5. Read-only план (вторая кодовая дорога splitProductWrites ~L700+) обновить те же select'ы.
  - Документ-комментарий у replace-semantics: админские дополнительные связи YC-товаров затираются
    следующим импортом (осознанное правило переходного периода).
- [ ] **Step 4:** новые тесты PASS + `tests/yugcontract-import.test.ts` PASS (правки соответствий).
  Commit `feat(importer): junction sync + automatic recategorization`.

---

### Task 7: Admin product API — много-категориальный dual-write

**Files:**
- Modify: `app/api/admin/products/route.ts` (POST)
- Modify: `app/api/admin/products/[id]/route.ts` (GET payload + PUT)
- Test: `tests/admin-products-multicat.test.ts` (новый, source-invariant)

**Контракт:**
- Body принимает `category_ids: string[]` (uuid-валидация каждого; не-uuid любой строки → 400
  «Некоректний id категорії»). ПУСТОЙ массив = очистить все связи + `category_id: null`.
- `products.category_id` всегда синхронизируется: = первый элемент массива или null (transition).
- PUT: replace-all (DELETE связей товара минус пришедший набор, INSERT недостающие; порядок операций:
  delete-выше-insert чтобы PK-конфликты не ловились).
- GET detail добавляет `category_ids: string[]` (read из junction, сортировка по category_id asc — стабильная).

- [ ] **Step 1: Фейлящий тест**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const post = () => readFileSync('app/api/admin/products/route.ts', 'utf8');
const one = () => readFileSync('app/api/admin/products/[id]/route.ts', 'utf8');

test('ADMIN-MULTICAT: POST writes junction rows from category_ids', () => {
  const s = post();
  assert.match(s, /from\('product_categories'\)/);
  assert.match(s, /category_ids/);
});

test('ADMIN-MULTICAT: PUT validates every uuid before touching db', () => {
  const s = one();
  assert.match(s, /Некоректний id категорії/);
  assert.match(s, /product_categories/);
});

test('ADMIN-MULTICAT: GET detail returns category_ids', () => {
  assert.match(one(), /category_ids/);
});

test('ADMIN-MULTICAT: legacy category_id stays synchronized (= first selected)', () => {
  const s = one();
  assert.match(s, /category_ids\[0\]|category_ids\.at\(0\)|firstId/);
});
```

- [ ] **Step 2:** FAIL. **Step 3: Реализация** (ключевые куски):

```ts
// shared helper (в обоих route-файлах или в admin-api.ts):
function parseCategoryIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const raw of value) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!isUuid(id)) return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}
```

POST: после успешного insert → `if (Array.isArray(body.category_ids))` вставка junction
через цикл чанков (как insertChunked — локальный мини-цикл `serviceClient.from('product_categories').insert(rows)`).
PUT (только когда `'category_ids' in body`):
  validate → `patch.category_id = ids[0] ?? null` (логическая замена правилу L156 — сохранить
  старую поддержку `'category_id' in body` отдельно для совместимости: если пришли оба поля,
  `category_ids` имеет приоритет);
  после UPDATE продукта:
  ```ts
  const { error: delErr } = await ctx.serviceClient
    .from('product_categories').delete().eq('product_id', id).not('category_id','in',`(${ids.join(',')})`);
  ```
  (при ids=[] использовать `.not` удалить всё проще: отдельная ветка `.delete().eq('product_id', id)`)
  → insert недостающих строк (skip при пустом списке).
GET: третий параллельный read `product_categories.select('category_id').eq('product_id', id)`,
ответ `category_ids: rows.map(r=>r.category_id).sort()`.
- [ ] **Step 4:** PASS + регресс `npm test`. Commit `feat(admin-api): multi-category writes with legacy dual-write`.

---

### Task 8: Admin-list — поиск/фильтр категорий через junction

**Files:**
- Modify: `app/lib/admin-list.ts` (buildProductExpressions, listAdminProducts, pagedAdminRead, PRODUCT_SELECT row-type)
- Modify: `app/api/admin/products/route.ts` (GET — прокинуть `categoryId` param)
- Test: расширение `tests/admin-search-pagination.test.ts` + `tests/admin-junction-search.test.ts` (новый)

**Дизайн (per constraint «embed-пути в or= падают на живом PostgREST»):**
1. Новый параметр `categoryId` (из явного dropdown фильтра): внутри `listAdminProducts` резолвится
   в поддерево чистым хелпером (fetchAllCategories → collectSubtreeIds → Set) и применяется
   BUILDER-level `.in('pc.category_id', ids)` + `pc:product_categories!inner(id)` в select строках
   count и data (тот же трюк, что Task 4). Пагинация/count не страдают, дублей нет.
2. Token-search ветка `category_id.in.(...)` (L189-190): ids расширяются ДО полного поддерева
   каждого найденного имени/slug-совпадения (fetchAllCategories + collectSubtreeIds) — legacy
   `products.category_id` всегда ∈ junction (обеспечивают все писатели), поэтому поиск по дефолтной
   категории находит и дочерние ветки. Полная junction-семантика token-search покрывается явно
   dropdown-фильтром п.1 (документированный transition-gap: товар с НЕ-default назначением не найдётся
   текстовым токеном имени категории — принять, отметить в комментарии).
3. Row-type: `ProductJoinedRow` + `pc?: { id: string }[] | null`; `normalizeProduct` — вычистка как Task 4.

- [ ] **Step 1: Фейлящие тесты**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('ADMIN-JUNCTION: categoryId param drives builder-level subtree filter (not inside or=)', () => {
  const s = readFileSync('app/lib/admin-list.ts', 'utf8');
  assert.match(s, /collectSubtreeIds/);
  assert.match(s, /pc\.category_id/);
  assert.match(s, /product_categories!inner\(id\)/);
});

test('ADMIN-JUNCTION: token-search category branch expands to subtrees', () => {
  const s = readFileSync('app/lib/admin-list.ts', 'utf8');
  const branch = s.slice(s.indexOf('async function buildProductExpressions'),
                         s.indexOf('function buildPlainExpressions'));
  assert.match(branch, /expandToSubtrees|collectSubtreeIds/);
});

test('ADMIN-JUNCTION: products route exposes categoryId param', () => {
  assert.match(readFileSync('app/api/admin/products/route.ts', 'utf8'), /categoryId/);
});
```

- [ ] **Step 2:** FAIL. **Step 3: Реализация:**
  - `pagedAdminRead(options)` получает `extra?: { selectSuffix: string; filter: { column: string; inIds: string[] } }`
    применяемую к count- и data-строителям одинаково.
  - Хелпер `async function resolveCategorySubtreeIds(client, categoryIdOrIds): Promise<string[]>`
    — через `fetchAllCategories` + `collectSubtreeIds` (импорт из './category-tree').
  - Гейт: ids приходят только когда categoryId param задан; иначе поведение байт-в-байт прежнее.
  - Расширить существующий fake-harness в admin-search-pagination.test.ts: mock-клиент учитывает
    `.in('pc.category_id', …)` (фильтрация по junction-фикстуре) — минимум два сценария:
    «категория найдена через не-первую связь», «поддерево родителя включает child-only товары»,
    плюс отсутствие дублей и верные total/page.
- [ ] **Step 4:** PASS оба файла. Commit `feat(admin-list): junction-aware category search/filter`.

---

### Task 9: Admin reorder категорий (endpoint + UI)

**Files:**
- Create: `app/api/admin/categories/[id]/order/route.ts`
- Modify: `app/admin/(dashboard)/categories/page.tsx` (кнопки ↑/↓ в строке таблицы + вызов)
- Test: `tests/category-reorder.test.ts` (новый)

**Семантика:**
- POST {direction: 'up'|'down'}; requireAdminApi(); isUuid guard (400).
- Загрузка товара + всех сиблингов той же группы parent_id (range ≤1000).
- Общий компаратор `compareCategories` (Task 2 export) → сортировка в JS.
- Чистая функция `moveInGroup(group: {id,sort_order:number,name:string,updated_at?:...}[], id, dir)`
  → `string[]` нового порядка соседей (или null если край) — unit-testable, без IO.
- После обмена нормализация sort_order ВСЕЙ группы: присвоить индекс i каждому сиблингу
  (0..n-1) последовательными update'ами только этой группы. Детерминировано, уничтожает
  дубли/абсурдные значения накапливающиеся от импорта (все 205 сейчас 0), без отрицательных.
- Race: last-write-wins между конкурентными кликами (полная перезапись группы из свежего
  снапшота) — задокументировано честно в комментариях route.

- [ ] **Step 1: Фейлящие тесты**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveInGroup } from '../app/lib/category-tree.ts'; // поместить функцию ТУДА (shared, pure)

test('REORDER: swap neighbors up/down within sibling group', () => {
  const g = [{ id: 'a', sort_order: 0, name: 'A' }, { id: 'b', sort_order: 0, name: 'B' }, { id: 'c', sort_order: 0, name: 'C' }];
  assert.deepEqual(moveInGroup(g, 'c', 'up')!.map(x => x.id), ['a', 'c', 'b']);
  assert.deepEqual(moveInGroup(g, 'a', 'up'), null);
  assert.deepEqual(moveInGroup(g, 'c', 'down'), null);
});

test('REORDER: order-independent of incoming array (sorted by common comparator first)', () => {
  const g = [{ id: 'z', sort_order: 3, name: 'Z' }, { id: 'y', sort_order: 1, name: 'Y' }];
  assert.deepEqual(moveInGroup(g, 'z', 'up')!.map(x => x.id), ['y', 'z']);
});
```

Маршрутный тест (source-invariant): файл существует, использует `requireAdminApi`, `isUuid`,
читает родителя до сиблингов, пишет обратно `sort_order` числом ≥0.

- [ ] **Step 2:** FAIL. **Step 3: Реализация.** Route эскиз:

```ts
// POST /api/admin/categories/<id>/order  body { direction: 'up' | 'down' }
const group = await ctx.serviceClient.from('categories')
  .select('id,parent_id,name,sort_order')
  .eq('parent_id', parent.parent_id ?? ...)
```

(supabase-js: `.eq('parent_id', parentId)` где parentId может быть null → использовать
`.is('parent_id', null)` ветку), далее `moveInGroup` → per-row update loop (group ≤ 205 rows),
500 на ошибку, иначе `{ reordered: group.length }`.
UI: в actions-cell добавить две кнопки «↑»/«↓» (aria-label «Перемістити вище/нижче»),
disabled на краях визуально не обязательно (noop-ответ 200), после вызова — существующий refetch списка.
- [ ] **Step 4:** PASS. Commit `feat(admin): sibling-scoped category reorder endpoint + arrows UI`.

---

### Task 10: AdminCategoryMultiSelect + wiring в форму товара

**Files:**
- Create: `app/components/AdminCategoryMultiSelect.tsx`
- Modify: `app/admin/(dashboard)/products/page.tsx`
  (ProductFormState L129-161: `category_id: string` → `category_ids: string[]`; submit L367;
  prefill L306; form-control L719-728)
- Test: `tests/admin-multiselect.test.ts` (source-invariant, стиль category-select.test.ts)

**Требования UX/a11y (approved #4):** поиск по полному множеству; дерево с чекбоксами
(depth-indent), независимые галочки (никакого авто-каскада вниз — junction хранит прямые
назначения); chips выбранных над деревом с кнопкой «✕» (aria-label `Видалити <label>`); native
checkbox inputs → клавиатура/a11y бесплатно; сортировка через общий компаратор (Task 2).

- [ ] **Step 1: Фейлящий тест**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const comp = () => readFileSync('app/components/AdminCategoryMultiSelect.tsx', 'utf8');

test('ADMIN-MULTI: search input filters the FULL option set', () => {
  assert.match(comp(), /filterCategoryOptions/);
  assert.match(comp(), /type="text"/);
});

test('ADMIN-MULTI: checkboxes, no cascading auto-check of children', () => {
  assert.match(comp(), /type="checkbox"/);
  assert.doesNotMatch(comp(), /children\.forEach|\.filter\(c => c\.parent_id === .*onChange/);
});

test('ADMIN-MULTI: removable chips expose accessible remove buttons', () => {
  assert.match(comp(), /aria-label=\{`Видалити/);
});

test('ADMIN-MULTI: duplicate names distinguishable through label/path', () => {
  assert.match(comp(), /option\.label/);       // title/sr-only path usage
  assert.match(comp(), /option\.path/);
});

test('PRODUCTS PAGE: form uses multi-state and submits category_ids array', () => {
  const s = readFileSync('app/admin/(dashboard)/products/page.tsx', 'utf8');
  assert.match(s, /category_ids:\s*string\[\]/);
  assert.match(s, /AdminCategoryMultiSelect/);
  assert.doesNotMatch(s, /name="category_id"/);  // legacy single select gone
});
```

- [ ] **Step 2:** FAIL. **Step 3: Реализация.** Компонент (скелет):

```tsx
'use client';
export default function AdminCategoryMultiSelect({
  categories, selectedIds, onChange,
}: {
  categories: Category[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const options = useMemo(() =>
    filterCategoryOptions(buildCategoryOptions(categories), query), [categories, query]);
  const selected = useMemo(() =>
    categories.filter(c => selectedIds.includes(c.id))
      .sort((a, b) => compareCategories(a, b)), [categories, selectedIds]);
  // chips: selected.map -> button aria-label={`Видалити ${path.join(' → ')}`}
  // list: options.map -> <li style={{paddingLeft}}> <label><input type="checkbox"
  //        checked={selectedIds.includes(o.id)} onChange={() => toggle(o.id)} /> {o.name}</label>
  // sr-only: <span className="sr-only">{o.label}</span>
}
```

Wiring: EMPTY_FORM.category_ids = []; open-edit заполняет из GET payload (`category_ids`),
open-create очищает; submit `body.category_ids = formData.category_ids`.
Prefill продуктового списка пост-обновления — существующий refetch покрывает.
- [ ] **Step 4:** PASS. Commit `feat(admin-ui): tree multi-select for product categories`.

---

### Task 11: Storefront CategorySelect — раскрывающееся дерево

**Files:**
- Modify: `app/components/CategorySelect.tsx`
- Test: `tests/category-select.test.ts` (расширить)

**Детали реализации:**
- State `expandedIds: Set<string>` (init: пусто — все корни схлопнуты; requirement макет показывает ▸).
- Строка li теперь: `[toggle btn (если есть дети)] + [select btn (role="option"-носитель)]`:
  - toggle: `<button type="button" aria-expanded={isOpen} aria-controls={`cat-kids-${index}`} aria-label={`${name}: розгорнути/згорнути`} onClick={toggle}>▸/▼</button>`
  - select-btn несёт aria-selected/activedescendant id как раньше (id переносится НА него).
  - клик стрелки НЕ выбирает (stopPropagation не нужен — разные элементы).
- Клавиатура поверх контейнера: ArrowRight на активном узле с детьми → expand; ArrowLeft → collapse;
  остальное прежнее (Down/Up/Enter/Escape/focus/scroll). Mouse hover-подсветка прежняя.
- Поиск: при непустой query дерево показывается полностью раскрытым (deterministic, обнаруживаемость);
  пустой query чтит expandedIds. Реализация: `visible = query ? filtered : filtered.filter(inExpandedChain)`
  где цепочка предков через option.path/id→parent map — считать ancestors set from `expandedIds ∪ {roots}`.
- «Всі категорії» и сортировки не меняются. Mobile sheet наследует (компонент общий).
- Все прежние обязанности `commitAndClose` остаются только на выборе, не на toggle.

- [ ] **Step 1: Фейлящие тесты** (добавить к существующим):

```ts
test('CS-TREE: arrow toggle carries aria-expanded and separate aria-controls', () => {
  expectSource(/aria-expanded=\{/);
  expectSource(/aria-controls=/);
  expectSource(/розгорнути\/згорнути/);
});
test('CS-TREE: search reveals everything; empty query honors collapsed state', () => {
  expectSource(/query \?|\bquery\b.*!/ ); // ternary or boolean coercion guard present
});
test('CS-TREE: keyboard ArrowRight/ArrowLeft expand/collapse active node', () => {
  expectSource(/'ArrowRight'/);
  expectSource(/'ArrowLeft'/);
});
test('CS-TREE: URL-contract untouched — component still emits slug only', () => {
  expectSource(/onChange\(option\.slug\)/);
});
```

(expectSource — существующий локальный хелпер файла теста; повторить паттерн точно по его коду).
- [ ] **Step 2:** FAIL. **Step 3:** реализация (структура выше). **Step 4:** PASS,
  включая прежний `tests/category-select.test.ts`. Commit `feat(storefront): collapsible category tree picker`.

---

### Task 12: PRODUCTION GATE — migration apply → backfill → verification

**⚠️ Единственный раздел с production DB writes. Выполняется строго после Tasks 1-11 all-green.**

**Files:**
- Create: `scripts/backfill-product-categories.sql`
- Create: `scripts/verify-product-categories.mjs` (READ-ONLY)

- [ ] **Шаг A:** baseline (READ-ONLY): `SELECT count(*) FROM products WHERE category_id IS NOT NULL;`
  (ожидание ≈ 4322) и `SELECT count(*) FROM products;` (≈ 4323) — записать результаты.
- [ ] **Шаг B:** применить `database/migrations/016_product_categories.sql`:
  попробовать `psql "$DATABASE_URL" -f database/migrations/016_product_categories.sql`
  (проверить наличие переменной подключения в окружении/.env.local; при отсутствии — выдать SQL
  пользователю для SQL Editor и дождаться подтверждения). Только DDL, данные не тронуты.
- [ ] **Шаг C:** backfill одним statement (`scripts/backfill-product-categories.sql`):

```sql
INSERT INTO product_categories (product_id, category_id)
SELECT id, category_id FROM products WHERE category_id IS NOT NULL
ON CONFLICT DO NOTHING;
```

- [ ] **Шаг D:** verification READ-ONLY (`scripts/verify-product-categories.mjs` против
  `SUPABASE_URL` + publishable/service через REST-селекты):
  1. total products == baseline;
  2. junction rows == baseline-count (без дублей: группировки невозможны при PK — проверить count);
  3. products с category_id NOT NULL но без junction-строки == 0;
  4. распределение по 3 известным parent-категориям и 3 leaf (storefront-side replica-запрос
     тем же скриптом: counts сходятся);
  5. выборочные товары (LIKE '%%' LIMIT 5) — junction содержит их категорию.
  Запуск: `node scripts/verify-product-categories.mjs`. Любое несовпадение → STOP и репорт.
- [ ] **Шаг E:** коммит `chore(db): backfill + verification scripts (applied 2026-08-26)`.

---

### Task 13: Финальная верификация

- [ ] `npm test` (все ~50 файлов, ноль ред)
- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run dev` + Playwright desktop (1280×800):
      каталог → фильтр категории (родитель показывает sum детей, дублей нет), раскрытие/закрытие ▸▼,
      выбор ребёнка, выбор родителя, страница товара (breadcrumbs рабочие), pagination/search smoke,
      admin: multiselect (2 категории, chip-remove, invalid-free save), reorder ↑/↓ меняет таблицу,
      консоль БЕЗ ошибок. Скриншоты в `.playwright-mcp/`.
- [ ] Playwright mobile 390×844: открыть фильтры-шит, дерево, выбрать категорию, применить,
      проверить результат H1/chips/pagination, консоль clean. Скриншоты.
- [ ] git status чистый относительно коммитов задач; финальный отчёт пользователю (17 пунктов).

## Self-Review (done)

- Спек-покрытие: подконтрольные пункты задач 1-13 отображаются на все решения A-L аудита и GO-инструкцию;
  Administrative GET/PUT dual-write ✓; importer recat ✓ (T6); unresolved fix ✓ (T5); SEO/URL не трогаем ✓;
  RLS/default-privileges ✓ (T1); backfill после применения ✓ (T12 strictly ordered).
- Плейсхолдеры: код везде конкретен либо оговорён «точно указанные правки» со ссылками на реальные
  строки; ни TBD/TODO.
- Именование: `collectSubtreeIds`, `compareCategories`, `moveInGroup`, `category_ids`,
  `categorySync {oldCategoryId,newCategoryId}` едины во всех задачах.
