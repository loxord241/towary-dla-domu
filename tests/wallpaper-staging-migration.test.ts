/**
 * Migration 041 (wallpaper staging) — static invariants.
 *
 * `wallpaper_stock` is the landing table for the daily 1C 7.7 stock export
 * (CSV -> ingest endpoint -> staging -> importer). It must be a
 * service-role-only staging table, modeled after `yc_content_goods`
 * (migration 011): RLS enabled, NO policies — anon/authenticated are denied.
 * Unlike the Yugcontract content staging there is deliberately NO uniqueness
 * beyond the PK: every daily export APPENDS its rows, and the importer reads
 * the freshest row per code (DISTINCT ON (code) ... ORDER BY export_date
 * DESC). These tests pin the migration content so the staging contract
 * cannot silently regress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const stripComments = (sql: string): string => sql.replace(/^\s*--.*$/gm, '');

const MIGRATION = 'database/migrations/041_wallpaper_stock_staging.sql';

test('WALLPAPER-STAGING: migration file exists', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('041_wallpaper_stock_staging.sql'),
    `expected ${MIGRATION}; found: ${files.filter((f) => f.startsWith('04')).join(', ')}`
  );
});

test('WALLPAPER-STAGING: creates wallpaper_stock with the staged-export column set', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /create\s+table\s+if\s+not\s+exists\s+(public\.)?wallpaper_stock/i,
    'missing CREATE TABLE IF NOT EXISTS wallpaper_stock'
  );
  // id uuid pk default gen_random_uuid()
  assert.match(
    body,
    /\bid\s+uuid\s+default\s+gen_random_uuid\(\)\s+primary\s+key/i,
    'id must be uuid primary key defaulting to gen_random_uuid()'
  );
  assert.match(body, /export_date\s+date\s+not\s+null/i, 'export_date date not null');
  assert.match(body, /\bcode\s+text\s+not\s+null/i, 'code text not null');
  assert.match(body, /\bname\s+text\s+not\s+null/i, 'name text not null');
  assert.match(
    body,
    /price_retail\s+numeric\s+not\s+null\s+check\s*\(\s*price_retail\s*>=\s*0\s*\)/i,
    'price_retail numeric not null CHECK (price_retail >= 0)'
  );
  assert.match(
    body,
    /\bqty\s+numeric\s+not\s+null\s+check\s*\(\s*qty\s*>=\s*0\s*\)/i,
    'qty numeric not null CHECK (qty >= 0)'
  );
  assert.match(
    body,
    /created_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i,
    'created_at timestamptz default now()'
  );
});

test('WALLPAPER-STAGING: append-only staging — no uniqueness beyond the PK', () => {
  const body = stripComments(src(MIGRATION));
  // The PK is declared with the PRIMARY KEY keyword; any UNIQUE (…) elsewhere
  // (code, export_date, (code, export_date), …) would break the append-per-
  // export contract — repeated exports of the same code are expected.
  assert.doesNotMatch(
    body,
    /\bunique\s*\(/i,
    'staging must stay append-only: no UNIQUE constraints beyond the implicit PK'
  );
});

test('WALLPAPER-STAGING: RLS enabled, no policies (service-role only)', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /alter\s+table\s+(public\.)?wallpaper_stock\s+enable\s+row\s+level\s+security/i,
    'missing ENABLE ROW LEVEL SECURITY on wallpaper_stock'
  );
  assert.doesNotMatch(
    body,
    /create\s+policy/i,
    'no policies may exist: RLS-with-no-policy denies anon/authenticated outright'
  );
  // Belt-and-suspenders on top of RLS: Supabase default privileges grant
  // SELECT on new tables to public; explicit revoke makes the orchestrator's
  // post-check deterministic (anon SELECT -> permission denied, not 0 rows).
  assert.match(
    body,
    /revoke\s+select\s+on\s+(table\s+)?(public\.)?wallpaper_stock\s+from\s+anon,\s*authenticated/i,
    'SELECT must be revoked from anon, authenticated'
  );
});

test('WALLPAPER-STAGING: index on export_date for freshness checks', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /create\s+index\s+if\s+not\s+exists\s+idx_wallpaper_stock_export_date/i,
    'missing named index for export_date'
  );
  assert.match(
    body,
    /on\s+(public\.)?wallpaper_stock\s*\(\s*export_date\s*\)/i,
    'index must be on wallpaper_stock(export_date)'
  );
});

test('WALLPAPER-STAGING: DDL-only migration — no data writes, no drops', () => {
  const body = stripComments(src(MIGRATION));
  assert.doesNotMatch(
    body,
    /insert\s+into|update\s+\w+\s+set|delete\s+from/i,
    'migration must not write or remove data'
  );
  assert.doesNotMatch(
    body,
    /drop\s+(table|column|index)|alter\s+table\s+.*\s+drop\s+column|truncate\b/i,
    'additive migration must not drop or truncate anything'
  );
});

test('WALLPAPER-STAGING: carries VERIFY-PRE/POST instructions for the orchestrator', () => {
  const m = src(MIGRATION); // full text: VERIFY blocks live in comments
  assert.match(m, /VERIFY-PRE/, 'missing VERIFY-PRE block');
  assert.match(m, /VERIFY-POST/, 'missing VERIFY-POST block');
  assert.match(m, /wallpaper_stock/, 'VERIFY block must reference the table');
});
