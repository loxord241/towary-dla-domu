-- Migration 011: Yugcontract stage 3 — content import infrastructure.
--
-- 1) products.specifications JSONB — supplier characteristics as a JSON
--    ARRAY of {name,value} pairs. Array (not object) because the real
--    feed contains goods where the SAME name carries DIFFERENT values
--    (10 matched / 115 feed-wide, dry-run 2026-08-24); an object would
--    lose that data. Supplier order is preserved. No GIN index yet —
--    add one only when actual filtering ships.
--
-- 2) yc_content_goods — staging for ONE normalized get-content-goods
--    dump (the endpoint has no server-side filtering and takes ~75s,
--    so it must be fetched once and then batch-processed from here).
--    description is stored ALREADY SANITIZED at fetch time; raw
--    supplier HTML is never persisted. pictures contains ONLY URLs that
--    passed the external-image validation (http(s), Yugcontract host,
--    image extension). RLS ON with NO policies: anon/authenticated are
--    denied; service_role (server-side only) bypasses RLS.
--
-- 3) yc_content_batches — resumable checkpoint state for the content
--    executor, deliberately SEPARATE from the price-import table
--    yc_import_batches (independent lifecycle, independent telemetry).
--    Same proven status pattern incl. stale-running recovery.
--
-- Apply manually via Supabase SQL Editor (DDL is not reachable from app code).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS specifications JSONB;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_specifications_is_array;

ALTER TABLE products
  ADD CONSTRAINT products_specifications_is_array
  CHECK (specifications IS NULL OR jsonb_typeof(specifications) = 'array');

CREATE TABLE IF NOT EXISTS yc_content_goods (
    -- identity = Yugcontract product id; duplicates in the upstream feed
    -- are resolved deterministically by the fetcher (first occurrence wins)
    yugcontract_id TEXT PRIMARY KEY,
    category_id TEXT,
    name TEXT,
    -- sanitized HTML (allowlist sanitizer applied during fetch)
    description TEXT,
    -- validated importable image URL strings
    pictures JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- array of {name,value} pairs (validated, non-empty)
    params JSONB NOT NULL DEFAULT '[]'::jsonb,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE yc_content_goods ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS yc_content_batches (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('description', 'images')),
    batch_no INTEGER NOT NULL,
    -- chunk of staged yugcontract_ids (audit/debug only)
    payload JSONB,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'done', 'failed')),
    processed_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (run_id, phase, batch_no)
);

ALTER TABLE yc_content_batches ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_yc_content_batches_run
  ON yc_content_batches(run_id, status);
