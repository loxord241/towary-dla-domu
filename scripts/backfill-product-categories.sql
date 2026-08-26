-- Backfill for product_categories — RUN ONLY AFTER
-- database/migrations/016_product_categories.sql has been applied
-- manually via Supabase SQL Editor.
--
-- Copies each product's legacy default category as a DIRECT junction row.
-- ON CONFLICT DO NOTHING makes this idempotent: re-running costs nothing.

INSERT INTO product_categories (product_id, category_id)
SELECT id, category_id FROM products WHERE category_id IS NOT NULL
ON CONFLICT DO NOTHING;
