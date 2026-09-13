-- Migration 047: shared (cross-instance) rate limiting
--
-- The in-process limiter (app/lib/rate-limit.ts) stays as the cheap first
-- line, but on serverless every instance has its own memory, so effective
-- limits blur under load. This table + RPC give the SAME per-(route, IP)
-- sliding window to every instance: the authoritative decision moves to
-- the DB while the in-process check remains as a fast pre-filter.
--
-- Privacy: the IP is never stored — the client sends HMAC-SHA256(
-- domain-separated service key, ip) as p_ip_hash (rate-limit:v1, see
-- app/lib/rate-limit.ts). Only the service role can reach the table.
--
-- Semantics preserved from the in-memory limiter:
--   * only ACCEPTED requests count (a rejected request neither extends
--     nor deepens the block — the INSERT happens only on allow);
--   * multi-rule sets (burst + hourly) are checked in one call; denied
--     retry_after is the STRICTEST violated window;
--   * check-then-insert races may overshoot slightly (flood ceiling, not
--     an exact quota) — same documented trade-off as failed_lookup_counters.
--
-- Re-run safety: create ... if not exists + create or replace function.

begin;

create table if not exists public.rate_limit_hits (
  name    text        not null,
  ip_hash text        not null,
  at      timestamptz not null default now()
);

create index if not exists idx_rate_limit_hits_key_at
  on public.rate_limit_hits (name, ip_hash, at);

-- No direct table access for clients; the SECURITY DEFINER RPC below is
-- the only door (service role bypasses RLS, anon/authenticated get none).
alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from anon, authenticated;

create or replace function public.rate_limit_hit(
  p_name    text,
  p_ip_hash text,
  p_rules   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule          jsonb;
  v_window_sec    int;
  v_max           int;
  v_cutoff        timestamptz;
  v_count         int;
  v_oldest        timestamptz;
  v_retry         int;
  v_retry_max     int := 0;
  v_max_window    int := 0;
begin
  if p_name is null or p_ip_hash is null
     or jsonb_typeof(p_rules) <> 'array'
     or jsonb_array_length(p_rules) = 0 then
    return jsonb_build_object('allowed', false, 'retry_after_sec', 1, 'error', 'bad_input');
  end if;

  -- Largest window in the set drives the opportunistic trim for this key.
  for v_rule in select * from jsonb_array_elements(p_rules) loop
    v_max_window := greatest(v_max_window, coalesce((v_rule->>'window_sec')::int, 0));
  end loop;
  if v_max_window <= 0 then
    return jsonb_build_object('allowed', false, 'retry_after_sec', 1, 'error', 'bad_window');
  end if;
  delete from public.rate_limit_hits
   where name = p_name
     and ip_hash = p_ip_hash
     and at < now() - make_interval(secs => v_max_window);

  -- Per-rule sliding-window check on the EXISTING rows (rejected requests
  -- never insert, so they cannot deepen a block).
  for v_rule in select * from jsonb_array_elements(p_rules) loop
    v_window_sec := coalesce((v_rule->>'window_sec')::int, 0);
    v_max        := coalesce((v_rule->>'max')::int, 0);
    if v_window_sec <= 0 or v_max <= 0 then
      return jsonb_build_object('allowed', false, 'retry_after_sec', 1, 'error', 'bad_rule');
    end if;
    v_cutoff := now() - make_interval(secs => v_window_sec);
    select count(*), min(at) into v_count, v_oldest
      from public.rate_limit_hits
     where name = p_name
       and ip_hash = p_ip_hash
       and at > v_cutoff;
    if v_count >= v_max then
      v_retry := ceil(extract(epoch from
        (v_oldest + make_interval(secs => v_window_sec) - now())))::int;
      v_retry_max := greatest(v_retry_max, least(greatest(v_retry, 1), v_window_sec));
    end if;
  end loop;

  if v_retry_max > 0 then
    return jsonb_build_object('allowed', false, 'retry_after_sec', v_retry_max);
  end if;

  insert into public.rate_limit_hits (name, ip_hash) values (p_name, p_ip_hash);
  return jsonb_build_object('allowed', true, 'retry_after_sec', 0);
end;
$$;

-- Opportunistic garbage collection: keys that never get hit again would
-- otherwise keep their last rows forever. 2h covers the largest window
-- (1h) with headroom.
create or replace function public.rate_limit_sweep()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.rate_limit_hits where at < now() - interval '2 hours';
$$;

commit;

-- Scheduling (same pattern as migration 008): Supabase hosted projects
-- ship pg_cron; enable it in Dashboard → Database → Extensions, then run
-- ONCE in SQL Editor:
--   select cron.schedule(
--     'rate-limit-sweep', '*/15 * * * *',
--     $$ select public.rate_limit_sweep(); $$
--   );
-- Until then the RPC trims its own key on every hit; unhit keys are
-- cleaned by the sweep once scheduled (harmless no-op before).

-- VERIFY-PRE: table absent or empty schema; RPC absent
--   select to_regclass('public.rate_limit_hits');            -- null
--   select to_regproc('public.rate_limit_hit(text,text,jsonb)'); -- null
-- VERIFY-POST:
--   select to_regclass('public.rate_limit_hits');            -- not null
--   select public.rate_limit_hit('probe','probe','[{"max":2,"window_sec":60}]');
--     -- twice: allowed true; third call: allowed false, retry_after_sec > 0
--   select count(*) from public.rate_limit_hits where name='probe'; -- ≤2
--   select has_table_privilege('anon', 'public.rate_limit_hits', 'SELECT'); -- false
