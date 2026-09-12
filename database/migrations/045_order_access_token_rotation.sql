-- 045_order_access_token_rotation.sql
-- Аудит P1 (2026-09-12): гостевой токен заказа был вечным детерминированным
-- HMAC(order_number) — утечка URL/лога давала постоянный доступ к заказу.
--
-- FIX: per-order случайный токен, в БД хранится ТОЛЬКО sha256-хэш
-- (orders.access_token_hash). Выдача: checkout и lookup. Ротация: КАЖДЫЙ
-- успешный lookup (email+номер = доказательство личности) генерирует новый
-- токен; idempotent-replay checkout тоже. Старые ссылки (HMAC) остаются
-- валидными, пока не случилась первая ротация конкретного заказа
-- (обратно-совместимый fallback: access_token_hash IS NULL → проверка
-- старым способом, см. app/lib/order-token.ts).
--
-- Данные не трогаются; колонка nullable без дефолта. RLS orders не меняем
-- (anon SELECT отозван ранее; пишет только service-role).
--
-- VERIFY-PRE:
--   select column_name from information_schema.columns
--    where table_name='orders' and column_name='access_token_hash';  -- 0 строк до
-- VERIFY-POST:
--   … 1 строка, data_type='text', is_nullable='YES';
--   select has_column_privilege('anon', 'orders', 'access_token_hash',
--          'SELECT');  -- false
--
-- ROLLBACK: alter table public.orders drop column if exists access_token_hash;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS access_token_hash text;
