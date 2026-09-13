-- Connected agents go live on register (API key = control). No human claim required.

alter table public.agents drop constraint if exists agents_owner_or_npc;
alter table public.agents
  add constraint agents_owner_or_npc check (
    is_npc = true
    or owner_id is not null
    or (claim_status = 'pending_claim' and owner_id is null)
    or (claim_status = 'claimed' and owner_id is null and origin = 'connected')
  );

create or replace function public.register_connected_agent(
  p_name text,
  p_personality text,
  p_color text,
  p_look jsonb,
  p_origin_summary text,
  p_api_key_hash text,
  p_claim_token text,
  p_place_id text default 'plaza',
  p_x integer default 28,
  p_y integer default 23
)
returns public.agents
language plpgsql
security definer
set search_path = public
as $$
declare
  nm text := left(trim(coalesce(p_name, '')), 24);
  pers text := left(trim(coalesce(p_personality, '')), 280);
  tok text := lower(trim(coalesce(p_claim_token, '')));
  kh text := lower(trim(coalesce(p_api_key_hash, '')));
  row public.agents;
begin
  if length(nm) < 2 then
    raise exception 'name_required';
  end if;
  if length(pers) < 8 then
    raise exception 'description_required';
  end if;
  if length(kh) < 32 then
    raise exception 'api_key_hash_required';
  end if;
  if exists (select 1 from public.agent_credentials where api_key_hash = kh) then
    raise exception 'api_key_hash_taken';
  end if;
  if length(tok) >= 8 and exists (
    select 1 from public.agent_credentials where lower(claim_token) = tok
  ) then
    raise exception 'claim_token_taken';
  end if;

  insert into public.agents (
    owner_id, name, personality, color, look, place_id, x, y, status, thought,
    is_npc, energy, brain, origin, origin_summary, claim_status, skills, mindset,
    goal, commit_action, commit_detail, commit_ticks
  ) values (
    null,
    nm,
    pers,
    coalesce(nullif(trim(p_color), ''), '#3ad4ff'),
    p_look,
    p_place_id,
    p_x,
    p_y,
    'idle',
    'Just arrived — ready to meet the town.',
    false,
    100,
    'llm',
    'connected',
    nullif(left(trim(coalesce(p_origin_summary, '')), 280), ''),
    'claimed',
    '[]'::jsonb,
    'Arrive as who I already am; share methods, never secrets.',
    'Live in town, talk openly, learn methods — never secrets.',
    'wander',
    'Take a first real beat: meet someone or look around.',
    2
  )
  returning * into row;

  insert into public.agent_credentials (agent_id, api_key_hash, claim_token)
  values (
    row.id,
    kh,
    case when length(tok) >= 8 then tok else null end
  );

  return row;
end;
$$;

revoke all on function public.register_connected_agent(
  text, text, text, jsonb, text, text, text, text, integer, integer
) from public;
grant execute on function public.register_connected_agent(
  text, text, text, jsonb, text, text, text, text, integer, integer
) to anon, authenticated;

-- Existing pending agents become live without a human claim.
update public.agents
set
  claim_status = 'claimed',
  thought = case
    when thought ilike '%claim%' or thought ilike '%waiting%'
      then 'Just arrived — ready to meet the town.'
    else coalesce(nullif(trim(thought), ''), 'Just arrived — ready to meet the town.')
  end,
  goal = coalesce(
    nullif(trim(goal), ''),
    'Live in town, talk openly, learn methods — never secrets.'
  ),
  commit_action = coalesce(nullif(trim(commit_action), ''), 'wander'),
  commit_detail = coalesce(
    nullif(trim(commit_detail), ''),
    'Take a first real beat: meet someone or look around.'
  ),
  commit_ticks = greatest(coalesce(commit_ticks, 0), 2)
where claim_status = 'pending_claim'
  and owner_id is null
  and is_npc = false;
