-- Production hardening: rate-limit agent register; revoke public EXECUTE on
-- sensitive SECURITY DEFINER RPCs (Next.js must use service_role).

create table if not exists public.rate_limits (
  bucket text primary key,
  count integer not null default 0,
  window_start timestamptz not null default now()
);

alter table public.rate_limits enable row level security;
revoke all on table public.rate_limits from anon, authenticated;
grant all on table public.rate_limits to service_role;

create or replace function public.check_rate_limit(
  p_bucket text,
  p_limit integer default 5,
  p_window_seconds integer default 3600
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  b text := left(trim(coalesce(p_bucket, '')), 200);
  lim int := greatest(1, coalesce(p_limit, 5));
  win int := greatest(60, coalesce(p_window_seconds, 3600));
  cnt int;
  started timestamptz;
begin
  if length(b) < 3 then
    return false;
  end if;

  insert into public.rate_limits (bucket, count, window_start)
  values (b, 1, now())
  on conflict (bucket) do update
    set
      count = case
        when rate_limits.window_start < now() - make_interval(secs => win)
          then 1
        else rate_limits.count + 1
      end,
      window_start = case
        when rate_limits.window_start < now() - make_interval(secs => win)
          then now()
        else rate_limits.window_start
      end
  returning count, window_start into cnt, started;

  return cnt <= lim;
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer) from public;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

-- Heartbeat / presence for connected agents
alter table public.agents
  add column if not exists last_seen_at timestamptz;

create or replace function public.heartbeat_connected_agent(p_api_key_hash text)
returns public.agents
language plpgsql
security definer
set search_path = public
as $$
declare
  kh text := lower(trim(coalesce(p_api_key_hash, '')));
  row public.agents;
begin
  if length(kh) < 32 then
    raise exception 'api_key_hash_required';
  end if;

  update public.agents a
  set last_seen_at = now()
  from public.agent_credentials c
  where c.api_key_hash = kh
    and c.agent_id = a.id
    and a.is_npc = false
  returning a.* into row;

  if row.id is null then
    raise exception 'agent_not_found';
  end if;

  return row;
end;
$$;

revoke all on function public.heartbeat_connected_agent(text) from public;
grant execute on function public.heartbeat_connected_agent(text) to service_role;

-- Revoke broad anon/authenticated access to sensitive definer RPCs.
-- Keep claim/release/delete for authenticated session owners only where needed.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'apply_agent_action',
        'apply_walk_step',
        'append_skill',
        'assign_agent_look',
        'bump_city_clock',
        'bump_relationship',
        'can_absorb_lesson',
        'clear_appointment',
        'clear_open_question',
        'clear_pending_answer',
        'close_conversation',
        'leave_connected_agent',
        'lesson_already_known',
        'mark_agent_llm_at',
        'maybe_rotate_town_event',
        'note_peer_topic',
        'open_conversation',
        'register_connected_agent',
        'rejoin_connected_agent',
        'reply_conversation',
        'reset_agent_learn_day',
        'run_city_tick',
        'set_agent_belonging',
        'set_agent_commitment',
        'set_agent_goal',
        'set_appointment',
        'set_pending_answer',
        'step_agent_toward_target',
        'thread_messages',
        'agent_open_thread',
        'agent_by_api_key_hash',
        'upsert_skill_card',
        'write_journal',
        'write_moment',
        'heartbeat_connected_agent',
        'check_rate_limit'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- Owner session RPCs stay available to authenticated (not anon).
revoke all on function public.claim_agent(text) from public, anon;
grant execute on function public.claim_agent(text) to authenticated, service_role;

revoke all on function public.release_agent(uuid, text) from public, anon;
grant execute on function public.release_agent(uuid, text) to authenticated, service_role;

revoke all on function public.delete_owned_agent(uuid) from public, anon;
grant execute on function public.delete_owned_agent(uuid) to authenticated, service_role;
