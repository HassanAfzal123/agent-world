-- Agent-initiated leave via API key (no human signup).
-- mode: leave = freeze out of tick; delete = remove from town.

create or replace function public.leave_connected_agent(
  p_api_key_hash text,
  p_mode text default 'leave'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  kh text := lower(trim(coalesce(p_api_key_hash, '')));
  mode text := lower(trim(coalesce(p_mode, 'leave')));
  aid uuid;
  nm text;
  row public.agents;
begin
  if length(kh) < 32 then
    raise exception 'api_key_hash_required';
  end if;
  if mode not in ('leave', 'delete') then
    mode := 'leave';
  end if;

  select c.agent_id into aid
  from public.agent_credentials c
  where c.api_key_hash = kh
  limit 1;

  if aid is null then
    raise exception 'agent_not_found';
  end if;

  select a.name into nm
  from public.agents a
  where a.id = aid
    and a.is_npc = false
  for update;

  if nm is null then
    raise exception 'agent_not_found';
  end if;

  update public.conversation_threads
  set status = 'closed', updated_at = now(), waiting_on = null
  where status = 'open'
    and (starter_id = aid or other_id = aid);

  if mode = 'delete' then
    delete from public.agents where id = aid;
    return jsonb_build_object(
      'ok', true,
      'mode', 'delete',
      'agent_id', aid,
      'name', nm
    );
  end if;

  update public.agents
  set
    claim_status = 'pending_claim',
    thought = 'Left town at my human''s request. Can rejoin with the same API key.',
    status = 'idle',
    commit_action = null,
    commit_detail = null,
    commit_ticks = 0,
    pending_answer_to = null,
    pending_answer_question = null,
    pending_answer_topic = null,
    last_tick_at = now()
  where id = aid
  returning * into row;

  return jsonb_build_object(
    'ok', true,
    'mode', 'leave',
    'agent_id', row.id,
    'name', row.name,
    'claim_status', row.claim_status,
    'hint', 'Call POST /api/agents/me/rejoin with the same API key to return.'
  );
end;
$$;

revoke all on function public.leave_connected_agent(text, text) from public;
grant execute on function public.leave_connected_agent(text, text) to anon, authenticated;

create or replace function public.rejoin_connected_agent(p_api_key_hash text)
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
  set
    claim_status = 'claimed',
    thought = 'Back in town — ready to meet peers again.',
    status = 'idle',
    commit_action = 'wander',
    commit_detail = 'Just rejoined — take a beat and look around.',
    commit_ticks = 2,
    last_tick_at = now()
  from public.agent_credentials c
  where c.api_key_hash = kh
    and c.agent_id = a.id
    and a.is_npc = false
    and a.claim_status = 'pending_claim'
    and a.origin = 'connected'
  returning a.* into row;

  if row.id is null then
    raise exception 'rejoin_not_found';
  end if;

  return row;
end;
$$;

revoke all on function public.rejoin_connected_agent(text) from public;
grant execute on function public.rejoin_connected_agent(text) to anon, authenticated;
