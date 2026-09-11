-- 042_restock_requests.sql
-- «Повідомити про наявність» (restock notify, v1 = уведомление владельцу):
-- покупатель оставляет email на OOS-позициях (кнопка на PDP, монтируется
-- серверным гейтом availability_status='out_of_stock'); POST
-- /api/products/restock-notify пишет запрос сюда; скрипт
-- scripts/wallpaper-import.ts (хук после успешного --run) находит запросы
-- к товарам, которые получили сток (stock_quantity > 0 И is_active),
-- и отправляет владельцу Telegram-сводку с email'ами (владелец связывается
-- с покупателями сам; автоemail покупателю — v2, когда появится SMTP).
--
-- Контракт безопасности — по образцу 041 (041-паттерн; 014/039-семантика):
--   * RLS ENABLED, policies НЕ создаются: anon/authenticated не видят ни
--     одной строки (invisible-table semantics); читает/пишет только
--     service role строго server-side.
--   * ПОВЕРХ RLS — явный REVOKE SELECT/INSERT (дефолтные привилегии
--     Supabase выдают SELECT на новые таблицы роли public; INSERT отозван
--     defense-in-depth: запись ТОЛЬКО через service-role API-роут).
--   * email — TEXT (не citext): уникальность дедуплицируется нормализацией
--     на входе API (trim + lowercase); расширение не нужно.
--   * UNIQUE (product_id, email): повторная заявка того же покупателя на
--     тот же товар — no-op (ON CONFLICT DO NOTHING в API-роуте), ответ
--     покупателю одинаковый (анти-разочарование/анти-оракул).
--   * notified_at: момент выдачи владельцу (UPDATE ... SET notified_at =
--     now() только после успешной отправки Telegram; сбой отправки не
--     маркирует — заявка уйдет в следующий прогон).
--
-- Идемпотентность: CREATE TABLE / INDEX IF NOT EXISTS + REVOKE — файл
-- можно применять повторно.
--
-- Порядок применения: оркестратор через Supabase MCP по поручению владельца.
--
-- VERIFY-PRE (до применения; ожидание: таблицы нет):
--   select to_regclass('public.restock_requests');            -- до: NULL
--
-- VERIFY-POST (после применения):
--   select count(*) from restock_requests;                    -- 0 (пусто до первой заявки)
--   select indexname from pg_indexes
--    where tablename = 'restock_requests';                    -- pk_pkey,
--                                                             -- restock_requests_product_id_email_key,
--                                                             -- idx_restock_requests_pending
--   select column_name, data_type from information_schema.columns
--    where table_name = 'restock_requests'
--    order by ordinal_position;                               -- id uuid, product_id uuid,
--                                                             -- email text, created_at timestamptz,
--                                                             -- notified_at timestamptz
--   -- под anon (ключ anon / любой клиентский запрос):
--   select * from restock_requests limit 1;                   -- ожидание: permission denied (42501)
--   insert into restock_requests (product_id, email)
--     values ('00000000-0000-0000-0000-000000000000', 'x@y.z');
--                                                             -- ожидание: permission denied (42501)
--
-- ROLLBACK:
--   drop table if exists public.restock_requests;

CREATE TABLE IF NOT EXISTS restock_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES products(id),
    email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notified_at TIMESTAMPTZ,
    CONSTRAINT restock_requests_product_id_email_key UNIQUE (product_id, email)
);

ALTER TABLE restock_requests ENABLE ROW LEVEL SECURITY;

REVOKE SELECT, INSERT ON restock_requests FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_restock_requests_pending
  ON restock_requests(notified_at)
  WHERE notified_at IS NULL;
