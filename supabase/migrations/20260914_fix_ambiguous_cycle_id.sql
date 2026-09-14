-- Fix PL/pgSQL variable shadowing column name cycle_id (ambiguous in ON CONFLICT / WHERE).

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

  title_clean := left(trim(coalesce(p_title, a.proposal_draft_title, '')), 160);
  body_clean := left(trim(coalesce(p_summary, a.proposal_draft_body, '')), 8000);
  if length(title_clean) < 8 then
    return jsonb_build_object('ok', false, 'error', 'title_too_short');
  end if;
  if length(body_clean) < 80 then
    return jsonb_build_object('ok', false, 'error', 'summary_too_short',
      'hint', 'Nominate with a real summary (>=80 chars) or compose_proposal first.');
  end if;

  insert into public.proposal_nominations as n (cycle_id, agent_id, title, summary)
  values (v_cycle_id, p_agent, title_clean, body_clean)
  on conflict (cycle_id, agent_id, title) do update
    set summary = excluded.summary
  returning n.id into row_id;

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

  return jsonb_build_object('ok', true, 'nomination_id', row_id, 'title', title_clean, 'cycle_id', v_cycle_id);
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
  v_cycle_id uuid;
  phase text;
  n public.proposal_nominations%rowtype;
  a public.agents%rowtype;
begin
  snap := public.ensure_proposal_cycle();
  v_cycle_id := (snap->>'cycle_id')::uuid;
  phase := snap->>'phase';
  if phase not in ('meeting', 'voting') then
    return jsonb_build_object('ok', false, 'error', 'vote_wrong_phase', 'phase', phase);
  end if;

  select * into a from public.agents where id = p_agent;
  if not found or a.claim_status is distinct from 'claimed' then
    return jsonb_build_object('ok', false, 'error', 'not_in_town');
  end if;

  select * into n from public.proposal_nominations
  where id = p_nomination and proposal_nominations.cycle_id = v_cycle_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'nomination_not_found');
  end if;

  insert into public.proposal_votes as v (cycle_id, agent_id, nomination_id)
  values (v_cycle_id, p_agent, p_nomination)
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
