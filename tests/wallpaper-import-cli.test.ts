/**
 * Wallpapers import CLI executor (plan Task 7, scripts/wallpaper-import.ts).
 *
 * Contract under test (static — DB is NEVER touched by these tests):
 *   - staging is read PAGED (windows of PAGE_SIZE = 1000, `.order('id')`,
 *     fresh builder per page) from `wallpaper_stock` (migration 041); the
 *     fresh-row-per-code Distinct handling happens IN JS (prepareRows), not
 *     in SQL — staging has no uniqueness beyond PK;
 *   - existing products read: `yugcontract_id IS NULL AND sku LIKE 'wc-%'`;
 *   - all sync writes happen ONLY inside applyPlan, which is invoked ONLY in
 *     the `--run` branch — `--plan` prints and returns 0 with zero writes;
 *     the `--publish` action (Task 9) is standalone and writes ONLY the two
 *     batched is_active flips inside publishWallpapers
 *     (see tests/wallpaper-publish.test.ts);
 *   - every write batch is ≤ BATCH_SIZE = 200 rows (products inserts,
 *     product_categories junction, products updates, missing-OOS updates,
 *     product_stock_history);
 *   - every stock change (plan updates with stock_quantity + missing OOS)
 *     inserts product_stock_history with reason '1c-sync',
 *     source '1c-wallpaper';
 *   - NO DELETE, NO rpc, NO upsert; the regular sync (--plan/--run) NEVER
 *     UPDATEs is_active — it only inserts new rows invisible
 *     (`is_active: false`); the storefront flag belongs exclusively to the
 *     --publish gate (availability_status is set only on INSERT — the
 *     migration 040 trigger owns it on UPDATE);
 *   - categories for creates: optional `--category-map <file>` JSON
 *     {code: categorySlug}, resolved through product_categories (+ the legacy
 *     products.category_id default column); unknown codes → WALLPAPER_ROOT
 *     (slug 'shpaleri'); missing DB categories are created via the
 *     planCategoryUpsert-compatible path (Task 4 module reused).
 *
 * Runtime tests cover the exported pure helpers (prepareRows dedup, chunk
 * windows, category-map parsing, insert payload builders, sku→code map).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WallpaperRow } from '../app/lib/wallpapers/parse.ts';
import type { WallpaperPlanRow } from '../app/lib/wallpapers/import-plan.ts';
import {
  BATCH_SIZE,
  HISTORY_REASON,
  HISTORY_SOURCE,
  PAGE_SIZE,
  chunkRows,
  deriveCodeBySku,
  parseCategoryMap,
  prepareRows,
  productInsertRow,
  stockHistoryRow,
} from '../scripts/wallpaper-import.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'scripts/wallpaper-import.ts';
const src = readFileSync(path.join(root, SCRIPT), 'utf8');

// ---------------------------------------------------------------------------
// Static structure invariants (raw source, comments stripped)
// ---------------------------------------------------------------------------

const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('CLI: --plan/--run/--publish are the three modes, mutually exclusive (--publish = Task 9 gate)', () => {
  assert.match(code, /--plan/);
  assert.match(code, /--run/);
  assert.match(code, /--publish/);
  assert.match(code, /USAGE/);
});

test('CLI: staging read paged ≤1000 with .order(id); fresh-row-per-code dedup in JS (prepareRows)', () => {
  assert.match(code, /PAGE_SIZE = 1000/);
  assert.match(code, /\.from\('wallpaper_stock'\)/);
  assert.match(code, /\.order\('id'\)/);
  assert.match(code, /\.range\(from, from \+ PAGE_SIZE - 1\)/);
  assert.match(code, /export function prepareRows/);
  // Distinct handling lives in JS over the paged read — no SQL-side dedup.
  assert.doesNotMatch(code, /\.distinct\(/);
});

test('CLI: existing read is the wc-* domain only (yugcontract_id IS NULL AND sku LIKE wc-%)', () => {
  assert.match(code, /\.is\('yugcontract_id', null\)/);
  assert.match(code, /\.like\('sku', 'wc-%'\)/);
});

test('CLI: every write batch is ≤200 (creates, junction, updates, missing, history)', () => {
  assert.match(code, /BATCH_SIZE = 200/);
  // creates, product_categories junction, updates, missing-OOS groups
  assert.ok(
    (code.match(/chunkRows\(/g) ?? []).length >= 4,
    'chunkRows must gate every batched write'
  );
  assert.match(code, /\.select\('id,sku'\)/, 'product inserts collect ids');
});

test('CLI: stock changes insert product_stock_history with reason 1c-sync, source 1c-wallpaper', () => {
  assert.match(code, /from\('product_stock_history'\)/);
  assert.equal(HISTORY_REASON, '1c-sync');
  assert.equal(HISTORY_SOURCE, '1c-wallpaper');
  assert.match(code, /reason: HISTORY_REASON/);
  assert.match(code, /source: HISTORY_SOURCE/);
});

test('CLI: NO delete / rpc / upsert — only insert+update, plan is the idempotency story', () => {
  assert.doesNotMatch(code, /\.delete\(/);
  assert.doesNotMatch(code, /\.rpc\(/);
  assert.doesNotMatch(code, /\.upsert\(/);
});

test('CLI: the sync (--plan/--run) never UPDATEs is_active — the storefront belongs to --publish', () => {
  // Scope: everything the sync modes can execute is defined BEFORE the
  // publish executor (publishWallpapers, pinned in
  // tests/wallpaper-publish.test.ts). Within that scope the ONLY is_active
  // occurrence is the INSERT payload that lands new rows invisible.
  const publishIdx = code.indexOf('async function publishWallpapers');
  assert.ok(publishIdx !== -1, 'publish executor must exist (Task 9)');
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

test('CLI: --plan cannot write — applyPlan (the only sync writer) is called exactly once, in the run branch', () => {
  const planIdx = code.indexOf("args.mode === 'plan'");
  const callIdx = code.indexOf('await applyPlan(');
  assert.ok(planIdx !== -1, 'plan branch must exist');
  assert.ok(callIdx !== -1, 'applyPlan must be invoked');
  assert.ok(callIdx > planIdx, 'applyPlan call must follow the plan branch');
  assert.equal((code.match(/await applyPlan\(/g) ?? []).length, 1);
  // All sync writes are defined inside applyPlan, below the call site — the
  // plan branch textually cannot reach them (publish writes live in
  // publishWallpapers and are gated by their own tests).
  assert.ok(code.indexOf('.insert(') > callIdx);
  assert.ok(code.indexOf('.update(') > callIdx);
  const planBranch = code.slice(planIdx, callIdx);
  assert.doesNotMatch(planBranch, /\.insert\(|\.update\(|\.delete\(/);
});

test('CLI: category-map option — JSON {code: slug}, parsed+validated, junction + root fallback', () => {
  assert.match(code, /--category-map/);
  assert.match(code, /export function parseCategoryMap/);
  assert.match(code, /JSON\.parse/);
  assert.match(code, /planWallpaperImport/);
  assert.match(code, /planCategoryUpsert/, 'missing categories are created via the Task 4 planner');
  assert.match(code, /from\('product_categories'\)/);
  assert.match(code, /WALLPAPER_ROOT/, 'root category (shpaleri) is the fallback');
});

test('CLI: service-role client, .env.local loader, reconciliation-scan client pattern', () => {
  assert.match(code, /\.env\.local/);
  assert.match(code, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(code, /persistSession: false/);
});

test('CLI: creates carry currency UAH like the rest of the catalog (Yugcontract importer value)', () => {
  assert.equal((code.match(/currency: 'UAH'/g) ?? []).length, 1);
});

test('CLI: pagination invariants — multi-page reads order by id, windows from PAGE_SIZE only', () => {
  assert.ok(
    (code.match(/\.order\('id'\)/g) ?? []).length >= 3,
    'staging + existing products + categories reads each need a stable tiebreaker'
  );
  assert.doesNotMatch(code, /range\(from, from \+ \d/, 'no literal windows above PAGE_SIZE');
  assert.doesNotMatch(code, /PAGE_SIZE \* \d/, 'windows must be PAGE_SIZE-wide, not multiples');
});

// ---------------------------------------------------------------------------
// prepareRows — staging dedup (freshest export_date per code) + coercion
// ---------------------------------------------------------------------------

interface RawRowFixture {
  code: string;
  name: string;
  price_retail: unknown;
  qty: unknown;
  export_date: string;
}

const raw = (over: Partial<RawRowFixture> = {}): RawRowFixture => ({
  code: '1234',
  name: 'шпалери 53см*10м',
  price_retail: 100,
  qty: 3,
  export_date: '2026-09-10',
  ...over,
});

test('prepareRows: freshest export_date wins per code', () => {
  const { rows, skipped } = prepareRows([
    raw({ code: '1234', price_retail: 50, export_date: '2026-09-09' }),
    raw({ code: '1234', price_retail: 60, export_date: '2026-09-10' }),
  ]);
  assert.equal(skipped, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.code, '1234');
  assert.equal(rows[0]?.priceRetail, 60);
});

test('prepareRows: export_date tie → later input row wins (append-only staging)', () => {
  const { rows } = prepareRows([
    raw({ code: '1234', price_retail: 50 }),
    raw({ code: '1234', price_retail: 70 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.priceRetail, 70);
});

test('prepareRows: output follows first-appearance order of each code', () => {
  const { rows } = prepareRows([
    raw({ code: '2222' }),
    raw({ code: '1111' }),
    raw({ code: '2222', price_retail: 111, export_date: '2026-09-11' }),
    raw({ code: '3333' }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.code),
    ['2222', '1111', '3333']
  );
  assert.equal(rows[0]?.priceRetail, 111);
});

test('prepareRows: defensive coercion — numeric strings accepted, price rounded to 2dp', () => {
  const { rows, skipped } = prepareRows([
    raw({ code: '1234', price_retail: '53.555', qty: '12' }),
  ]);
  assert.equal(skipped, 0);
  assert.equal(rows[0]?.priceRetail, 53.56);
  assert.equal(rows[0]?.qty, 12);
});

test('prepareRows: staging (migration 041) has no article column → article null, rollSize from name', () => {
  const { rows } = prepareRows([raw({ name: 'шпалери 6647-04, 53см*10м' })]);
  assert.equal(rows[0]?.article, null);
  assert.deepEqual(rows[0]?.rollSize, { widthCm: 53, lengthM: 10 });
});

test('prepareRows: invalid rows are skipped (counted), valid ones kept', () => {
  const { rows, skipped } = prepareRows([
    raw({ code: '   ' }),
    raw({ name: '' }),
    raw({ export_date: '' }),
    raw({ price_retail: 'abc' }),
    raw({ price_retail: -1 }),
    raw({ qty: 2.5 }),
    raw({ qty: -3 }),
    raw({ code: '1234', price_retail: 10, qty: 1 }),
  ]);
  assert.equal(skipped, 7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.code, '1234');
});

// ---------------------------------------------------------------------------
// chunkRows — batch windows
// ---------------------------------------------------------------------------

test('chunkRows: exact windows ≤ size, empty input, no input mutation', () => {
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

// ---------------------------------------------------------------------------
// parseCategoryMap — --category-map file contract
// ---------------------------------------------------------------------------

test('parseCategoryMap: valid JSON {code: slug} → Map with trimmed pairs', () => {
  const map = parseCategoryMap('{"1234": "shpaleri-akryl", " 5678 ":"shpaleri-vinyl-10m"}');
  assert.equal(map.size, 2);
  assert.equal(map.get('1234'), 'shpaleri-akryl');
  assert.equal(map.get('5678'), 'shpaleri-vinyl-10m');
});

test('parseCategoryMap: rejects non-object JSON, bad pairs, broken JSON', () => {
  assert.throws(() => parseCategoryMap('[]'), /JSON/);
  assert.throws(() => parseCategoryMap('"x"'), /JSON/);
  assert.throws(() => parseCategoryMap('{'), /JSON/);
  assert.throws(() => parseCategoryMap('{"1234": 5}'), /shpaleri|slug|строк/i);
  assert.throws(() => parseCategoryMap('{"1234": ""}'), /slug|строк/i);
  assert.throws(() => parseCategoryMap('{"": "shpaleri-akryl"}'), /код/i);
});

// ---------------------------------------------------------------------------
// deriveCodeBySku — create.sku → 1С code, via the planner itself
// ---------------------------------------------------------------------------

const row = (over: Partial<WallpaperRow>): WallpaperRow => ({
  code: '1234',
  name: 'шпалери',
  article: null,
  rollSize: null,
  priceRetail: 100,
  qty: 1,
  ...over,
});

test('deriveCodeBySku: code-derived (wc-x<code>) and article-derived (wc-<article>) skus map to codes', () => {
  const map = deriveCodeBySku([
    row({ code: '1234' }),
    row({ code: '9999', name: 'SP 531-34 какао', article: 'SP 531-34' }),
  ]);
  assert.equal(map.get('wc-x1234'), '1234');
  assert.equal(map.get('wc-sp531-34'), '9999');
});

// ---------------------------------------------------------------------------
// payload builders — insert shapes pinned
// ---------------------------------------------------------------------------

const planRow = (over: Partial<WallpaperPlanRow> = {}): WallpaperPlanRow => ({
  sku: 'wc-x1234',
  slug: 'wc-x1234',
  name: 'шпалери 1234',
  price: 100,
  stockQuantity: 3,
  availability: 'in_stock',
  isActive: false,
  ...over,
});

test('productInsertRow: consistent INSERT (is_active false, UAH, availability, legacy category_id)', () => {
  const payload = productInsertRow(planRow({ availability: 'out_of_stock', stockQuantity: 0 }), 'cat-uuid');
  assert.deepEqual(payload, {
    sku: 'wc-x1234',
    slug: 'wc-x1234',
    name: 'шпалери 1234',
    price: 100,
    stock_quantity: 0,
    availability_status: 'out_of_stock',
    currency: 'UAH',
    is_active: false,
    category_id: 'cat-uuid',
  });
});

test('productInsertRow: category_id may be null (defensive) — never a bare undefined', () => {
  const payload = productInsertRow(planRow(), null);
  assert.equal(payload.category_id, null);
});

test('stockHistoryRow: reason 1c-sync, source 1c-wallpaper, old→new quantities', () => {
  assert.deepEqual(stockHistoryRow('p-uuid', 5, 0), {
    product_id: 'p-uuid',
    old_quantity: 5,
    new_quantity: 0,
    reason: '1c-sync',
    source: '1c-wallpaper',
  });
});
