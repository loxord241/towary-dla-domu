-- 037: catalog cleanup — delete two test/garbage brands (2026-09-08 audit).
--
-- WHY:
--   The UX audit flagged junk entries in the storefront brand filter.
--   A read-only paged scan of the live DB (2026-09-08, service-role
--   SELECT over brands + products) confirmed exactly two rows that are
--   BOTH keyboard-mash garbage AND have zero products:
--     * slug 'fdsafadsf' name 'rotex'
--       (id a550f753-a6fc-4a02-993d-683beedc60e6, created 2026-08-22)
--     * slug 'dsfdsds'  name 'ximix'
--       (id 930db0b3-8b1c-46dc-be73-28bc307bc9fc, created 2026-08-22;
--       also referenced by ONE legacy brands_translations row with test
--       garbage 'dasda'/'asdas' — the uk-translations feature was removed
--       from the app in 2026-08, so that row is dead data)
--
-- DELIBERATELY NOT INCLUDED:
--   * slug 'la' name 'LA-' — suspected by the audit, but the live DB
--     holds 111 products on it (all is_active with >= 1 image, i.e.
--     storefront-eligible). Real catalog data attaches to this brand;
--     renaming/merging it is a separate owner decision.
--   * slug 'grunhelm' name 'Grunhelm' — 0 products, but a plausible
--     real brand name (created 2026-08-28); kept, listed for the owner.
--
-- SAFETY:
--   * Every DELETE is guarded by
--       NOT EXISTS (SELECT 1 FROM products p WHERE p.brand_id = b.id)
--     — if a product ever (re)attaches to either slug, the statement
--     becomes a no-op instead of orphaning products.brand_id.
--   * The legacy brands_translations row is removed first (same guard),
--     so no FK/ordering surprise regardless of how that FK is declared.
--   * Sitemap/SEO: a brand enters the sitemap only with >= 1 eligible
--     product (app/lib/seo-sitemap.ts collectNonEmptyBrandIds) — both
--     targets have 0 products, so they are already absent from the
--     sitemap; their /catalog?brand=... views are already noindex'd
--     (app/lib/seo.ts, empty brand view) and stay a normal 200 empty
--     state as unknown slugs after deletion. du-redirects/_du aliases
--     are product-slug level and do not reference brands (grep-checked).
--   * No DDL, no grants touched. Idempotent: re-running deletes nothing.
--
-- VERIFY (run manually in SQL Editor before and after):
--   SELECT slug, name FROM brands
--    WHERE slug IN ('fdsafadsf', 'dsfdsds');
--     -- before: 2 rows ('fdsafadsf'|'rotex', 'dsfdsds'|'ximix')
--     -- after:  0 rows
--   SELECT count(*) FROM products p
--    WHERE p.brand_id IN (SELECT id FROM brands
--                          WHERE slug IN ('fdsafadsf', 'dsfdsds'));
--     -- before AND after: 0  (the guard precondition; must be 0 BEFORE)
--   SELECT count(*) FROM brands_translations
--    WHERE brand_id IN (SELECT id FROM brands
--                        WHERE slug IN ('fdsafadsf', 'dsfdsds'));
--     -- before: 1 (the 'dasda'/'asdas' row) / after: 0
--   SELECT count(*) FROM brands;
--     -- before: 74 / after: 72

begin;

delete from brands_translations bt
where bt.brand_id in (
  select b.id from brands b
  where b.slug in ('fdsafadsf', 'dsfdsds')
    and not exists (select 1 from products p where p.brand_id = b.id)
);

delete from brands b
where b.slug in ('fdsafadsf', 'dsfdsds')
  and not exists (select 1 from products p where p.brand_id = b.id);

commit;
