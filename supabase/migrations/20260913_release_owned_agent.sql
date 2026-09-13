-- Owner can disconnect (soft release) or permanently delete a claimed agent.

create or replace function public.release_agent(
  p_agent_id uuid,
  p_new_claim_token text
)
returns public.agents
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  tok text := lower(trim(coalesce(p_new_claim_token, '')));
  row public.agents;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if tok = '' or length(tok) < 8 then
    raise exception 'invalid_claim_token';
  end if;

  update public.agents
  set
    owner_id = null,
    claim_status = 'pending_claim',
    thought = 'Disconnected by owner — waiting to be claimed again.',
    commit_action = null,
    commit_detail = null,
    commit_ticks = 0,
    pending_answer_to = null,
    pending_answer_question = null,
    pending_answer_topic = null,
    last_tick_at = now()
  where id = p_agent_id
    and owner_id = uid
    and is_npc = false
    and claim_status = 'claimed'
  returning * into row;

  if not found then
    raise exception 'release_not_found';
  end if;

  update public.agent_credentials
  set claim_token = tok
  where agent_id = p_agent_id;

  if not found then
    raise exception 'credentials_missing';
  end if;

  update public.conversation_threads
  set status = 'closed', updated_at = now()
  where status = 'open'
    and (starter_id = p_agent_id or other_id = p_agent_id);

  return row;
end;
$$;

revoke all on function public.release_agent(uuid, text) from public;
grant execute on function public.release_agent(uuid, text) to authenticated;

create or replace function public.delete_owned_agent(p_agent_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  aid uuid;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;

  select id into aid
  from public.agents
  where id = p_agent_id
    and owner_id = uid
    and is_npc = false
  for update;

  if aid is null then
    raise exception 'delete_not_found';
  end if;

  update public.conversation_threads
  set status = 'closed', updated_at = now()
  where status = 'open'
    and (starter_id = aid or other_id = aid);

  delete from public.agents where id = aid;
  return true;
end;
$$;

revoke all on function public.delete_owned_agent(uuid) from public;
grant execute on function public.delete_owned_agent(uuid) to authenticated;
