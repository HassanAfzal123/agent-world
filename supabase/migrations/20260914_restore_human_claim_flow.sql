-- Restore Moltbook-style claim: register waits; human opens claim_url to go live.

-- Tighten ownership: unowned connected agents only while pending_claim.
alter table public.agents drop constraint if exists agents_owner_or_npc;
alter table public.agents
  add constraint agents_owner_or_npc check (
    is_npc = true
    or owner_id is not null
    or (claim_status = 'pending_claim' and owner_id is null)
    -- After token-claim without auth account, allow claimed + connected + no owner.
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

-- Human opens claim_url (token is the secret). No account required — like clicking
-- the claim link your agent gave you. Optional auth claim_agent still works for owners.
create or replace function public.claim_agent_by_token(p_token text)
returns public.agents
language plpgsql
security definer
set search_path = public
as $$
declare
  tok text := lower(trim(coalesce(p_token, '')));
  aid uuid;
  row public.agents;
  uid uuid := auth.uid();
begin
  if tok = '' or length(tok) < 8 then
    raise exception 'invalid_claim_token';
  end if;

  select c.agent_id into aid
  from public.agent_credentials c
  join public.agents a on a.id = c.agent_id
  where lower(c.claim_token) = tok
    and a.claim_status = 'pending_claim'
    and a.owner_id is null
  for update of c;

  if aid is null then
    raise exception 'claim_not_found';
  end if;

  update public.agents
  set
    owner_id = uid, -- null if anonymous human claim via link
    claim_status = 'claimed',
    thought = 'Claimed by my human — ready to live in town.',
    status = 'idle',
    last_tick_at = now()
  where id = aid
  returning * into row;

  update public.agent_credentials
  set claim_token = null
  where agent_id = aid;

  return row;
end;
$$;

revoke all on function public.claim_agent_by_token(text) from public, anon, authenticated;
grant execute on function public.claim_agent_by_token(text) to service_role;

-- Peek pending agent for claim page (no secrets).
create or replace function public.peek_claim_token(p_token text)
returns table (
  id uuid,
  name text,
  personality text,
  claim_status text,
  origin_summary text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  tok text := lower(trim(coalesce(p_token, '')));
begin
  if length(tok) < 8 then
    return;
  end if;
  return query
  select a.id, a.name, a.personality, a.claim_status, a.origin_summary
  from public.agent_credentials c
  join public.agents a on a.id = c.agent_id
  where lower(c.claim_token) = tok
  limit 1;
end;
$$;

revoke all on function public.peek_claim_token(text) from public, anon, authenticated;
grant execute on function public.peek_claim_token(text) to service_role;
