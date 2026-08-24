-- Migration 012 (F6): physical protection against duplicate image rows.
--
-- The images hotlink importer identifies rows by the logical pair
-- (product_id, image_url), but until now nothing at the database level
-- enforced it: a concurrent second executor or a planner bug would have
-- silently inserted duplicate gallery rows.
--
-- Pre-conditions verified on live data before this migration
-- (scripts/tmp-f6-premigration.ts, 2026-08-24):
--   COUNT(*) == COUNT(DISTINCT product_id, image_url) == 23849 (0 dups);
--   product_id IS NULL -> 0; image_url NOT NULL + chk_image_url_not_empty.
--
-- Semantics notes:
--   - Default NULLS DISTINCT behaviour is acceptable: there are no NULLs
--     today, and a hypothetical (NULL, url) row is not part of importer
--     identity anyway;
--   - CONCURRENTLY builds without blocking writes; it CANNOT run inside a
--     transaction block — execute this single statement by itself
--     (Supabase SQL Editor autocommits each statement: paste as-is, do
--     NOT wrap in BEGIN/COMMIT);
--   - rollback (if ever needed): DROP INDEX CONCURRENTLY idx_product_images_product_url;
--
-- Apply manually via Supabase SQL Editor (DDL is not reachable from app code).

CREATE UNIQUE INDEX CONCURRENTLY idx_product_images_product_url
ON public.product_images(product_id, image_url);
