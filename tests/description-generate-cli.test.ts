/**
 * Source pins for scripts/description-generate.ts (spec 2026-09-14,
 * Phase 2). The CLI is I/O around the pure draft layer; these pins hold
 * its safety contract:
 *  - --plan / --run --limit N [--category slug] interface;
 *  - deterministic .order('id') paging in windows ≤200;
 *  - drafts insert with ignoreDuplicates — an existing draft is NEVER
 *    overwritten (ON CONFLICT (product_id) DO NOTHING);
 *  - products are read-only here: the script contains no UPDATE/UPSERT/
 *    DELETE at all (products.description is written ONLY by the approved
 *    branch);
 *  - generated content comes from the shared pure layer, not re-implemented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const CLI = 'scripts/description-generate.ts';
const cli = src(CLI);

test('CLI: exists and offers the --plan / --run interface', () => {
  assert.ok(cli.includes('--plan'), '--plan mode missing');
  assert.ok(cli.includes('--run'), '--run mode missing');
  assert.ok(cli.includes('--limit'), '--limit option missing');
  assert.ok(cli.includes('--category'), '--category option missing');
  // --run without a positive limit must refuse to run.
  assert.match(cli, /limit\s*<=\s*0/);
});

test('CLI: loads .env.local like the other import scripts', () => {
  assert.match(cli, /\.env\.local/);
  assert.match(cli, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(cli, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('CLI: deterministic paging — .order(\'id\') with windows ≤ 200', () => {
  assert.match(cli, /\.order\('id'\)/);
  assert.match(
    cli,
    /range\(from,\s*from\s*\+\s*DESCRIPTION_DRAFT_BATCH_SIZE\s*-\s*1\)/,
    'windows must be bounded by DESCRIPTION_DRAFT_BATCH_SIZE'
  );
  // window constant is pinned by tests/description-drafts-plan.test.ts = 200
  assert.match(cli, /DESCRIPTION_DRAFT_BATCH_SIZE/);
});

test('CLI: --limit is a hard cap on NEW drafts written (window is trimmed to the remaining quota)', () => {
  assert.match(
    cli,
    /const\s+remaining\s*=\s*limit\s*-\s*written[\s\S]*?batch\.slice\(0,\s*remaining\)/,
    'a window holding more targets than --limit must be trimmed'
  );
  // The loop itself stops as soon as the quota is reached.
  assert.match(cli, /for\s*\(let\s+from\s*=\s*0;\s*written\s*<\s*limit;/);
});

test('CLI: drafts write is ON CONFLICT (product_id) DO NOTHING — existing drafts never overwritten', () => {
  // supabase-js 2.112: DO NOTHING = upsert + ignoreDuplicates (no builder
  // method anymore). A conflicting row is NOT merged and NOT returned.
  const writes = cli.match(/\.upsert\([\s\S]*?\)\s*\.select\('product_id'\)/g) ?? [];
  assert.equal(writes.length, 1, 'expected exactly one write statement');
  assert.match(
    writes[0] ?? '',
    /onConflict:\s*'product_id'/,
    'conflict target must be product_id (the UNIQUE draft key)'
  );
  assert.match(writes[0] ?? '', /ignoreDuplicates:\s*true/);
});

test('CLI: products are READ-ONLY — no update/delete; the only upsert targets drafts', () => {
  assert.doesNotMatch(cli, /\.update\(/, 'the CLI must never update rows');
  assert.doesNotMatch(cli, /\.delete\(/, 'the CLI must never delete rows');
  // The only table written by name is the staging table:
  assert.match(cli, /from\('products'\)/);
  assert.match(cli, /from\('product_description_drafts'\)/);
});

test('CLI: reuses the pure draft layer (no duplicated generation logic)', () => {
  assert.match(cli, /from\s+'\.\.\/app\/lib\/description-drafts\.ts'/);
  for (const fn of ['isDraftTarget', 'buildDraftContent', 'DRAFT_SOURCE']) {
    assert.match(cli, new RegExp(fn));
  }
  // Must not re-implement phrasing: no direct Phase-1 imports in the CLI.
  assert.doesNotMatch(cli, /description-generator/);
  // The one products writer of the feature is the migration RPC, not the CLI.
  assert.doesNotMatch(cli, /approve_product_description_draft/);
});

test('CLI: reads brand/category via the same FK embeds the PDP uses', () => {
  assert.match(cli, /brands!products_brand_id_fkey/);
  assert.match(cli, /categories!products_category_id_fkey/);
  // Category filter is a structural filter on the default assignment.
  assert.match(cli, /\.eq\('is_active',\s*true\)/);
  assert.match(cli, /\.eq\('category_id',\s*categoryId\)/);
});
