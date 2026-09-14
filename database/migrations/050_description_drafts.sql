-- Migration 050: product description drafts (spec
-- docs/superpowers/specs/2026-09-14-epicentr-description-pattern.md,
-- Phase 2) — staging for owner-approved product descriptions, по образцу
-- yc_content_goods (011): генератор (scripts/description-generate.ts) пишет
-- сюда лид + текст описания, НЕ трогая products.description. Владелец
-- утверждает/отклоняет черновики в /admin/descriptions.
--
-- CONTRACT:
--   * UNIQUE(product_id) — ровно один черновик на товар; повторные --run
--     НЕ перезаписывают существующий черновик (INSERT ... ON CONFLICT
--     (product_id) DO NOTHING в скрипте, констрейнт здесь как второй барьер).
--   * status: pending → approved | rejected (CHECK). ONLY the approved
--     transition writes products.description — и только внутри
--     approve_product_description_draft() (см. ниже), т.е. один writer.
--   * RLS ON, НОЛИ политик: anon/authenticated не видят ни одной строки;
--     сервисные сценарии (CLI, /api/admin/descriptions после
--     requireAdminApi) ходят под service_role, который RLS обходит.
--    REVOKE ALL от anon/authenticated — defense in depth в духе 035/039:
--     снесены и дефолтные Supabase-гранты (включая TRUNCATE, которого RLS
--     не останавливает).
--   * approve_product_description_draft(uuid): атомарное утверждение.
--     PostgREST не умеет транзакции из двух апдейтов, поэтому пара
--     «products.description = description_text + status='approved'»
--     выполняется одним вызовом функции (тело функции = одна транзакция).
--     Частичный исход невозможен: либо оба апдейта, либо ни одного.
--     Функция пишет ТОЛЬКО products.description — name/sku/slug/price/
--     is_active/... структурно недостижимы. Утвердить можно только
--     pending-черновик: повторный вызов или approved/rejected строка
--     дают ошибку (API отвечает 409), а не тихий no-op.
--
-- VERIFY-PRE:
--   select count(*) from products where is_active; -- >0
-- VERIFY-POST:
--   select count(*) from public.product_description_drafts; -- 0 (только DDL)
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name='product_description_drafts'
--      and grantee in ('anon','authenticated'); -- 0 строк
--   select has_function_privilege('anon',
--     'public.approve_product_description_draft(uuid)', 'execute'); -- false

begin;

create table if not exists public.product_description_drafts (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null references public.products(id) on delete cascade,
    lead text not null,
    description_text text not null,
    status text not null default 'pending'
      check (status in ('pending', 'approved', 'rejected')),
    source text not null default 'spec-generator-v1',
    created_at timestamptz not null default now(),
    reviewed_at timestamptz,
    unique (product_id)
);

alter table public.product_description_drafts enable row level security;

-- Очередь утверждения листается по (status, created_at): pending первыми,
-- старейшие впереди — детерминированный порядок и для админ-API, и для CLI.
create index if not exists idx_product_description_drafts_status_created
  on public.product_description_drafts (status, created_at);

-- Доступ только service-role/admin-роутами: RLS deny-all (0 политик) плюс
-- полный REVOKE дефолтных грант от anon/authenticated. SELECT тоже забран —
-- ни один публичный путь эту таблицу не читает.
revoke all on table public.product_description_drafts from anon, authenticated;

create or replace function public.approve_product_description_draft(p_draft_id uuid)
returns void
language plpgsql
as $$
declare
    v_product_id uuid;
    v_text text;
begin
    select product_id, description_text
      into v_product_id, v_text
      from public.product_description_drafts
     where id = p_draft_id
       and status = 'pending';

    if v_product_id is null then
        raise exception 'draft % not found or not pending', p_draft_id;
    end if;

    -- Единственный writer products.description в этой фиче; столбец один,
    -- остальные поля products не затрагиваются.
    update public.products
       set description = v_text
     where id = v_product_id;

    update public.product_description_drafts
       set status = 'approved',
           reviewed_at = now()
     where id = p_draft_id;
end;
$$;

-- Вызов только с сервера (service-role): публичные роли execute не получают.
revoke all on function public.approve_product_description_draft(uuid)
  from public, anon, authenticated;
grant execute on function public.approve_product_description_draft(uuid)
  to service_role;

commit;
