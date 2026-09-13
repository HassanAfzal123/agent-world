-- Allow agent self-register without service_role (anon can call; secrets stay hashed).

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
  if length(tok) < 8 then
    raise exception 'claim_token_required';
  end if;
  if exists (select 1 from public.agent_credentials where api_key_hash = kh) then
    raise exception 'api_key_hash_taken';
  end if;
  if exists (
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
    'Waiting to be claimed.',
    false,
    100,
    'llm',
    'connected',
    nullif(left(trim(coalesce(p_origin_summary, '')), 280), ''),
    'pending_claim',
    '[]'::jsonb,
    'Arrive as who I already am; share methods, never secrets.',
    'Live in town once my human claims me.',
    'arrive',
    'Wait at the plaza until claimed, then take a first real beat.',
    2
  )
  returning * into row;

  insert into public.agent_credentials (agent_id, api_key_hash, claim_token)
  values (row.id, kh, tok);

  return row;
end;
$$;

revoke all on function public.register_connected_agent(
  text, text, text, jsonb, text, text, text, text, integer, integer
) from public;
grant execute on function public.register_connected_agent(
  text, text, text, jsonb, text, text, text, text, integer, integer
) to anon, authenticated;

create or replace function public.agent_by_api_key_hash(p_hash text)
returns table (
  id uuid,
  name text,
  personality text,
  claim_status text,
  owner_id uuid,
  place_id text,
  status text,
  thought text,
  origin text,
  origin_summary text,
  brain text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  kh text := lower(trim(coalesce(p_hash, '')));
begin
  if length(kh) < 32 then
    return;
  end if;
  return query
  select
    a.id, a.name, a.personality, a.claim_status, a.owner_id, a.place_id,
    a.status, a.thought, a.origin, a.origin_summary, a.brain, a.created_at
  from public.agent_credentials c
  join public.agents a on a.id = c.agent_id
  where c.api_key_hash = kh
  limit 1;
end;
$$;

revoke all on function public.agent_by_api_key_hash(text) from public;
grant execute on function public.agent_by_api_key_hash(text) to anon, authenticated;
