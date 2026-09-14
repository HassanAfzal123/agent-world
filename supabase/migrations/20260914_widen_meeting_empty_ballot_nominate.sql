-- Widen Town Hall windows + allow empty-ballot nominate into early voting.
-- meeting :41-:48, voting :49-:51, filing :52-:54 (was meeting 6m / voting 3m — too tight).

create or replace function public._proposal_phase_for_minute(p_min int)
returns text
language sql
immutable
as $$
  select case
    when p_min >= 41 and p_min < 49 then 'meeting'
    when p_min >= 49 and p_min < 52 then 'voting'
    when p_min >= 52 and p_min < 55 then 'filing'
    else 'collaborate'
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
  ballot_count int := 0;
begin
  snap := public.ensure_proposal_cycle();
  v_cycle_id := (snap->>'cycle_id')::uuid;
  phase := snap->>'phase';

  select count(*)::int into ballot_count
  from public.proposal_nominations
  where cycle_id = v_cycle_id;

  -- Collaborate + meeting always; voting only when ballot still empty (late salvage).
  if phase = 'voting' and ballot_count = 0 then
    null;
  elsif phase not in ('collaborate', 'meeting') then
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
