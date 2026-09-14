/**
 * Source pins for the /admin/descriptions surface (spec 2026-09-14,
 * Phase 2): guarded API route with the approve/reject contract, the
 * admin page, and the navigation card.
 *
 * node:test cannot execute JSX/TS routes directly — static invariants,
 * mirroring tests/reviews-security.test.ts and admin-guard-invariants
 * (which already covers the requireAdminApi gate for the new route
 * automatically by walking app/api/admin/**).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const ROUTE = 'app/api/admin/descriptions/route.ts';
const PAGE = 'app/admin/(dashboard)/descriptions/page.tsx';
const DASHBOARD = 'app/admin/(dashboard)/page.tsx';

const route = src(ROUTE);
const page = src(PAGE);
const dashboard = src(DASHBOARD);

// ---- API route ----

test('DESC-API: every handler gates on requireAdminApi before any DB access', () => {
  const handlers = route.match(/export\s+async\s+function\s+(GET|PATCH)\s*\([\s\S]*?\n\}/g) ?? [];
  assert.equal(handlers.length, 2, 'expected GET + PATCH handlers');
  for (const h of handlers) {
    const guardPos = h.indexOf('await requireAdminApi()');
    assert.ok(guardPos !== -1, `handler missing requireAdminApi: ${h.slice(0, 80)}`);
    const dbPos = h.search(/serviceClient|ctx\./);
    assert.ok(dbPos === -1 || dbPos > guardPos, 'DB access before the guard');
    assert.match(h, /ctx instanceof NextResponse/, 'guard result must be narrowed');
  }
});

test('DESC-API: GET lists only PENDING drafts, ≤50 per page, joined with products', () => {
  assert.match(route, /\.eq\('status',\s*'pending'\)/);
  // Page size comes from the pinned constant (50, cap ≤50).
  assert.match(route, /PAGE_SIZE\s*=\s*DESCRIPTION_DRAFT_PAGE_SIZE/);
  assert.match(route, /range\(from,\s*from\s*\+\s*PAGE_SIZE\s*-\s*1\)/);
  // join products for name/sku/slug (read-only embed)
  assert.match(
    route,
    /products!product_description_drafts_product_id_fkey\(name,\s*sku,\s*slug\)/
  );
  // deterministic oldest-first queue
  assert.match(route, /\.order\('created_at',\s*\{\s*ascending:\s*true\s*\}\)/);
});

test('DESC-API: approve publishes ONLY through the atomic migration RPC', () => {
  assert.match(
    route,
    /rpc\(\s*'approve_product_description_draft',\s*\{\s*p_draft_id:\s*parsed\.id\s*\}\s*\)/
  );
  // The route itself NEVER writes products — description changes go
  // through the RPC, everything else stays read-only.
  assert.doesNotMatch(route, /\.from\('products'\)\s*\.\s*(update|upsert|insert|delete)/);
  assert.doesNotMatch(route, /description\s*:/, 'no direct products.description writes');
  // After approve the storefront cache drops (catalog pattern).
  assert.match(route, /revalidateTag\('catalog-public-reads',\s*'max'\)/);
  // Re-read happens only AFTER the rpc call.
  const rpcPos = route.search(/rpc\(\s*'approve_product_description_draft'/);
  const readback = route.indexOf(".from('product_description_drafts')\n      .select(LIST_COLUMNS)");
  assert.ok(rpcPos !== -1 && readback > rpcPos, 'readback must follow the approve RPC');
});

test('DESC-API: reject touches ONLY the draft row, products structurally unreachable', () => {
  const rejectBlock =
    route.match(/\/\/ reject:[\s\S]*?return NextResponse\.json\(\{ item: data \}\);/i) ?? [];
  assert.ok(rejectBlock.length > 0, 'reject block not found');
  const block = rejectBlock[0] ?? '';
  assert.match(block, /status:\s*'rejected'/);
  assert.match(block, /reviewed_at:/);
  assert.match(block, /\.eq\('status',\s*'pending'\)/, 'only pending drafts convert');
  assert.doesNotMatch(
    block,
    /\.from\('products'\)|revalidateTag|rpc\(/,
    'reject must not touch products, the storefront cache or the approve RPC'
  );
});

test('DESC-API: invalid payload → 400, already-reviewed draft → 409', () => {
  assert.match(route, /error:\s*'invalid_payload'/);
  assert.match(route, /status:\s*400/);
  assert.match(route, /status:\s*409/);
});

test('DESC-API: page size constant stays ≤50 and body parsing is strict', () => {
  const lib = src('app/lib/description-drafts.ts');
  const size = lib.match(/DESCRIPTION_DRAFT_PAGE_SIZE\s*=\s*(\d+)/);
  assert.ok(size && Number(size[1]) <= 50, `page size must be ≤50, got ${size?.[1]}`);
  assert.match(route, /parseDraftAction/);
});

// ---- Admin page ----

test('DESC-PAGE: offers Затвердити / Відхилити and hits the guarded route', () => {
  assert.ok(page.includes('Затвердити'), 'approve button missing');
  assert.ok(page.includes('Відхилити'), 'reject button missing');
  assert.match(page, /fetch\('\/api\/admin\/descriptions/);
  // Both actions go through ONE PATCH body: { id, action }.
  assert.match(page, /review\(row,\s*'approve'\)/);
  assert.match(page, /review\(row,\s*'reject'\)/);
  assert.match(page, /JSON\.stringify\(\{\s*id:\s*row\.id,\s*action\s*\}\)/);
  // Reviewed cards leave the queue — no stale re-render of a published draft.
  assert.match(page, /filter\(\(r\) => r\.id !== row\.id\)/);
  // No inline editing: the draft text is display-only (generation core owns content).
  assert.doesNotMatch(page, /<textarea/);
});

test('DESC-PAGE: pagination controls respect the ≤50 page contract', () => {
  assert.match(page, /pageCount/);
  assert.match(page, /до 50 на сторінці/);
});

// ---- Navigation ----

test('DESC-NAV: dashboard lists the /admin/descriptions section', () => {
  assert.match(dashboard, /href:\s*'\/admin\/descriptions'/);
  assert.ok(
    dashboard.includes('Чернетки описів товарів'),
    'nav card title missing'
  );
});
