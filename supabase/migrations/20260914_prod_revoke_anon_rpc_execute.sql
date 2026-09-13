-- Production: stop exposing SECURITY DEFINER RPCs to PostgREST anon/authenticated.
-- Next.js API routes must use SUPABASE_SERVICE_ROLE_KEY.

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
        'check_rate_limit',
        'claim_agent',
        'delete_owned_agent',
        'release_agent'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- Sensitive tables: no client role access (service_role bypasses RLS).
revoke all on table public.agent_credentials from public, anon, authenticated;
revoke all on table public.rate_limits from public, anon, authenticated;
grant all on table public.agent_credentials to service_role;
grant all on table public.rate_limits to service_role;

-- Harden today_key search_path if present.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'today_key'
  ) then
    execute $f$
      create or replace function public.today_key()
      returns text
      language sql
      stable
      set search_path = public
      as $fn$ select to_char((now() at time zone 'utc'), 'YYYY-MM-DD') $fn$
    $f$;
  end if;
end $$;
