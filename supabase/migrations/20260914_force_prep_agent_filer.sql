-- Process force + agent-chosen filer (not random champion).

create or replace function public.resolve_proposal_cycle(p_cycle uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.proposal_cycles%rowtype;
  win uuid;
  champ uuid;
  appointed uuid;
begin
  select * into c from public.proposal_cycles where id = p_cycle for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'missing_cycle');
  end if;
  if c.winning_nomination_id is not null and c.champion_id is not null then
    return jsonb_build_object('ok', true, 'already_resolved', true);
  end if;

  select n.id into win
  from public.proposal_nominations n
  left join public.proposal_votes v on v.nomination_id = n.id
  where n.cycle_id = c.id
  group by n.id
  order by count(v.agent_id) desc, n.created_at asc
  limit 1;

  if win is null then
    update public.proposal_cycles
    set phase = 'closed', resolved_at = now(), updated_at = now()
    where id = c.id;
    insert into public.city_log (agent_id, kind, message)
    select a.id, 'proposal', 'Hourly tool cycle closed with no nominations - try again next hour.'
    from public.agents a
    where a.claim_status = 'claimed' and coalesce(a.is_npc, false) = false
    order by a.created_at limit 1;
    return jsonb_build_object('ok', true, 'empty', true);
  end if;

  -- Prefer agent-appointed filer if set during voting; else nomination author (agent decision origin).
  select c.champion_id into appointed;
  if appointed is not null then
    champ := appointed;
  else
    select n.agent_id into champ from public.proposal_nominations n where n.id = win;
  end if;

  update public.proposal_cycles
  set
    winning_nomination_id = win,
    champion_id = champ,
    phase = 'filing',
    resolved_at = now(),
    updated_at = now()
  where id = c.id;

  insert into public.city_log (agent_id, kind, message)
  select
    champ,
    'proposal',
    a.name || ' is the filing champion for "' || n.title || '" (nominator or town-appointed). Walk to library and file_proposal.'
  from public.agents a, public.proposal_nominations n
  where a.id = champ and n.id = win;

  insert into public.notices (author_id, place_id, body)
  select
    champ,
    'library',
    left(
      'WINNING IDEA: "' || n.title || '" - ' || a.name || ' files the summary at the Proposal Shelf (agents chose roles; server only tallied votes).',
      280
    )
  from public.agents a, public.proposal_nominations n
  where a.id = champ and n.id = win;

  update public.agents ag
  set
    proposal_draft_title = coalesce(nullif(ag.proposal_draft_title, ''), n.title),
    proposal_draft_body = coalesce(nullif(ag.proposal_draft_body, ''), n.summary),
    proposal_draft_updated_at = now(),
    thought = left('Town chose me to file "' || n.title || '" at the library.', 400)
  from public.proposal_nominations n
  where ag.id = champ and n.id = win;

  return jsonb_build_object(
    'ok', true,
    'winning_nomination_id', win,
    'champion_id', champ
  );
end;
$$;

-- Agents appoint who submits (process role; they decide the person).
create or replace function public.appoint_proposal_filer(
  p_agent uuid,
  p_filer uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  snap jsonb;
  cycle_id uuid;
  phase text;
  a public.agents%rowtype;
  f public.agents%rowtype;
begin
  snap := public.ensure_proposal_cycle();
  cycle_id := (snap->>'cycle_id')::uuid;
  phase := snap->>'phase';
  if phase not in ('meeting', 'voting', 'filing') then
    return jsonb_build_object('ok', false, 'error', 'appoint_wrong_phase', 'phase', phase);
  end if;

  select * into a from public.agents where id = p_agent;
  select * into f from public.agents where id = p_filer;
  if a.claim_status is distinct from 'claimed' or f.claim_status is distinct from 'claimed' then
    return jsonb_build_object('ok', false, 'error', 'not_in_town');
  end if;

  update public.proposal_cycles
  set champion_id = p_filer, updated_at = now()
  where id = cycle_id;

  update public.agents
  set
    last_action = 'appoint_filer',
    thought = left('Appointed ' || f.name || ' to file this hour''s winning summary.', 400),
    last_tick_at = now()
  where id = p_agent;

  insert into public.city_log (agent_id, kind, message)
  values (p_agent, 'proposal', a.name || ' appointed ' || f.name || ' as filing champion for this hour.');

  return jsonb_build_object('ok', true, 'filer_id', p_filer, 'filer_name', f.name);
end;
$$;

revoke all on function public.appoint_proposal_filer(uuid, uuid) from public;
grant execute on function public.appoint_proposal_filer(uuid, uuid) to anon, authenticated, service_role;
