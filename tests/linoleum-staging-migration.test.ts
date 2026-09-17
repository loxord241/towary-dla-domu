/**
 * Migration 052 (linoleum staging) — static invariants.
 *
 * `linoleum_stock` is the landing table for the daily 1C linoleum stock
 * export (CSV -> ingest endpoint -> staging -> importer, vertical batch 1;
 * owner plan 2026-09-17). It MIRRORS `wallpaper_stock` (migration 041):
 * RLS enabled, NO policies — anon/authenticated are denied; explicit
 * SELECT revoke on top (Supabase default privileges grant SELECT to
 * public — the 014/039 footgun) plus INSERT/UPDATE/DELETE revokes in the
 * 033 style; append-only staging with no uniqueness beyond the PK.
 * Column canon = the ingest endpoint's insert payload
 * (/api/ingest/1c-linoleum; a staging row = design×width from the daily
 * CSV export): code/name identity, width_m with the parser-whitelist
 * CHECK (DB-level defense in depth), price_sqm as NUMERIC(12,2) (грн/м²),
 * qty_m as INTEGER — linoleum stock is counted in WHOLE linear meters
 * (owner decision 2026-09-17). These tests pin the migration content so
 * the staging contract cannot silently regress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const stripComments = (sql: string): string => sql.replace(/^\s*--.*$/gm, '');

const MIGRATION = 'database/migrations/052_linoleum_stock_staging.sql';

test('LINOLEUM-STAGING: migration file exists (next number after 051)', () => {
  const files = readdirSync(path.join(root, 'database/migrations'));
  assert.ok(
    files.includes('052_linoleum_stock_staging.sql'),
    `expected ${MIGRATION}; found: ${files.filter((f) => f.startsWith('05')).join(', ')}`
  );
});

test('LINOLEUM-STAGING: creates linoleum_stock with the staged-export column set', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /create\s+table\s+if\s+not\s+exists\s+(public\.)?linoleum_stock/i,
    'missing CREATE TABLE IF NOT EXISTS linoleum_stock'
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
    /width_m\s+numeric\s+not\s+null\s+check\s*\(\s*width_m\s+in\s*\(\s*1\.5,\s*2,\s*2\.5,\s*3,\s*4\s*\)\s*\)/i,
    'width_m numeric not null CHECK (width_m IN (1.5, 2, 2.5, 3, 4)) — DB mirror of the parser whitelist'
  );
  assert.match(
    body,
    /price_sqm\s+numeric\(12,2\)\s+not\s+null\s+check\s*\(\s*price_sqm\s*>=\s*0\s*\)/i,
    'price_sqm numeric(12,2) not null CHECK (price_sqm >= 0) — грн/м², canon of the ingest insert'
  );
  assert.match(
    body,
    /\bqty_m\s+integer\s+not\s+null\s+check\s*\(\s*qty_m\s*>=\s*0\s*\)/i,
    'qty_m integer not null CHECK (qty_m >= 0) — linoleum stock is whole linear meters'
  );
  assert.doesNotMatch(
    body,
    /\bprice_retail\b|\bqty\b/i,
    'the retired wallpaper-shaped columns (price_retail, bare qty) must not exist: the ingest inserts width_m/price_sqm/qty_m'
  );
  assert.match(
    body,
    /created_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i,
    'created_at timestamptz default now()'
  );
});

test('LINOLEUM-STAGING: append-only staging — no uniqueness beyond the PK', () => {
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

test('LINOLEUM-STAGING: RLS enabled, no policies (service-role only)', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /alter\s+table\s+(public\.)?linoleum_stock\s+enable\s+row\s+level\s+security/i,
    'missing ENABLE ROW LEVEL SECURITY on linoleum_stock'
  );
  assert.doesNotMatch(
    body,
    /create\s+policy/i,
    'no policies may exist: RLS-with-no-policy denies anon/authenticated outright'
  );
  // Belt-and-suspenders on top of RLS: Supabase default privileges grant
  // SELECT on new tables to public; explicit revoke makes the post-check
  // deterministic (anon SELECT -> permission denied, not 0 rows).
  assert.match(
    body,
    /revoke\s+select\s+on\s+(table\s+)?(public\.)?linoleum_stock\s+from\s+anon,\s*authenticated/i,
    'SELECT must be revoked from anon, authenticated'
  );
});

test('LINOLEUM-STAGING: write grants revoked too (033-style defense in depth)', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /revoke\s+insert,\s*update,\s*delete\s+on\s+(table\s+)?(public\.)?linoleum_stock\s+from\s+anon,\s*authenticated/i,
    'INSERT/UPDATE/DELETE must be revoked from anon, authenticated'
  );
});

test('LINOLEUM-STAGING: index on export_date for freshness checks', () => {
  const body = stripComments(src(MIGRATION));
  assert.match(
    body,
    /create\s+index\s+if\s+not\s+exists\s+idx_linoleum_stock_export_date/i,
    'missing named index for export_date'
  );
  assert.match(
    body,
    /on\s+(public\.)?linoleum_stock\s*\(\s*export_date\s*\)/i,
    'index must be on linoleum_stock(export_date)'
  );
});

test('LINOLEUM-STAGING: DDL-only migration — no data writes, no drops', () => {
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

test('LINOLEUM-STAGING: carries VERIFY-PRE/POST instructions for the orchestrator', () => {
  const m = src(MIGRATION); // full text: VERIFY blocks live in comments
  assert.match(m, /VERIFY-PRE/, 'missing VERIFY-PRE block');
  assert.match(m, /VERIFY-POST/, 'missing VERIFY-POST block');
  assert.match(m, /linoleum_stock/, 'VERIFY block must reference the table');
});

test('LINOLEUM-STAGING: header documents the manual apply + writer route', () => {
  const m = src(MIGRATION);
  assert.match(m, /1c-linoleum/, 'header must name the ingest route that writes the table');
  assert.match(m, /append-only/i, 'header must document the append-only contract');
});
