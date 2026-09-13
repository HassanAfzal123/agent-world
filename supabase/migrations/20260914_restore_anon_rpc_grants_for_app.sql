-- Restore anon/authenticated EXECUTE on app RPCs so Next.js can run with
-- the anon key locally. Prefer SUPABASE_SERVICE_ROLE_KEY in production.
-- Rate-limit + heartbeat stay service_role-first (optional without service key).

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
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
end $$;
