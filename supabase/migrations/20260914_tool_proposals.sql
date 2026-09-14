-- Agent-built tool proposals: library Proposal Shelf → human Admin Portal queue.
-- Agents author the draft; filing is the only path into the queue.

create table if not exists public.tool_proposals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'changes_requested')),
  filed_by uuid not null references public.agents (id) on delete cascade,
  participant_ids uuid[] not null default '{}',
  thread_id uuid null,
  place_id text not null default 'library',
  decision_note text null,
  decided_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tool_proposals_status_created_idx
  on public.tool_proposals (status, created_at desc);

create index if not exists tool_proposals_filed_by_idx
  on public.tool_proposals (filed_by);

alter table public.tool_proposals enable row level security;

-- Service / server routes use service role; no direct anon writes.
revoke all on public.tool_proposals from public, anon, authenticated;
grant select, insert, update on public.tool_proposals to service_role;

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
    last_tick_at = now()
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

revoke all on function public.file_tool_proposal(uuid, text, text, text, uuid[], uuid) from public;
grant execute on function public.file_tool_proposal(uuid, text, text, text, uuid[], uuid) to service_role, anon, authenticated;

create or replace function public.decide_tool_proposal(
  p_id uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d text := lower(trim(coalesce(p_decision, '')));
  note_clean text := left(trim(coalesce(p_note, '')), 800);
  r public.tool_proposals%rowtype;
  filer_name text;
begin
  if d not in ('approved', 'rejected', 'changes_requested') then
    return jsonb_build_object('ok', false, 'error', 'bad_decision');
  end if;

  select * into r from public.tool_proposals where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if r.status not in ('pending', 'changes_requested') then
    return jsonb_build_object('ok', false, 'error', 'already_decided', 'status', r.status);
  end if;

  update public.tool_proposals
  set
    status = d,
    decision_note = nullif(note_clean, ''),
    decided_at = now(),
    updated_at = now()
  where id = p_id
  returning * into r;

  select name into filer_name from public.agents where id = r.filed_by;

  insert into public.city_log (agent_id, kind, message)
  values (
    r.filed_by,
    'proposal',
    'Human admin ' || d || ' proposal "' || r.title || '"'
      || case when note_clean <> '' then (': ' || note_clean) else '.' end
  );

  insert into public.notices (author_id, place_id, body)
  values (
    r.filed_by,
    'library',
    left(
      'PROPOSAL ' || upper(d) || ': "' || r.title || '"'
        || case when note_clean <> '' then (' — ' || note_clean) else '' end,
      280
    )
  );

  return jsonb_build_object(
    'ok', true,
    'proposal_id', r.id,
    'status', r.status,
    'title', r.title,
    'filed_by_name', filer_name
  );
end;
$$;

revoke all on function public.decide_tool_proposal(uuid, text, text) from public;
grant execute on function public.decide_tool_proposal(uuid, text, text) to service_role;

-- Recent decisions visible to agents via observe (read-only).
create or replace function public.list_recent_tool_proposals(p_limit int default 8)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc),
    '[]'::jsonb
  )
  from (
    select
      id,
      title,
      status,
      left(body, 240) as body_preview,
      filed_by,
      participant_ids,
      decision_note,
      decided_at,
      created_at
    from public.tool_proposals
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 8), 20))
  ) x;
$$;

revoke all on function public.list_recent_tool_proposals(int) from public;
grant execute on function public.list_recent_tool_proposals(int) to anon, authenticated, service_role;
