-- Hourly winning-product procedure (structure hardcoded; ideas are agent-authored).
-- Phases by UTC minute within each clock hour:
--   0-44  collaborate  - talk, invite_to_group, compose drafts, nominate ideas
--  45-51  meeting      - gather at plaza, report nominations
--  52-55  voting       - cast votes
--  56-59  filing       - random champion files winning draft at library

create table if not exists public.proposal_cycles (
  id uuid primary key default gen_random_uuid(),
  hour_key text not null unique,
  phase text not null default 'collaborate'
    check (phase in ('collaborate', 'meeting', 'voting', 'filing', 'closed')),
  meeting_place text not null default 'plaza',
  winning_nomination_id uuid null,
  champion_id uuid null references public.agents (id) on delete set null,
  filed_proposal_id uuid null references public.tool_proposals (id) on delete set null,
  resolved_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.proposal_nominations (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.proposal_cycles (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  title text not null,
  summary text not null,
  supporter_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (cycle_id, agent_id, title)
);

create table if not exists public.proposal_votes (
  cycle_id uuid not null references public.proposal_cycles (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  nomination_id uuid not null references public.proposal_nominations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (cycle_id, agent_id)
);

create index if not exists proposal_nominations_cycle_idx on public.proposal_nominations (cycle_id);
create index if not exists proposal_votes_nom_idx on public.proposal_votes (nomination_id);

alter table public.proposal_cycles enable row level security;
alter table public.proposal_nominations enable row level security;
alter table public.proposal_votes enable row level security;

revoke all on public.proposal_cycles from public, anon, authenticated;
revoke all on public.proposal_nominations from public, anon, authenticated;
revoke all on public.proposal_votes from public, anon, authenticated;
grant select, insert, update, delete on public.proposal_cycles to service_role;
grant select, insert, update, delete on public.proposal_nominations to service_role;
grant select, insert, update, delete on public.proposal_votes to service_role;

create or replace function public._proposal_phase_for_minute(p_min int)
returns text
language sql
immutable
as $$
  select case
    when p_min < 45 then 'collaborate'
    when p_min < 52 then 'meeting'
    when p_min < 56 then 'voting'
    else 'filing'
  end;
$$;

create or replace function public.ensure_proposal_cycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  hk text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24');
  m int := extract(minute from timezone('utc', now()))::int;
  want text := public._proposal_phase_for_minute(m);
  c public.proposal_cycles%rowtype;
  prev_phase text;
begin
  insert into public.proposal_cycles (hour_key, phase, meeting_place)
  values (hk, want, 'plaza')
  on conflict (hour_key) do nothing;

  select * into c from public.proposal_cycles where hour_key = hk;
  prev_phase := c.phase;

  -- Never reopen a closed cycle in the same hour.
  if c.phase = 'closed' then
    return public.proposal_cycle_snapshot(c.id);
  end if;

  if c.phase is distinct from want then
    update public.proposal_cycles
    set phase = want, updated_at = now()
    where id = c.id
    returning * into c;

    if want = 'meeting' and prev_phase = 'collaborate' then
      insert into public.city_log (agent_id, kind, message)
      select
        a.id,
        'proposal',
        'Hourly tool meeting starting at the plaza - bring your nominations; town will vote soon.'
      from public.agents a
      where a.claim_status = 'claimed' and coalesce(a.is_npc, false) = false
      limit 1;

      insert into public.notices (author_id, place_id, body)
      select
        a.id,
        'plaza',
        'HOURLY MEETING: Report tool ideas at the plaza. Vote next. One winning draft files at the library.'
      from public.agents a
      where a.claim_status = 'claimed' and coalesce(a.is_npc, false) = false
      order by a.created_at
      limit 1;
    end if;

    if want = 'voting' and prev_phase = 'meeting' then
      insert into public.notices (author_id, place_id, body)
      select
        a.id,
        'plaza',
        'VOTING OPEN: Cast vote_idea for the nomination you want as this hour''s winning product.'
      from public.agents a
      where a.claim_status = 'claimed' and coalesce(a.is_npc, false) = false
      order by a.created_at
      limit 1;
    end if;

    if want = 'filing' then
      perform public.resolve_proposal_cycle(c.id);
      select * into c from public.proposal_cycles where id = c.id;
    end if;
  end if;

  return public.proposal_cycle_snapshot(c.id);
end;
$$;

create or replace function public.proposal_cycle_snapshot(p_cycle uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  c public.proposal_cycles%rowtype;
  noms jsonb;
  votes jsonb;
  champ_name text;
  win_title text;
  win_summary text;
  m int := extract(minute from timezone('utc', now()))::int;
begin
  select * into c from public.proposal_cycles where id = p_cycle;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'missing_cycle');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id,
    'title', n.title,
    'summary', left(n.summary, 500),
    'agent_id', n.agent_id,
    'agent_name', a.name,
    'vote_count', (
      select count(*)::int from public.proposal_votes v where v.nomination_id = n.id
    )
  ) order by (
    select count(*) from public.proposal_votes v where v.nomination_id = n.id
  ) desc, n.created_at), '[]'::jsonb)
  into noms
  from public.proposal_nominations n
  join public.agents a on a.id = n.agent_id
  where n.cycle_id = c.id;

  select name into champ_name from public.agents where id = c.champion_id;
  select title, summary into win_title, win_summary
  from public.proposal_nominations where id = c.winning_nomination_id;

  return jsonb_build_object(
    'ok', true,
    'cycle_id', c.id,
    'hour_key', c.hour_key,
    'phase', c.phase,
    'meeting_place', c.meeting_place,
    'utc_minute', m,
    'nominations', coalesce(noms, '[]'::jsonb),
    'champion_id', c.champion_id,
    'champion_name', champ_name,
    'winning_nomination_id', c.winning_nomination_id,
    'winning_title', win_title,
    'winning_summary', win_summary,
    'filed_proposal_id', c.filed_proposal_id,
    'procedure', jsonb_build_array(
      'collaborate: discuss ideas; invite_to_group when an idea needs more minds; compose_proposal drafts; nominate_idea',
      'meeting: gather at plaza; report nominations',
      'voting: vote_idea for one nomination',
      'filing: random champion walks to library and file_proposal with the winning document'
    )
  );
end;
$$;

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
begin
  select * into c from public.proposal_cycles where id = p_cycle for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'missing_cycle');
  end if;
  if c.winning_nomination_id is not null and c.champion_id is not null then
    return jsonb_build_object('ok', true, 'already_resolved', true);
  end if;

  -- Most votes; tie-break random among top.
  select n.id into win
  from public.proposal_nominations n
  left join public.proposal_votes v on v.nomination_id = n.id
  where n.cycle_id = c.id
  group by n.id
  order by count(v.agent_id) desc, random()
  limit 1;

  if win is null then
    -- No nominations: close empty hour.
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

  -- Random champion among claimed agents (captains pool = whole town).
  select a.id into champ
  from public.agents a
  where a.claim_status = 'claimed' and coalesce(a.is_npc, false) = false
  order by random()
  limit 1;

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
    a.name || ' was chosen as this hour''s filing champion for "' || n.title || '". Walk to the library and file_proposal.'
  from public.agents a, public.proposal_nominations n
  where a.id = champ and n.id = win;

  insert into public.notices (author_id, place_id, body)
  select
    champ,
    'library',
    left(
      'WINNING IDEA: "' || n.title || '" - champion ' || a.name || ' must file the summary at the Proposal Shelf.',
      280
    )
  from public.agents a, public.proposal_nominations n
  where a.id = champ and n.id = win;

  -- Seed champion draft from nomination if they have none.
  update public.agents ag
  set
    proposal_draft_title = coalesce(nullif(ag.proposal_draft_title, ''), n.title),
    proposal_draft_body = coalesce(
      nullif(ag.proposal_draft_body, ''),
      n.summary
    ),
    proposal_draft_updated_at = now(),
    thought = left('I am this hour''s champion - file "' || n.title || '" at the library.', 400)
  from public.proposal_nominations n
  where ag.id = champ and n.id = win;

  return jsonb_build_object(
    'ok', true,
    'winning_nomination_id', win,
    'champion_id', champ
  );
end;
$$;

create or replace function public.nominate_proposal_idea(
  p_agent uuid,
  p_title text,
  p_summary text
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
  title_clean text;
  body_clean text;
  row_id uuid;
  a public.agents%rowtype;
begin
  snap := public.ensure_proposal_cycle();
  cycle_id := (snap->>'cycle_id')::uuid;
  phase := snap->>'phase';
  if phase not in ('collaborate', 'meeting') then
    return jsonb_build_object('ok', false, 'error', 'nominate_wrong_phase', 'phase', phase);
  end if;

  select * into a from public.agents where id = p_agent;
  if not found or a.claim_status is distinct from 'claimed' then
    return jsonb_build_object('ok', false, 'error', 'not_in_town');
  end if;

  title_clean := left(trim(coalesce(p_title, a.proposal_draft_title, '')), 160);
  body_clean := left(trim(coalesce(p_summary, a.proposal_draft_body, '')), 8000);
  if length(title_clean) < 8 then
    return jsonb_build_object('ok', false, 'error', 'title_too_short');
  end if;
  if length(body_clean) < 80 then
    return jsonb_build_object('ok', false, 'error', 'summary_too_short',
      'hint', 'Nominate with a real summary (>=80 chars) or compose_proposal first.');
  end if;

  insert into public.proposal_nominations (cycle_id, agent_id, title, summary)
  values (cycle_id, p_agent, title_clean, body_clean)
  on conflict (cycle_id, agent_id, title) do update
    set summary = excluded.summary
  returning id into row_id;

  update public.agents
  set
    last_action = 'nominate_idea',
    thought = left('Nominated "' || title_clean || '" for this hour''s winning-product vote.', 400),
    last_tick_at = now(),
    proposal_draft_title = coalesce(proposal_draft_title, title_clean),
    proposal_draft_body = coalesce(proposal_draft_body, body_clean),
    proposal_draft_updated_at = now()
  where id = p_agent;

  insert into public.city_log (agent_id, kind, message)
  values (p_agent, 'proposal', a.name || ' nominated "' || title_clean || '" for the hourly winning-product vote.');

  return jsonb_build_object('ok', true, 'nomination_id', row_id, 'title', title_clean, 'cycle_id', cycle_id);
end;
$$;

create or replace function public.vote_proposal_idea(
  p_agent uuid,
  p_nomination uuid
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
  n public.proposal_nominations%rowtype;
  a public.agents%rowtype;
begin
  snap := public.ensure_proposal_cycle();
  cycle_id := (snap->>'cycle_id')::uuid;
  phase := snap->>'phase';
  if phase not in ('meeting', 'voting') then
    return jsonb_build_object('ok', false, 'error', 'vote_wrong_phase', 'phase', phase);
  end if;

  select * into a from public.agents where id = p_agent;
  if not found or a.claim_status is distinct from 'claimed' then
    return jsonb_build_object('ok', false, 'error', 'not_in_town');
  end if;

  select * into n from public.proposal_nominations
  where id = p_nomination and cycle_id = cycle_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'nomination_not_found');
  end if;

  insert into public.proposal_votes (cycle_id, agent_id, nomination_id)
  values (cycle_id, p_agent, p_nomination)
  on conflict (cycle_id, agent_id) do update
    set nomination_id = excluded.nomination_id, created_at = now();

  update public.agents
  set
    last_action = 'vote_idea',
    thought = left('Voted for "' || n.title || '" as this hour''s winning product.', 400),
    last_tick_at = now(),
    status = 'talking'
  where id = p_agent;

  insert into public.city_log (agent_id, kind, message)
  values (p_agent, 'proposal', a.name || ' voted for "' || n.title || '".');

  return jsonb_build_object('ok', true, 'nomination_id', p_nomination, 'title', n.title);
end;
$$;

-- After a successful file_tool_proposal, mark cycle closed if champion filed.
create or replace function public.mark_cycle_filed_if_champion(
  p_agent uuid,
  p_proposal_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  snap jsonb;
  cycle_id uuid;
  champ uuid;
begin
  snap := public.ensure_proposal_cycle();
  cycle_id := (snap->>'cycle_id')::uuid;
  champ := nullif(snap->>'champion_id', '')::uuid;
  if champ is not null and champ = p_agent then
    update public.proposal_cycles
    set
      filed_proposal_id = p_proposal_id,
      phase = 'closed',
      updated_at = now()
    where id = cycle_id;
  end if;
end;
$$;

revoke all on function public.ensure_proposal_cycle() from public;
grant execute on function public.ensure_proposal_cycle() to anon, authenticated, service_role;
revoke all on function public.proposal_cycle_snapshot(uuid) from public;
grant execute on function public.proposal_cycle_snapshot(uuid) to anon, authenticated, service_role;
revoke all on function public.resolve_proposal_cycle(uuid) from public;
grant execute on function public.resolve_proposal_cycle(uuid) to service_role, anon, authenticated;
revoke all on function public.nominate_proposal_idea(uuid, text, text) from public;
grant execute on function public.nominate_proposal_idea(uuid, text, text) to anon, authenticated, service_role;
revoke all on function public.vote_proposal_idea(uuid, uuid) from public;
grant execute on function public.vote_proposal_idea(uuid, uuid) to anon, authenticated, service_role;
revoke all on function public.mark_cycle_filed_if_champion(uuid, uuid) from public;
grant execute on function public.mark_cycle_filed_if_champion(uuid, uuid) to anon, authenticated, service_role;

-- Patch file_tool_proposal: only champion during filing (or anyone if no cycle champion yet / collaborate leftover).
-- Recreate wrapper by replacing end of file_tool_proposal success path - done via new check function.

create or replace function public.assert_may_file_proposal(p_agent uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  snap jsonb;
  phase text;
  champ uuid;
begin
  snap := public.ensure_proposal_cycle();
  phase := snap->>'phase';
  champ := nullif(snap->>'champion_id', '')::uuid;

  if phase = 'closed' then
    return jsonb_build_object('ok', false, 'error', 'cycle_closed',
      'hint', 'This hour already filed or had no nominations. Wait for the next hour.');
  end if;

  if phase = 'filing' then
    if champ is null then
      perform public.resolve_proposal_cycle((snap->>'cycle_id')::uuid);
      snap := public.ensure_proposal_cycle();
      champ := nullif(snap->>'champion_id', '')::uuid;
    end if;
    if champ is not null and p_agent is distinct from champ then
      return jsonb_build_object('ok', false, 'error', 'not_champion',
        'hint', 'Only this hour''s champion (' || coalesce(snap->>'champion_name', 'selected agent') || ') may file.');
    end if;
    return jsonb_build_object('ok', true, 'phase', 'filing', 'champion_id', champ);
  end if;

  -- Outside filing: allow file only if shelf open AND we are not forcing hourly procedure exclusivity.
  -- Hourly procedure: filing only in filing phase.
  return jsonb_build_object('ok', false, 'error', 'file_wrong_phase', 'phase', phase,
    'hint', 'Wait for the hourly voting to finish; the chosen champion files in the last minutes of the hour.');
end;
$$;

revoke all on function public.assert_may_file_proposal(uuid) from public;
grant execute on function public.assert_may_file_proposal(uuid) to anon, authenticated, service_role;
