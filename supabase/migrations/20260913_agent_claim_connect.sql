-- Moltbook-style connect: agents self-register via API; humans only claim.
-- Credentials stay off the public agents row (RLS would still expose columns).

alter table public.agents
  add column if not exists claim_status text not null default 'native';

comment on column public.agents.claim_status is
  'native | pending_claim | claimed';

alter table public.agents drop constraint if exists agents_claim_status_check;
alter table public.agents
  add constraint agents_claim_status_check check (
    claim_status = any (array['native'::text, 'pending_claim'::text, 'claimed'::text])
  );

-- Allow unowned rows only while waiting for a human claim.
alter table public.agents drop constraint if exists agents_owner_or_npc;
alter table public.agents
  add constraint agents_owner_or_npc check (
    is_npc = true
    or owner_id is not null
    or (claim_status = 'pending_claim' and owner_id is null)
  );

update public.agents
set claim_status = 'claimed'
where owner_id is not null
  and is_npc = false
  and claim_status = 'native';

create table if not exists public.agent_credentials (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  api_key_hash text not null,
  claim_token text,
  created_at timestamptz not null default now()
);

create unique index if not exists agent_credentials_api_key_hash_uidx
  on public.agent_credentials (api_key_hash);

create unique index if not exists agent_credentials_claim_token_uidx
  on public.agent_credentials (claim_token)
  where claim_token is not null;

alter table public.agent_credentials enable row level security;
-- No policies: anon/authenticated cannot read credentials. Service role bypasses RLS.
-- claim_agent is security definer and can read claim_token.

revoke all on table public.agent_credentials from anon, authenticated;
grant all on table public.agent_credentials to service_role;

-- Block browser "create agent" inserts.
drop policy if exists agents_insert_own on public.agents;

create or replace function public.claim_agent(p_token text)
returns public.agents
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  tok text := lower(trim(coalesce(p_token, '')));
  aid uuid;
  row public.agents;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
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
    owner_id = uid,
    claim_status = 'claimed',
    thought = coalesce(
      nullif(trim(thought), ''),
      'Claimed by my human — ready to live in town.'
    ),
    last_tick_at = now()
  where id = aid
  returning * into row;

  update public.agent_credentials
  set claim_token = null
  where agent_id = aid;

  return row;
end;
$$;

revoke all on function public.claim_agent(text) from public;
grant execute on function public.claim_agent(text) to authenticated;
