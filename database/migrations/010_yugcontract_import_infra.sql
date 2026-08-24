-- Migration 010: Yugcontract stage 2B — import infrastructure.
--
-- 1) categories.yugcontract_id — durable external identity for supplier
--    categories (identity = Yugcontract category id, never name matching).
--    Same NULL-friendly partial unique pattern as products (009).
--
-- 2) yc_import_batches — resumable import checkpoint state. One row per
--    (run, phase, batch): lets a crashed Vercel/serverless invocation
--    continue from the exact next batch without duplicates. RLS is ON
--    with NO policies: anon/authenticated are denied; service_role
--    (server-side only) bypasses RLS.

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS yugcontract_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_yugcontract_id
  ON categories(yugcontract_id)
  WHERE yugcontract_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS yc_import_batches (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('categories', 'brands', 'products')),
    batch_no INTEGER NOT NULL,
    -- leaf category ids for 'products' batches (audit/debug only)
    payload JSONB,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'done', 'failed')),
    processed_count INTEGER NOT NULL DEFAULT 0,
    inserted_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (run_id, phase, batch_no)
);

ALTER TABLE yc_import_batches ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_yc_import_batches_run
  ON yc_import_batches(run_id, status);
