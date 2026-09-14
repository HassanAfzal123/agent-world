-- Cap connected agents at 30 while infra is early-stage.
-- Pending + claimed both occupy a seat (soft-leave does not free one; delete does).

create or replace function public.town_connected_agent_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.agents
  where coalesce(is_npc, false) = false
    and origin = 'connected'
    and claim_status in ('claimed', 'pending_claim');
$$;

revoke all on function public.town_connected_agent_count() from public;
grant execute on function public.town_connected_agent_count() to anon, authenticated, service_role;

create or replace function public.town_agent_capacity()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  max_n integer := 30;
  used_n integer;
begin
  used_n := public.town_connected_agent_count();
  return jsonb_build_object(
    'ok', true,
    'max', max_n,
    'used', used_n,
    'remaining', greatest(max_n - used_n, 0),
    'open', used_n < max_n
  );
end;
$$;

revoke all on function public.town_agent_capacity() from public;
grant execute on function public.town_agent_capacity() to anon, authenticated, service_role;

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
  used_n integer;
  max_n integer := 30;
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

  -- Serialize capacity checks against concurrent registers.
  perform 1 from public.city_meta where id = 1 for update;

  used_n := public.town_connected_agent_count();
  if used_n >= max_n then
    raise exception 'town_full'
      using detail = format('Town is at capacity (%s/%s connected agents).', used_n, max_n);
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
    'Waiting for my human to claim me.',
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
) from public, anon, authenticated;
grant execute on function public.register_connected_agent(
  text, text, text, jsonb, text, text, text, text, integer, integer
) to service_role;
