-- Migration 028: independent «Обрані» curation flag.
--
-- History: the home page has two curated sections — «Обрані товари» and
-- «Популярні товари» — but both were driven by the single is_featured
-- flag, so an admin flagging a product as «Обрані» also pushed it into
-- «Популярні товари». This migration adds a SECOND, fully independent
-- boolean so each section has its own source of truth:
--
--   is_featured  -> «Популярні товари» (unchanged, max-8 admin rule)
--   is_selected  -> «Обрані товари»   (new)
--
-- Existing rows default to FALSE; the featured column, its index and the
-- max-8 mechanics are NOT touched.

alter table products add column if not exists is_selected boolean not null default false;

-- Mirrors idx_products_active_featured (final_002): partial so it only
-- covers storefront-visible rows.
create index if not exists idx_products_active_selected
  on products(is_active, is_selected)
  where is_active = true;
