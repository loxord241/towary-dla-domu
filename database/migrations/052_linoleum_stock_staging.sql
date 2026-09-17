-- 052_linoleum_stock_staging.sql
-- Staging-таблица ежедневной выгрузки остатков линолеума из 1С владельца
-- (вертикаль «линолеум», батч 1; план владельца 2026-09-17). Канал:
-- выгрузка → POST /api/ingest/1c-linoleum (service-role, строго
-- server-side) → эта таблица → идемпотентный импортер (батч 2).
--
-- ЗЕРКАЛО 041_wallpaper_stock_staging.sql. Контракт staging:
--   * RLS ENABLED, policies НЕ создаются: anon/authenticated не видят
--     ни одной строки (invisible-table semantics), читает/пишет только
--     service role.
--   * ПОВЕРХ RLS — явные REVOKE: SELECT (014/039-паттерн; дефолтные
--     привилегии Supabase выдают SELECT на новые таблицы роли public)
--     плюс INSERT/UPDATE/DELETE (033-паттерн, defense in depth). После
--     применения anon SELECT даёт permission denied (42501), а не
--     молчаливый пустой результат.
--   * APPEND-ONLY: уникальностей сверх PK НЕТ — каждый дневной экспорт
--     ДОПИСЫВАЕТ строки; импортер читает свежайшую строку на код:
--     DISTINCT ON (code) ... ORDER BY code, export_date DESC.
--   * КАНОН КОЛОНОК = инсерту ingest-эндпоинта /api/ingest/1c-linoleum
--     (строка staging = дизайн×ширина из выгрузки CSV
--     «code;name;width_m;price_sqm;qty_m»):
--       - width_m — ширина рулона (м); NUMERIC с CHECK (width_m IN
--         (1.5, 2, 2.5, 3, 3.5, 4)) — DB-уровень зеркалит whitelist парсера
--         (defense in depth; основная валидация — в эндпоинте);
--       - price_sqm — цена за м², NUMERIC(12,2), CHECK >= 0: мусор из
--         CSV отсекается на уровне БД;
--       - qty_m — сток в ЦЕЛЫХ погонных метрах (решение владельца
--         2026-09-17), INTEGER, CHECK >= 0.
--
-- Применяется ВРУЧНУЮ владельцем/оркестратором через Supabase SQL Editor
-- (из кода DDL недоступен). Идемпотентность: CREATE TABLE / INDEX IF NOT
-- EXISTS + REVOKE — файл можно применять повторно.
--
-- VERIFY-PRE (до применения; ожидание: таблицы нет / 0 строк):
--   select to_regclass('public.linoleum_stock');            -- до: NULL
--   select count(*) from linoleum_stock;                    -- сразу после apply: 0
--
-- VERIFY-POST (после применения):
--   select count(*) from linoleum_stock;                    -- 0 (staging пуст до первого ingest)
--   select indexname from pg_indexes
--    where tablename = 'linoleum_stock';                    -- pk + idx_linoleum_stock_export_date
--   -- под anon (ключ anon / любой клиентский запрос):
--   select * from linoleum_stock limit 1;                   -- ожидание: permission denied (42501)
--
-- ROLLBACK:
--   drop table if exists public.linoleum_stock;

CREATE TABLE IF NOT EXISTS linoleum_stock (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    export_date DATE NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    width_m NUMERIC NOT NULL CHECK (width_m IN (1.5, 2, 2.5, 3, 3.5, 4)),
    price_sqm NUMERIC(12,2) NOT NULL CHECK (price_sqm >= 0),
    qty_m INTEGER NOT NULL CHECK (qty_m >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE linoleum_stock ENABLE ROW LEVEL SECURITY;

REVOKE SELECT ON linoleum_stock FROM anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON linoleum_stock FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_linoleum_stock_export_date
  ON linoleum_stock(export_date);
