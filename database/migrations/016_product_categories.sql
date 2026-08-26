-- 016_product_categories.sql
-- Many-to-many product<->categories. Stores DIRECT assignments only:
-- parent/descendant visibility is computed in application code from the
-- category tree (collectSubtreeIds), never materialized here.
-- Legacy transition: products.category_id is kept in sync as the
-- default/primary category until a future cleanup migration.
--
-- NOTE: no data backfill in this file (separate operation AFTER this
-- migration is applied manually via Supabase SQL Editor).
--
-- Project footgun (final_001: ALTER DEFAULT PRIVILEGES GRANT SELECT TO
-- public): every new table starts world-readable unless RLS is enabled
-- immediately. Hence ENABLE RLS + explicit policy in the SAME migration.

CREATE TABLE IF NOT EXISTS product_categories (
    product_id  UUID NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_product_categories_category_id
  ON product_categories(category_id);

ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon and authenticated can read active product-category links"
  ON product_categories;

CREATE POLICY "Anon and authenticated can read active product-category links"
  ON product_categories
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (SELECT 1 FROM products p   WHERE p.id  = product_id  AND p.is_active = TRUE)
    AND
    EXISTS (SELECT 1 FROM categories c WHERE c.id = category_id AND c.is_active = TRUE)
  );

-- No INSERT/UPDATE/DELETE policies: writes go through the service-role
-- (admin API + importer), never through user sessions.
