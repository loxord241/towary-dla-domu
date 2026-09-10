-- 040_availability_from_stock.sql
-- Правило наличия (GO владельца 2026-09-10; spec §5:
-- docs/superpowers/specs/2026-09-10-wallpapers-import-design.md).
-- Цель: честный флаг наличия на витрине при любых списаниях стока —
-- ежедневный 1C-sync обоев, продажи с сайта (place_order декрементирует
-- stock_quantity), ручные правки в админке. Семантика:
--   stock_quantity = 0  ->  availability_status = 'out_of_stock'  («Немає в наявності»)
--   stock_quantity > 0  ->  availability_status = 'in_stock'      («В наявності»)
-- INSERT не трогаем: Юг-синк и wallpapers-импортер пишут оба поля согласованно;
-- 'limited_availability' триггером не выдаётся (в правило наличия не входит).
-- place_order не изменяется (триггер только синхронизирует статус-флаг).
-- Идемпотентность: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS —
-- файл можно применять повторно (например, после частично упавшего прогона).
--
-- Порядок применения: оркестратор через Supabase MCP по поручению владельца.
--
-- VERIFY-PRE (до применения; ожидание: 0 строк):
--   select tgname from pg_trigger
--   where tgname like 'trg_%_availability_from_stock' and not tgisinternal;
--
-- VERIFY-POST (после применения; на 2 тестовых строках, значения откатить):
--   begin;
--   update products set stock_quantity = stock_quantity
--     where id = <тестовый id с qty = 0>;      -- availability_status => 'out_of_stock'
--   update products set stock_quantity = stock_quantity
--     where id = <тестовый id с qty > 0>;      -- availability_status => 'in_stock'
--   update product_variants set stock_quantity = stock_quantity
--     where id = <тестовый id>;                -- статус следует за qty так же
--   rollback;

CREATE OR REPLACE FUNCTION set_availability_from_stock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.availability_status := CASE WHEN NEW.stock_quantity > 0 THEN 'in_stock' ELSE 'out_of_stock' END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_products_availability_from_stock ON products;
CREATE TRIGGER trg_products_availability_from_stock
BEFORE UPDATE OF stock_quantity ON products
FOR EACH ROW EXECUTE FUNCTION set_availability_from_stock();

DROP TRIGGER IF EXISTS trg_product_variants_availability_from_stock ON product_variants;
CREATE TRIGGER trg_product_variants_availability_from_stock
BEFORE UPDATE OF stock_quantity ON product_variants
FOR EACH ROW EXECUTE FUNCTION set_availability_from_stock();
