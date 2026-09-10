-- 041_wallpaper_stock_staging.sql
-- Staging-таблица ежедневной выгрузки остатков обоев из 1С 7.7 владельца
-- (spec §3: docs/superpowers/specs/2026-09-10-wallpapers-import-design.md;
-- план Task 2). Канал: VBS-выгрузка → POST /api/ingest/1c-wallpaper →
-- эта таблица → идемпотентный импортер (--plan/--run, чекпоинты).
--
-- Контракт staging — по образцу yc_content_goods (миграция 011):
--   * RLS ENABLED, policies НЕ создаются: anon/authenticated не видят
--     ни одной строки (invisible-table semantics), читает/пишет только
--     service role строго server-side.
--   * ПОВЕРХ RLS — явный REVOKE SELECT (014/039-паттерн): дефолтные
--     привилегии Supabase выдают SELECT на новые таблицы роли public,
--     и полагаться на «RLS и так закрыл» для staging нельзя. После
--     применения anon SELECT даёт permission denied (42501), а не
--     молчаливый пустой результат.
--   * УНИКАЛЬНОСТИ сверх PK НЕТ — каждый дневной экспорт ДОПИСЫВАЕТ
--     строки (append-only); импортер читает свежайшую строку на код:
--     DISTINCT ON (code) ... ORDER BY code, export_date DESC.
--   * price_retail/qty — NUMERIC с CHECK >= 0: мусор из CSV отсекается
--     на уровне БД; остальная валидация (0..100000 / 0..9999) — в
--     ingest-эндпоинте (reject строки, не файла).
--
-- Идемпотентность: CREATE TABLE / INDEX IF NOT EXISTS + REVOKE —
-- файл можно применять повторно.
--
-- Порядок применения: оркестратор через Supabase MCP по поручению владельца.
--
-- VERIFY-PRE (до применения; ожидание: таблицы нет / 0 строк):
--   select to_regclass('public.wallpaper_stock');            -- до: NULL
--   select count(*) from wallpaper_stock;                    -- сразу после apply: 0
--
-- VERIFY-POST (после применения):
--   select count(*) from wallpaper_stock;                    -- 0 (staging пуст до первого ingest)
--   select indexname from pg_indexes
--    where tablename = 'wallpaper_stock';                    -- pk + idx_wallpaper_stock_export_date
--   -- под anon (ключ anon / любой клиентский запрос):
--   select * from wallpaper_stock limit 1;                   -- ожидание: permission denied (42501)
--
-- ROLLBACK:
--   drop table if exists public.wallpaper_stock;

CREATE TABLE IF NOT EXISTS wallpaper_stock (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    export_date DATE NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    price_retail NUMERIC NOT NULL CHECK (price_retail >= 0),
    qty NUMERIC NOT NULL CHECK (qty >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wallpaper_stock ENABLE ROW LEVEL SECURITY;

REVOKE SELECT ON wallpaper_stock FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_wallpaper_stock_export_date
  ON wallpaper_stock(export_date);
