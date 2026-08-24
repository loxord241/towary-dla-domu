-- Migration 009 (stage 2A): Yugcontract external id for products.
--
-- Identity rule of the whole integration: a Yugcontract product is
-- identified ONLY by its supplier id stored here — never by name,
-- slug, sku or price. The unique index makes re-runs of the importer
-- idempotent and prevents accidental duplicates.
--
-- Partial (WHERE NOT NULL): existing manual products keep
-- yugcontract_id = NULL and are unaffected; multiple NULLs are allowed.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS yugcontract_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_yugcontract_id
  ON products(yugcontract_id)
  WHERE yugcontract_id IS NOT NULL;
