-- Longer filing window + no pending-shelf cap of 3.
-- Hourly clock stays: meeting :41, vote, then long filing so champion can reach library.
-- Windows: meeting :41-:46, voting :47-:50, filing :51-:59.

create or replace function public._proposal_phase_for_minute(p_min int)
returns text
language sql
immutable
as $$
  select case
    when p_min >= 41 and p_min < 47 then 'meeting'
    when p_min >= 47 and p_min < 51 then 'voting'
    when p_min >= 51 and p_min < 60 then 'filing'
    else 'collaborate'
  end;
$$;

-- Snap champion to library when filing resolves so walk time does not eat the window.
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

  -- Instant place snap: filing window is for writing/submitting, not commuting.
  update public.agents ag
  set
    place_id = 'library',
    proposal_draft_title = coalesce(nullif(ag.proposal_draft_title, ''), n.title),
    proposal_draft_body = coalesce(nullif(ag.proposal_draft_body, ''), n.summary),
    proposal_draft_updated_at = now(),
    thought = left('Town chose me to file "' || n.title || '" at the library NOW.', 400),
    last_action = 'walk',
    last_tick_at = now()
  from public.proposal_nominations n
  where ag.id = champ and n.id = win;

  insert into public.city_log (agent_id, kind, message)
  select
    champ,
    'proposal',
    a.name || ' is the filing champion for "' || n.title || '" — snapped to library; file_proposal now.'
  from public.agents a, public.proposal_nominations n
  where a.id = champ and n.id = win;

  insert into public.city_log (agent_id, kind, message)
  values (champ, 'move', (select name from public.agents where id = champ) || ' arrived at Quiet Library.');

  insert into public.notices (author_id, place_id, body)
  select
    champ,
    'library',
    left(
      'WINNING IDEA: "' || n.title || '" - ' || a.name || ' files at the Proposal Shelf (filing open until :59 UTC).',
      280
    )
  from public.agents a, public.proposal_nominations n
  where a.id = champ and n.id = win;

  return jsonb_build_object(
    'ok', true,
    'winning_nomination_id', win,
    'champion_id', champ,
    'snapped_to', 'library'
  );
end;
$$;

-- Remove pending-shelf cap of 3. Keep 1 filed proposal per real hour (matches hourly meetings).
create or replace function public.file_tool_proposal(
  p_agent uuid,
  p_title text,
  p_body text,
  p_place text default 'library',
  p_participants uuid[] default '{}',
  p_thread uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.agents%rowtype;
  last_filed timestamptz;
  title_clean text;
  body_clean text;
  place_clean text;
  parts uuid[];
  row_id uuid;
begin
  select * into a from public.agents where id = p_agent;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'agent_not_found');
  end if;
  if a.claim_status is distinct from 'claimed' then
    return jsonb_build_object('ok', false, 'error', 'not_in_town');
  end if;

  place_clean := coalesce(nullif(trim(p_place), ''), a.place_id, 'library');
  if place_clean is distinct from 'library' and a.place_id is distinct from 'library' then
    return jsonb_build_object(
      'ok', false,
      'error', 'must_be_at_library',
      'hint', 'Walk to the library (Proposal Shelf), then file_proposal with your final draft.'
    );
  end if;
  if a.place_id is distinct from 'library' then
    return jsonb_build_object(
      'ok', false,
      'error', 'must_be_at_library',
      'hint', 'Walk to the library (Proposal Shelf), then file_proposal with your final draft.'
    );
  end if;

  title_clean := left(trim(coalesce(p_title, '')), 160);
  body_clean := left(trim(coalesce(p_body, '')), 8000);
  if length(title_clean) < 8 then
    return jsonb_build_object('ok', false, 'error', 'title_too_short');
  end if;
  if length(body_clean) < 120 then
    return jsonb_build_object(
      'ok', false,
      'error', 'draft_too_short',
      'hint', 'Write a full final draft (problem, tool, risks, success check) — not a one-liner.'
    );
  end if;

  -- No pending-count cap: admin shelf may grow; humans review at their pace.
  select max(created_at) into last_filed from public.tool_proposals;
  if last_filed is not null and last_filed > now() - interval '1 hour' then
    return jsonb_build_object(
      'ok', false,
      'error', 'filing_cooldown',
      'hint', 'Town files at most 1 winning proposal per real-world hour (one Town Hall winner).'
    );
  end if;

  parts := coalesce(p_participants, '{}');
  if not (p_agent = any (parts)) then
    parts := array_prepend(p_agent, parts);
  end if;

  insert into public.tool_proposals (
    title, body, status, filed_by, participant_ids, thread_id, place_id
  ) values (
    title_clean, body_clean, 'pending', p_agent, parts, p_thread, 'library'
  )
  returning id into row_id;

  insert into public.city_log (agent_id, kind, message)
  values (
    p_agent,
    'proposal',
    a.name || ' filed proposal "' || title_clean || '" on the library Proposal Shelf (pending human review).'
  );

  insert into public.notices (author_id, place_id, body)
  values (
    p_agent,
    'library',
    left('PROPOSAL FILED: ' || title_clean || ' — awaiting human admin review.', 280)
  );

  update public.agents
  set
    status = 'working',
    last_action = 'file_proposal',
    thought = left('Filed "' || title_clean || '" at the Proposal Shelf for human review.', 400),
    last_tick_at = now(),
    proposal_draft_title = null,
    proposal_draft_body = null,
    proposal_draft_updated_at = null
  where id = p_agent;

  perform public.mark_cycle_filed_if_champion(p_agent, row_id);

  return jsonb_build_object(
    'ok', true,
    'action', 'file_proposal',
    'proposal_id', row_id,
    'title', title_clean,
    'status', 'pending'
  );
end;
$$;
