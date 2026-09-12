-- 043_restock_requests_fk_cascade.sql
-- Hard-delete товара с живыми restock-заявками падал FK violation → 500:
-- миграция 042 создала product_id uuid NOT NULL REFERENCES products(id)
-- БЕЗ ON DELETE, поэтому DELETE products.id при наличии строк в
-- restock_requests завершался ошибкой 23503 (restock_requests_product_id_fkey).
--
-- FIX: пересоздать FK с ON DELETE CASCADE — удаление товара молча чистит
-- его restock-заявки (заявка на удалённый товар не имеет смысла: товара
-- больше нет, «повідомити про наявність» не о чем; до 043-паттерна роут
-- hard-delete сам предварительно чистит restock_requests — эта миграция
-- делает то же поведение декларативным и защищает любые другие пути
-- удаления products).
--
-- Контракт безопасности — по образцу 042 (041-паттерн):
--   * Таблица, RLS, политики и привилегии НЕ трогаются — только
--     определение внешнего ключа.
--   * DDL-only, никаких INSERT/UPDATE/DELETE данных, никаких DROP TABLE.
--
-- Имя констрейнта: 042 объявила REFERENCES inline без явного имени, поэтому
-- Postgres присвоил дефолтное имя restock_requests_product_id_fkey
-- (<таблица>_<колонка>_fkey). VERIFY-PRE это подтверждает.
--
-- Идемпотентность: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT — файл можно
-- применять повторно (повторный прогон: drop ничего не находит? нет —
-- после первого применения констрейнт существует, drop удаляет его и add
-- пересоздаёт тем же определением; результат идентичен).
--
-- Порядок применения: оркестратор через Supabase MCP по поручению владельца.
--
-- VERIFY-PRE (до применения):
--   select conname, confdeltype from pg_constraint
--    where conrelid = 'public.restock_requests'::regclass and contype = 'f';
--                                                             -- до: conname =
--                                                             -- restock_requests_product_id_fkey,
--                                                             -- confdeltype = 'a' (NO ACTION)
--
-- VERIFY-POST (после применения):
--   select conname, confdeltype from pg_constraint
--    where conrelid = 'public.restock_requests'::regclass and contype = 'f';
--                                                             -- после: тот же
--                                                             -- conname, confdeltype = 'c' (CASCADE)
--   -- поведение: заявки удаляются вместе с товаром, DELETE products проходит
--   select count(*) from restock_requests;                    -- (строки товара удалены каскадом)
--
-- ROLLBACK:
--   alter table public.restock_requests drop constraint restock_requests_product_id_fkey;
--   alter table public.restock_requests
--     add constraint restock_requests_product_id_fkey
--     foreign key (product_id) references products(id);

ALTER TABLE restock_requests
  DROP CONSTRAINT IF EXISTS restock_requests_product_id_fkey;

ALTER TABLE restock_requests
  ADD CONSTRAINT restock_requests_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products(id)
  ON DELETE CASCADE;
