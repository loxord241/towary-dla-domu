/**
 * Лінолеум, батч 2: CLI-исполнитель scripts/linoleum-import.ts
 * (зеркало tests/wallpaper-import-cli.test.ts + tests/wallpaper-publish.test.ts).
 *
 * Контракт под тестом (статика — БД тестами НЕ трогается):
 *   - staging читается ПОСТРАНИЧНО (окна PAGE_SIZE = 1000, `.order('id')`,
 *     свежий builder на страницу) из `linoleum_stock` (миграция 052); дедуп
 *     «свежайшая строка на (code,width)» живёт В JS (prepareRows), не в SQL;
 *   - чтение существующих: домен ln-* (sku LIKE 'ln-%' через
 *     LINOLEUM_SKU_LIKE из app/lib/domains.ts);
 *   - все sync-записи живут ТОЛЬКО в applyPlan, вызываемом РОВНО ОДИН раз в
 *     ветке `--run`; `--plan` печатает план и возвращает 0 без записей;
 *   - `--publish` — отдельное действие: два батчевых is_active-flip'а внутри
 *     publishLinoleum (фото-гейт: есть ≥1 product_images → активна);
 *   - каждый батч записи ≤ BATCH_SIZE = 200;
 *   - каждое изменение стока → product_stock_history (reason '1c-sync',
 *     source '1c-linoleum');
 *   - НЕТ delete/rpc/upsert; sync НИКОГДА не пишет is_active у существующих
 *     (создаётся невидимым, is_active: false); вітрина принадлежит
 *     --publish;
 *   - корневая категория «Лінолеум» (slug linoleum) создаётся/переиспользуется
 *     через planRootCategory; junction product_categories + legacy
 *     products.category_id;
 *   - restock-хук — переиспользование notifyRestockRequests из шпалерного
 *     CLI (импорт, НЕ копия), вызов ровно один раз после успешного --run.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { LinoleumPlanRow } from '../app/lib/linoleum/import-plan.ts';
import {
  BATCH_SIZE,
  HISTORY_REASON,
  HISTORY_SOURCE,
  PAGE_SIZE,
  chunkRows,
  parseArgs,
  prepareRows,
  productInsertRow,
  publishLinoleum,
  stockHistoryRow,
} from '../scripts/linoleum-import.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'scripts/linoleum-import.ts';
const src = readFileSync(path.join(root, SCRIPT), 'utf8');

// ---------------------------------------------------------------------------
// Static structure invariants (raw source, comments stripped)
// ---------------------------------------------------------------------------

const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('CLI: --plan/--run/--publish — три режима, взаимоисключающие', () => {
  assert.match(code, /--plan/);
  assert.match(code, /--run/);
  assert.match(code, /--publish/);
  assert.match(code, /USAGE/);
});

test('CLI: staging read paged ≤1000 с .order(id) из linoleum_stock; дедуп (code,width) в JS (prepareRows)', () => {
  assert.match(code, /PAGE_SIZE = 1000/);
  assert.match(code, /\.from\('linoleum_stock'\)/);
  assert.match(code, /code,name,width_m,price_sqm,qty_m,export_date/);
  assert.match(code, /\.order\('id'\)/);
  assert.match(code, /\.range\(from, from \+ PAGE_SIZE - 1\)/);
  assert.match(code, /export function prepareRows/);
  // DISTINCT-семантика живёт в JS поверх постраничного чтения.
  assert.doesNotMatch(code, /\.distinct\(/);
});

test('CLI: чтение существующих — только домен ln-* (sku LIKE через LINOLEUM_SKU_LIKE)', () => {
  assert.match(code, /\.like\('sku', LINOLEUM_SKU_LIKE\)/);
  assert.match(code, /LINOLEUM_SKU_LIKE/, 'константа импортируется из domains.ts');
});

test('CLI: каждый батч записи ≤200 (creates, junction, updates, missing, history)', () => {
  assert.match(code, /BATCH_SIZE = 200/);
  assert.ok(
    (code.match(/chunkRows\(/g) ?? []).length >= 4,
    'chunkRows must gate every batched write'
  );
  assert.match(code, /\.select\('id,sku'\)/, 'product inserts collect ids');
});

test('CLI: изменения стока пишут product_stock_history (reason 1c-sync, source 1c-linoleum)', () => {
  assert.match(code, /from\('product_stock_history'\)/);
  assert.equal(HISTORY_REASON, '1c-sync');
  assert.equal(HISTORY_SOURCE, '1c-linoleum');
  assert.match(code, /reason: HISTORY_REASON/);
  assert.match(code, /source: HISTORY_SOURCE/);
});

test('CLI: НЕТ delete / rpc / upsert — только insert+update, план идемпотентен', () => {
  assert.doesNotMatch(code, /\.delete\(/);
  assert.doesNotMatch(code, /\.rpc\(/);
  assert.doesNotMatch(code, /\.upsert\(/);
});

test('CLI: sync (--plan/--run) НИКОГДА не пишет is_active — вітрина принадлежит --publish', () => {
  // Scope: всё, что sync-режимы могут исполнить, определено ДО publish-исполнителя.
  const publishIdx = code.indexOf('async function publishLinoleum');
  assert.ok(publishIdx !== -1, 'publish executor must exist');
  const syncPart = code.slice(0, publishIdx);
  assert.match(syncPart, /is_active: false/);
  assert.equal(
    (syncPart.match(/is_active: false/g) ?? []).length,
    1,
    'exactly the products-insert payload sets is_active (new rows stay invisible)'
  );
  assert.doesNotMatch(syncPart, /is_active:\s*true/);
  assert.doesNotMatch(syncPart, /\.update\([^)]*is_active/, 'sync never UPDATEs is_active');
});

test('CLI: --publish пишет is_active ровно двумя UPDATE-сайтами (enable + hide), оба батчами .in(id)', () => {
  const publishIdx = code.indexOf('async function publishLinoleum');
  const publish = code.slice(publishIdx);
  assert.equal((code.match(/is_active: true/g) ?? []).length, 1, 'ровно один enable-write');
  assert.equal(
    (code.match(/is_active: false/g) ?? []).length,
    2,
    'insert payload + ровно один hide-write'
  );
  assert.equal(
    (code.match(/\.update\(\{ is_active/g) ?? []).length,
    2,
    'is_active пишется ровно двумя UPDATE-сайтами'
  );
  const enableIdx = publish.indexOf('.update({ is_active: true })');
  const hideIdx = publish.indexOf('.update({ is_active: false })');
  assert.ok(enableIdx !== -1 && hideIdx !== -1, 'enable и hide UPDATE присутствуют');
  for (const [name, at] of [['enable', enableIdx], ['hide', hideIdx]] as const) {
    const site = publish.slice(at, at + 220);
    assert.match(site, /\.in\('id'/, `${name} UPDATE батчится по id (≤200)`);
  }
});

test('CLI: --plan не может писать — applyPlan вызывается ровно один раз, в ветке run', () => {
  const planIdx = code.indexOf("args.mode === 'plan'");
  const callIdx = code.indexOf('await applyPlan(');
  assert.ok(planIdx !== -1, 'plan branch must exist');
  assert.ok(callIdx !== -1, 'applyPlan must be invoked');
  assert.ok(callIdx > planIdx, 'applyPlan call must follow the plan branch');
  assert.equal((code.match(/await applyPlan\(/g) ?? []).length, 1);
  assert.ok(code.indexOf('.insert(') > callIdx);
  assert.ok(code.indexOf('.update(') > callIdx);
  const planBranch = code.slice(planIdx, callIdx);
  assert.doesNotMatch(planBranch, /\.insert\(|\.update\(|\.delete\(/);
});

test('CLI: --publish ветка возвращает результат ДО чтения staging и applyPlan', () => {
  const branchIdx = code.indexOf("args.mode === 'publish'");
  assert.ok(branchIdx !== -1, 'publish branch must exist in runImportCli');
  const stagingIdx = code.indexOf('const rawStaging');
  assert.ok(stagingIdx > branchIdx, 'staging read идёт после publish-ветки');
  const branch = code.slice(branchIdx, stagingIdx);
  assert.doesNotMatch(branch, /\.from\(/, 'publish-ветка не делает собственных чтений');
  assert.doesNotMatch(branch, /applyPlan/, 'publish-ветка не доходит до sync-исполнителя');
  assert.equal((code.match(/await publishLinoleum\(/g) ?? []).length, 1);
});

test('CLI: корневая категория «Лінолеум» через planRootCategory; junction + legacy category_id', () => {
  assert.match(code, /planRootCategory/);
  assert.match(code, /LINOLEUM_ROOT_CATEGORY/);
  assert.match(code, /from\('categories'\)/);
  assert.match(code, /from\('product_categories'\)/);
  assert.match(code, /category_id/);
});

test('CLI: restock-хук — РЕУСПРОИЗВОДСТВО notifyRestockRequests из шпалерного CLI (импорт, не копия)', () => {
  assert.match(
    code,
    /import\s*\{[^}]*notifyRestockRequests[^}]*\}\s*from\s*'\.\/wallpaper-import\.ts'/,
    'notifyRestockRequests импортируется из scripts/wallpaper-import.ts'
  );
  // Хук вызывается ровно один раз и только после applyPlan (ветка run).
  const callIdx = code.indexOf('await notifyRestockRequests(');
  const applyIdx = code.indexOf('await applyPlan(');
  assert.ok(callIdx !== -1, 'restock hook must be invoked');
  assert.ok(applyIdx !== -1 && callIdx > applyIdx, 'restock hook идёт после applyPlan');
  assert.equal((code.match(/await notifyRestockRequests\(/g) ?? []).length, 1);
});

test('CLI: service-role клиент, .env.local loader, persistSession: false', () => {
  assert.match(code, /\.env\.local/);
  assert.match(code, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(code, /persistSession: false/);
});

test('CLI: creates несут currency UAH (как весь каталог)', () => {
  assert.equal((code.match(/currency: 'UAH'/g) ?? []).length, 1);
});

test('CLI: инварианты пагинации — мультистраничные чтения order by id, окна только PAGE_SIZE', () => {
  assert.ok(
    (code.match(/\.order\('id'\)/g) ?? []).length >= 3,
    'staging + existing products + categories reads each need a stable tiebreaker'
  );
  assert.doesNotMatch(code, /range\(from, from \+ \d/, 'no literal windows above PAGE_SIZE');
  assert.doesNotMatch(code, /PAGE_SIZE \* \d/, 'windows must be PAGE_SIZE-wide, not multiples');
});

// ---------------------------------------------------------------------------
// prepareRows — staging dedup (freshest export_date per (code,width)) + coercion
// ---------------------------------------------------------------------------

interface RawRowFixture {
  code: string;
  name: string;
  width_m: unknown;
  price_sqm: unknown;
  qty_m: unknown;
  export_date: string;
}

const raw = (over: Partial<RawRowFixture> = {}): RawRowFixture => ({
  code: '1234',
  name: 'Лінолеум Форум',
  width_m: 2,
  price_sqm: 350,
  qty_m: 3,
  export_date: '2026-09-17',
  ...over,
});

test('prepareRows: свежайший export_date выигрывает на (code,width)', () => {
  const { rows, skipped } = prepareRows([
    raw({ code: '1234', price_sqm: 300, export_date: '2026-09-16' }),
    raw({ code: '1234', price_sqm: 350, export_date: '2026-09-17' }),
  ]);
  assert.equal(skipped, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.code, '1234');
  assert.equal(rows[0]?.priceSqm, 350);
});

test('prepareRows: один код, разные ширины — ОБЕ строки живы (дедуп по паре, не по коду)', () => {
  const { rows } = prepareRows([
    raw({ code: '1234', width_m: 2, price_sqm: 350 }),
    raw({ code: '1234', width_m: 3, price_sqm: 410 }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.widthM).sort(),
    [2, 3]
  );
});

test('prepareRows: выгрузка = только свежайший export_date — ключи лишь из старых выгрузок выбрасываются (→ OOS)', () => {
  const result = prepareRows([
    raw({ code: '1111', qty_m: 3, export_date: '2026-09-17' }), // ghost
    raw({ code: '2222', export_date: '2026-09-18' }),
    raw({ code: '3333', qty_m: 9, width_m: 4, export_date: '2026-09-16' }), // ghost
    raw({ code: '4444', export_date: '2026-09-18' }),
  ]);
  assert.equal(result.latestExportDate, '2026-09-18');
  assert.deepEqual(
    result.rows.map((r) => r.code).sort(),
    ['2222', '4444']
  );
  assert.equal(result.olderOnlyKeys, 2);
});

test('prepareRows: код жив в старой И свежей выгрузке — остаётся (не older-only)', () => {
  const result = prepareRows([
    raw({ code: '1234', qty_m: 5, export_date: '2026-09-17' }),
    raw({ code: '1234', qty_m: 7, export_date: '2026-09-18' }),
  ]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.qtyM, 7);
  assert.equal(result.olderOnlyKeys, 0);
});

test('prepareRows: пустой staging → пустой фід, latestExportDate null', () => {
  const result = prepareRows([]);
  assert.deepEqual(result.rows, []);
  assert.equal(result.latestExportDate, null);
  assert.equal(result.olderOnlyKeys, 0);
});

test('prepareRows: tie по export_date → побеждает более поздняя строка ввода (append-only staging)', () => {
  const { rows } = prepareRows([
    raw({ code: '1234', price_sqm: 300 }),
    raw({ code: '1234', price_sqm: 350 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.priceSqm, 350);
});

test('prepareRows: порядок вывода = первое появление ключа (code,width)', () => {
  const { rows } = prepareRows([
    raw({ code: 'B', width_m: 3 }),
    raw({ code: 'A', width_m: 2 }),
    raw({ code: 'B', width_m: 3, price_sqm: 999 }),
    raw({ code: 'C', width_m: 2.5 }),
  ]);
  assert.deepEqual(
    rows.map((r) => `${r.code}/${r.widthM}`),
    ['B/3', 'A/2', 'C/2.5']
  );
  assert.equal(rows[0]?.priceSqm, 999);
});

test('prepareRows: защитная коэрция — числовые строки принимаются (NUMERIC приходит строкой?)', () => {
  const { rows, skipped } = prepareRows([
    raw({ code: '1234', width_m: '2.5', price_sqm: '350.50', qty_m: '12' }),
  ]);
  assert.equal(skipped, 0);
  assert.equal(rows[0]?.widthM, 2.5);
  assert.equal(rows[0]?.priceSqm, 350.5);
  assert.equal(rows[0]?.qtyM, 12);
});

test('prepareRows: некорректные строки пропускаются (в счёт skipped): ширина вне whitelist и др.', () => {
  const { rows, skipped } = prepareRows([
    raw({ code: '   ' }),
    raw({ name: '' }),
    raw({ export_date: '' }),
    raw({ width_m: 1.7 }), // вне LINOLEUM_WIDTHS_M — мусор экспорта
    raw({ width_m: 'abc' }),
    raw({ price_sqm: -1 }),
    raw({ qty_m: 2.5 }), // сток — ЦЕЛЫЕ метры
    raw({ qty_m: -3 }),
    raw({ code: 'OK', width_m: 2, price_sqm: 350, qty_m: 1 }),
  ]);
  assert.equal(skipped, 8);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.code, 'OK');
});

// ---------------------------------------------------------------------------
// chunkRows + parseArgs
// ---------------------------------------------------------------------------

test('chunkRows: точные окна ≤ size, пустой вход, вход не мутируется', () => {
  assert.deepEqual(chunkRows([], 3), []);
  assert.deepEqual(chunkRows([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const input = [1, 2, 3];
  const out = chunkRows(input, 10);
  assert.deepEqual(out, [[1, 2, 3]]);
  assert.notEqual(out[0], input);
  assert.deepEqual(input, [1, 2, 3]);
  assert.equal(BATCH_SIZE, 200);
  assert.equal(PAGE_SIZE, 1000);
});

test('parseArgs: три режима по одному флагу, смешивание/пусто → null (usage)', () => {
  assert.deepEqual(parseArgs(['--plan']), { mode: 'plan' });
  assert.deepEqual(parseArgs(['--run']), { mode: 'run' });
  assert.deepEqual(parseArgs(['--publish']), { mode: 'publish' });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['--plan', '--run']), null);
  assert.equal(parseArgs(['--run', '--publish']), null);
  assert.equal(parseArgs(['--plan', '--publish']), null);
  assert.equal(parseArgs(['--plan', '--category-map', 'm.json']), null, 'опций нет (категории — только корень)');
});

// ---------------------------------------------------------------------------
// payload builders — insert shapes pinned
// ---------------------------------------------------------------------------

const planRow = (over: Partial<LinoleumPlanRow> = {}): LinoleumPlanRow => ({
  sku: 'ln-xl-100-w25',
  slug: 'ln-xl-100-w25',
  name: 'Лінолеум Форум 2,5 м',
  price: 876.25,
  stockQuantity: 40,
  availability: 'in_stock',
  isActive: false,
  specifications: [
    { name: 'Ціна за м²', value: '350,50' },
    { name: 'Ширина', value: '2,5' },
  ],
  ...over,
});

test('productInsertRow: консистентный INSERT (is_active false, UAH, availability, specifications, category_id)', () => {
  const payload = productInsertRow(
    planRow({ availability: 'out_of_stock', stockQuantity: 0 }),
    'cat-uuid'
  );
  assert.deepEqual(payload, {
    sku: 'ln-xl-100-w25',
    slug: 'ln-xl-100-w25',
    name: 'Лінолеум Форум 2,5 м',
    price: 876.25,
    stock_quantity: 0,
    availability_status: 'out_of_stock',
    currency: 'UAH',
    is_active: false,
    specifications: [
      { name: 'Ціна за м²', value: '350,50' },
      { name: 'Ширина', value: '2,5' },
    ],
    category_id: 'cat-uuid',
  });
});

test('productInsertRow: category_id может быть null (defensive) — никогда голый undefined', () => {
  const payload = productInsertRow(planRow(), null);
  assert.equal(payload.category_id, null);
});

test('stockHistoryRow: reason 1c-sync, source 1c-linoleum, old→new quantities', () => {
  assert.deepEqual(stockHistoryRow('p-uuid', 5, 0), {
    product_id: 'p-uuid',
    old_quantity: 5,
    new_quantity: 0,
    reason: '1c-sync',
    source: '1c-linoleum',
  });
});

// ---------------------------------------------------------------------------
// publishLinoleum — runtime photo-gate over a fake in-memory client (NO real DB)
// ---------------------------------------------------------------------------

interface FakeProductRow {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock_quantity: number;
  is_active: boolean;
}

interface FakeDbState {
  products: FakeProductRow[];
  /** product_ids, владеющие ≥1 строкой product_images. */
  photoOwners: string[];
}

interface RecordedUpdate {
  table: string;
  payload: Record<string, unknown>;
  ids: string[];
}

function makeFakeDb(state: FakeDbState): { client: SupabaseClient; updates: RecordedUpdate[] } {
  const updates: RecordedUpdate[] = [];
  const client = {
    from(table: string) {
      let updating = false;
      let payload: Record<string, unknown> = {};
      let inIds: string[] = [];
      let win: [number, number] = [0, 0];
      const b = {
        select() {
          return b;
        },
        update(p: Record<string, unknown>) {
          updating = true;
          payload = p;
          return b;
        },
        is() {
          return b;
        },
        like() {
          return b;
        },
        in(col: string, ids: readonly string[]) {
          if (updating || col === 'product_id' || col === 'id') inIds = [...ids];
          return b;
        },
        order() {
          return b;
        },
        range(from: number, to: number) {
          win = [from, to];
          return b;
        },
        returns<T>(): PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
          if (updating) {
            updates.push({ table, payload, ids: inIds });
            const touched = state.products.filter((p) => inIds.includes(p.id));
            for (const p of touched) Object.assign(p, payload); // эмуляция БД
            return Promise.resolve({ data: touched.map((p) => ({ id: p.id })) as T[], error: null });
          }
          if (table === 'products') {
            const page = state.products.slice(win[0], win[1] + 1);
            return Promise.resolve({ data: page as T[], error: null });
          }
          if (table === 'product_images') {
            const owners = state.photoOwners
              .filter((pid) => inIds.includes(pid))
              .slice(win[0], win[1] + 1)
              .map((product_id) => ({ product_id }));
            return Promise.resolve({ data: owners as T[], error: null });
          }
          return Promise.resolve({ data: null, error: { message: `unexpected table ${table}` } });
        },
      };
      return b;
    },
  };
  return { client: client as unknown as SupabaseClient, updates };
}

const lnProduct = (id: string, isActive: boolean): FakeProductRow => ({
  id,
  sku: `ln-x${id}`,
  name: `Лінолеум ${id}`,
  price: 700,
  stock_quantity: 3,
  is_active: isActive,
});

test('publishLinoleum: публикуются только с фото, скрываются без — diff-aware flip', async () => {
  const state: FakeDbState = {
    products: [
      lnProduct('a-no-photo-off', false), // нетронута (уже скрыта)
      lnProduct('b-photo-off', false), // → опубликована
      lnProduct('c-photo-on', true), // нетронута (уже активна)
      lnProduct('d-no-photo-on', true), // → скрыта
    ],
    photoOwners: ['b-photo-off', 'c-photo-on'],
  };
  const { client, updates } = makeFakeDb(state);

  const totals = await publishLinoleum(client);

  assert.deepEqual(totals, { published: 1, hidden: 1, withPhotos: 2, total: 4 });
  assert.equal(updates.length, 2);
  const enable = updates.find((u) => u.payload['is_active'] === true);
  const hide = updates.find((u) => u.payload['is_active'] === false);
  assert.deepEqual(enable?.ids, ['b-photo-off']);
  assert.deepEqual(hide?.ids, ['d-no-photo-on']);
  assert.equal(state.products.find((p) => p.id === 'b-photo-off')?.is_active, true);
  assert.equal(state.products.find((p) => p.id === 'd-no-photo-on')?.is_active, false);
  assert.equal(state.products.find((p) => p.id === 'a-no-photo-off')?.is_active, false);
  assert.equal(state.products.find((p) => p.id === 'c-photo-on')?.is_active, true);
});

test('publishLinoleum: идемпотентен — повтор над применённым состоянием пишет НОЛЬ UPDATE', async () => {
  const state: FakeDbState = {
    products: [lnProduct('p1', false), lnProduct('p2', true), lnProduct('p3', false)],
    photoOwners: ['p1', 'p2'],
  };
  const db = makeFakeDb(state);
  assert.deepEqual(await publishLinoleum(db.client), {
    published: 1,
    hidden: 0,
    withPhotos: 2,
    total: 3,
  });
  const second = makeFakeDb(state);
  assert.deepEqual(await publishLinoleum(second.client), {
    published: 0,
    hidden: 0,
    withPhotos: 2,
    total: 3,
  });
  assert.equal(second.updates.length, 0, 'нечего флипать → ноль UPDATE');
});

test('publishLinoleum: батчи ≤200 id на UPDATE (проектный инвариант записи)', async () => {
  const state: FakeDbState = {
    products: [
      ...Array.from({ length: 250 }, (_, i) => lnProduct(`on-${i}`, false)),
      ...Array.from({ length: 45 }, (_, i) => lnProduct(`off-${i}`, true)),
    ],
    photoOwners: Array.from({ length: 250 }, (_, i) => `on-${i}`),
  };
  const { client, updates } = makeFakeDb(state);
  const totals = await publishLinoleum(client);
  assert.deepEqual(totals, { published: 250, hidden: 45, withPhotos: 250, total: 295 });
  const enable = updates.filter((u) => u.payload['is_active'] === true);
  const hide = updates.filter((u) => u.payload['is_active'] === false);
  assert.deepEqual(
    enable.map((u) => u.ids.length),
    [200, 50]
  );
  assert.deepEqual(
    hide.map((u) => u.ids.length),
    [45]
  );
});
