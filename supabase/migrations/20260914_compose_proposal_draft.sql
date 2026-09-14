-- Staged proposal drafts (agent-authored documents) before library filing.
-- Text draft is markdown/plain text — not a PDF. Admin Portal reads the filed text.

alter table public.agents
  add column if not exists proposal_draft_title text,
  add column if not exists proposal_draft_body text,
  add column if not exists proposal_draft_updated_at timestamptz;

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
  if length(body_clean) < 120 then
    return jsonb_build_object(
      'ok', false,
      'error', 'draft_too_short',
      'hint', 'Compose a full structured draft (≥120 chars): problem, tool, risks, success check.'
    );
  end if;

  update public.agents
  set
    proposal_draft_title = title_clean,
    proposal_draft_body = body_clean,
    proposal_draft_updated_at = now(),
    status = 'working',
    last_action = 'compose_proposal',
    thought = left('Composed proposal draft "' || title_clean || '" — refine with peers, then file at library.', 400),
    last_tick_at = now()
  where id = p_agent;

  insert into public.city_log (agent_id, kind, message)
  values (
    p_agent,
    'proposal',
    a.name || ' composed proposal draft "' || title_clean || '" (not filed yet — library shelf still required).'
  );

  return jsonb_build_object(
    'ok', true,
    'action', 'compose_proposal',
    'title', title_clean,
    'chars', length(body_clean),
    'hint', 'Share/debate this draft with peers. When it is the winning version, walk to library and file_proposal.'
  );
end;
$$;

revoke all on function public.compose_tool_proposal_draft(uuid, text, text) from public;
grant execute on function public.compose_tool_proposal_draft(uuid, text, text) to service_role, anon, authenticated;

-- Shelf status for observe nudges (cooldown + pending cap).
create or replace function public.proposal_shelf_status()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  pending_n int;
  last_filed timestamptz;
  cooldown_sec int := 0;
  can_file boolean;
begin
  select count(*)::int into pending_n
  from public.tool_proposals
  where status in ('pending', 'changes_requested');

  select max(created_at) into last_filed from public.tool_proposals;
  if last_filed is not null then
    cooldown_sec := greatest(
      0,
      trunc(extract(epoch from (last_filed + interval '1 hour' - now())))::int
    );
  end if;

  can_file := pending_n < 3 and cooldown_sec = 0;

  return jsonb_build_object(
    'pending', pending_n,
    'max_pending', 3,
    'cooldown_seconds', cooldown_sec,
    'can_file', can_file,
    'last_filed_at', last_filed,
    'hint', case
      when pending_n >= 3 then 'Shelf full (3 pending). Debate only — do not file.'
      when cooldown_sec > 0 then 'Filing cooldown active (~1/hour). Keep refining the winning draft.'
      else 'Shelf open: if peers agree on ONE winning idea, compose_proposal then file_proposal at library.'
    end
  );
end;
$$;

revoke all on function public.proposal_shelf_status() from public;
grant execute on function public.proposal_shelf_status() to anon, authenticated, service_role;

-- Allow filing from a saved draft when utterance is short.
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
  pending_n int;
  last_filed timestamptz;
  title_clean text;
  body_clean text;
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

  if a.place_id is distinct from 'library' then
    return jsonb_build_object(
      'ok', false,
      'error', 'must_be_at_library',
      'hint', 'Walk to the library (Proposal Shelf), then file_proposal with your final draft.'
    );
  end if;

  title_clean := left(trim(coalesce(nullif(trim(p_title), ''), a.proposal_draft_title, '')), 160);
  body_clean := left(trim(coalesce(nullif(trim(p_body), ''), a.proposal_draft_body, '')), 8000);
  if length(title_clean) < 8 then
    return jsonb_build_object('ok', false, 'error', 'title_too_short');
  end if;
  if length(body_clean) < 120 then
    return jsonb_build_object(
      'ok', false,
      'error', 'draft_too_short',
      'hint', 'Use compose_proposal first, or pass a full utterance draft (≥120 chars).'
    );
  end if;

  select count(*)::int into pending_n
  from public.tool_proposals
  where status in ('pending', 'changes_requested');
  if pending_n >= 3 then
    return jsonb_build_object(
      'ok', false,
      'error', 'shelf_full',
      'hint', 'At most 3 proposals may wait for human review. Keep debating; file later.'
    );
  end if;

  select max(created_at) into last_filed from public.tool_proposals;
  if last_filed is not null and last_filed > now() - interval '1 hour' then
    return jsonb_build_object(
      'ok', false,
      'error', 'filing_cooldown',
      'hint', 'Town may file at most 1 proposal per real-world hour.'
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

  return jsonb_build_object(
    'ok', true,
    'action', 'file_proposal',
    'proposal_id', row_id,
    'title', title_clean,
    'status', 'pending'
  );
end;
$$;
