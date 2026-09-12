-- 046_data_integrity_checks.sql
-- Аудит P2 (2026-09-12): products.availability_status / products.currency и
-- customers.email не имели CHECK-констрейнтов — битое значение могло попасть
-- мимо кода (руками/будущим скриптом). Данные проверены перед применением:
--   * availability_status ∈ {in_stock, out_of_stock} вживую (третий вариант
--     limited_availability разрешён кодом restock/каталога);
--   * currency: ровно 'UAH' у всех строк;
--   * customers.email: 0 строк с верхним регистром; путь записи нормализует
--     регистр дважды (route line ~127 + place_order v_email := lower(...)).
--
-- DDL-only, идемпотентность через guarded DO-блоки (нет IF NOT EXISTS для
-- констрейнтов до PG 9.6+ синтаксиса ADD CONSTRAINT IF NOT EXISTS).
--
-- VERIFY-PRE:
--   select count(*) from products where availability_status
--     not in ('in_stock','out_of_stock','limited_availability');  -- 0
--   select count(*) from products where currency <> 'UAH';        -- 0
--   select count(*) from customers where email <> lower(email);   -- 0
-- VERIFY-POST:
--   select conname from pg_constraint
--    where conrelid in ('public.products'::regclass,'public.customers'::regclass)
--      and conname like 'ck_advisors_%';                           -- 3 строки
--
-- ROLLBACK: alter table … drop constraint if exists ck_advisors_…;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_advisors_products_availability'
      AND conrelid = 'public.products'::regclass
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT ck_advisors_products_availability
      CHECK (availability_status IN ('in_stock', 'out_of_stock', 'limited_availability'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_advisors_products_currency'
      AND conrelid = 'public.products'::regclass
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT ck_advisors_products_currency
      CHECK (currency = 'UAH');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_advisors_customers_email_lower'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT ck_advisors_customers_email_lower
      CHECK (email = lower(email));
  END IF;
END $$;
