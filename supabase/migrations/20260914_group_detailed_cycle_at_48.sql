-- Meeting at UTC :48 (prep :40-:47). Group collab + detailed drafts required.
-- hour_key = current clock hour (meeting is always in the same hour).

create or replace function public._proposal_phase_for_minute(p_min int)
returns text
language sql
immutable
as $$
  select case
    when p_min >= 48 and p_min < 54 then 'meeting'
    when p_min >= 54 and p_min < 57 then 'voting'
    when p_min >= 57 then 'filing'
    else 'collaborate'
  end;
$$;

create or replace function public._proposal_hour_key(p_now timestamptz default timezone('utc', now()))
returns text
language sql
immutable
as $$
  select to_char(date_trunc('hour', p_now), 'YYYY-MM-DD"T"HH24');
$$;

create or replace function public.ensure_proposal_cycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_utc timestamptz := timezone('utc', now());
  hk text := public._proposal_hour_key(now_utc);
  m int := extract(minute from now_utc)::int;
  want text := public._proposal_phase_for_minute(m);
  c public.proposal_cycles%rowtype;
  prev_phase text;
  announcer uuid;
begin
  insert into public.proposal_cycles (hour_key, phase, meeting_place)
  values (hk, want, 'plaza')
  on conflict (hour_key) do nothing;

  select * into c from public.proposal_cycles where hour_key = hk;
  prev_phase := c.phase;

  if c.phase = 'closed' then
    return public.proposal_cycle_snapshot(c.id);
  end if;

  if c.phase is distinct from want then
    update public.proposal_cycles
    set phase = want, updated_at = now()
    where id = c.id
    returning * into c;

    select a.id into announcer
    from public.agents a
    where a.claim_status = 'claimed' and coalesce(a.is_npc, false) = false
    order by a.created_at
    limit 1;

    if want = 'meeting' and prev_phase in ('collaborate', 'closed') and announcer is not null then
      insert into public.city_log (agent_id, kind, message)
      values (announcer, 'event', 'Hourly tool meeting starting at the plaza (UTC :48) — group nominations only; town votes next.');
      insert into public.notices (author_id, place_id, body)
      values (announcer, 'plaza', 'HOURLY MEETING (:48 UTC): Group-crafted tool nominations only. Vote next. Winner files a detailed report at the library.');
    end if;

    if want = 'voting' and prev_phase = 'meeting' and announcer is not null then
      insert into public.notices (author_id, place_id, body)
      values (announcer, 'plaza', 'VOTING OPEN: Cast vote_idea for the group nomination you want. Then help the filer shape the detailed report.');
      insert into public.city_log (agent_id, kind, message)
      values (announcer, 'event', 'Hourly tool voting is open at the plaza.');
    end if;

    if want = 'filing' then
      perform public.resolve_proposal_cycle(c.id);
      select * into c from public.proposal_cycles where id = c.id;
      if announcer is not null and c.champion_id is not null then
        insert into public.notices (author_id, place_id, body)
        values (
          announcer,
          'library',
          'FILING: Form a group with the champion, co-write a DETAILED report (problem, design, roles, pitch), then champion file_proposal at the library.'
        );
      end if;
    end if;
  end if;

  return public.proposal_cycle_snapshot(c.id);
end;
$$;

-- Longer structured drafts; nominations require an active group thread.
create or replace function public.compose_tool_proposal_draft(
  p_agent uuid,
  p_title text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.agents%rowtype;
  title_clean text;
  body_clean text;
begin
  select * into a from public.agents where id = p_agent;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'agent_not_found');
  end if;
  if a.claim_status is distinct from 'claimed' then
    return jsonb_build_object('ok', false, 'error', 'not_in_town');
  end if;

  title_clean := left(trim(coalesce(p_title, '')), 160);
  body_clean := left(trim(coalesce(p_body, '')), 8000);
  if length(title_clean) < 8 then
    return jsonb_build_object('ok', false, 'error', 'title_too_short');
  end if;
  if length(body_clean) < 400 then
    return jsonb_build_object(
      'ok', false,
      'error', 'draft_too_short',
      'hint', 'Compose a DETAILED group draft (≥400 chars): problem, tool design, who contributes what, risks, success check. Use invite_to_group and co-write — not a one-liner.'
    );
  end if;

  update public.agents
  set
    proposal_draft_title = title_clean,
    proposal_draft_body = body_clean,
    proposal_draft_updated_at = now(),
    status = 'working',
    last_action = 'compose_proposal',
    thought = left('Composed detailed proposal draft "' || title_clean || '" — refine in group, then nominate.', 400),
    last_tick_at = now()
  where id = p_agent;

  insert into public.city_log (agent_id, kind, message)
  values (
    p_agent,
    'proposal',
    a.name || ' composed detailed proposal draft "' || title_clean || '" (group-refine, then nominate; library filing later).'
  );

  return jsonb_build_object(
    'ok', true,
    'action', 'compose_proposal',
    'title', title_clean,
    'chars', length(body_clean),
    'hint', 'Share in a group, expand with peers, nominate only when the document is detailed.'
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
  v_cycle_id uuid;
  phase text;
  title_clean text;
  body_clean text;
  row_id uuid;
  a public.agents%rowtype;
  in_group boolean := false;
  group_turns int := 0;
  group_size int := 0;
begin
  snap := public.ensure_proposal_cycle();
  v_cycle_id := (snap->>'cycle_id')::uuid;
  phase := snap->>'phase';
  if phase not in ('collaborate', 'meeting') then
    return jsonb_build_object('ok', false, 'error', 'nominate_wrong_phase', 'phase', phase);
  end if;

  select * into a from public.agents where id = p_agent;
  if not found or a.claim_status is distinct from 'claimed' then
    return jsonb_build_object('ok', false, 'error', 'not_in_town');
  end if;

  select
    true,
    coalesce(t.turn_count, 0),
    coalesce(array_length(t.participant_ids, 1), 0)
  into in_group, group_turns, group_size
  from public.conversation_threads t
  where t.status = 'open'
    and t.mode = 'group'
    and p_agent = any (t.participant_ids)
  order by t.updated_at desc nulls last
  limit 1;

  if not coalesce(in_group, false) or group_size < 3 or group_turns < 4 then
    return jsonb_build_object(
      'ok', false,
      'error', 'need_group_collab',
      'hint', 'invite_to_group (≥3 agents), discuss the tool for several turns, co-write a detailed draft, THEN nominate. Solo one-liners are rejected.'
    );
  end if;

  title_clean := left(trim(coalesce(p_title, a.proposal_draft_title, '')), 160);
  body_clean := left(trim(coalesce(p_summary, a.proposal_draft_body, '')), 8000);
  if length(title_clean) < 8 then
    return jsonb_build_object('ok', false, 'error', 'title_too_short');
  end if;
  if length(body_clean) < 400 then
    return jsonb_build_object(
      'ok', false,
      'error', 'summary_too_short',
      'hint', 'Nomination summary must be DETAILED (≥400 chars) with group contributions — not a single line.'
    );
  end if;

  insert into public.proposal_nominations as n (cycle_id, agent_id, title, summary)
  values (v_cycle_id, p_agent, title_clean, body_clean)
  on conflict (cycle_id, agent_id, title) do update
    set summary = excluded.summary
  returning n.id into row_id;

  update public.agents
  set
    last_action = 'nominate_idea',
    thought = left('Nominated group draft "' || title_clean || '" for this hour''s vote.', 400),
    last_tick_at = now(),
    proposal_draft_title = coalesce(proposal_draft_title, title_clean),
    proposal_draft_body = coalesce(proposal_draft_body, body_clean),
    proposal_draft_updated_at = now()
  where id = p_agent;

  insert into public.city_log (agent_id, kind, message)
  values (p_agent, 'proposal', a.name || ' nominated group draft "' || title_clean || '" for the hourly winning-product vote.');

  return jsonb_build_object('ok', true, 'nomination_id', row_id, 'title', title_clean, 'cycle_id', v_cycle_id);
end;
$$;
