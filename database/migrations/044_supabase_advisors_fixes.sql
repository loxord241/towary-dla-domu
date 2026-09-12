-- 044_supabase_advisors_fixes.sql
-- Закрывает находки Supabase advisors (аудит P1, 2026-09-12):
--
-- 1. anon_security_definer_function_executable / authenticated_…:
--    public.rls_auto_enable() — SECURITY DEFINER, вызываемая anon и
--    authenticated через /rest/v1/rpc. Хвост бутстрапа: в коде репо и в
--    миграциях НЕТ ни одного вызова (grep 2026-09-12). EXECUTE отбирается
--    у PUBLIC (дефолт-грант) и явно у anon/authenticated; service_role
--    получает явный GRANT на случай админ-нужды.
--
-- 2. function_search_path_mutable:
--    public.set_availability_from_stock() — BEFORE-триггер products,
--    тело использует только NEW и строковые литералы (никаких
--    unqualified-отношений), поэтому фиксация search_path='' безопасна
--    и закрывает schema-shadowing.
--
-- 3. unindexed_foreign_keys (performance advisor): 4 FK без покрывающих
--    индексов — order_items.variant_id, order_shipment_items(order_item_id, order_id)
--    [fk_order_shipment_items_item_order, fkey_columns 2,4],
--    order_shipment_items(shipment_id, order_id)
--    [fk_order_shipment_items_shipment_order, fkey_columns 1,4],
--    product_attribute_values.attribute_value_id.
--    CREATE INDEX (не CONCURRENTLY — миграционный раннер в транзакции;
--    таблицы небольшие, блокировка краткая).
--
-- DDL-only. RLS/политики/данные не трогаются. Идемпотентность: IF EXISTS /
-- DROP INDEX IF EXISTS + CREATE INDEX IF NOT EXISTS.
--
-- VERIFY-PRE:
--   select has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE');  -- true до
--   select count(*) from pg_indexes
--    where schemaname='public' and indexname like 'idx_advisors_%';                -- 0 до
-- VERIFY-POST:
--   has_function_privilege('anon', …) = false; то же для authenticated;
--   select count(*) … idx_advisors_% = 4;
--   select proconfig from pg_proc where proname='set_availability_from_stock';     -- {search_path=}
--
-- ROLLBACK: обратные REVOKE/GRANT, ALTER FUNCTION RESET search_path, DROP INDEX.

-- 1. rls_auto_enable(): только service_role.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO service_role;

-- 2. Триггер availability: зафиксировать search_path.
ALTER FUNCTION public.set_availability_from_stock() SET search_path = '';

-- 3. FK-индексы.
CREATE INDEX IF NOT EXISTS idx_advisors_order_items_variant
  ON public.order_items (variant_id);
CREATE INDEX IF NOT EXISTS idx_advisors_osi_order_item
  ON public.order_shipment_items (order_item_id, order_id);
CREATE INDEX IF NOT EXISTS idx_advisors_osi_shipment_order
  ON public.order_shipment_items (shipment_id, order_id);
CREATE INDEX IF NOT EXISTS idx_advisors_pav_attribute_value
  ON public.product_attribute_values (attribute_value_id);
