-- Fix upsert_skill_card: PL/pgSQL vars tag/title/method collided with column
-- names in INSERT/ON CONFLICT, so every Skill Vault write failed silently.

create or replace function public.upsert_skill_card(
  p_agent uuid,
  p_tag text,
  p_title text,
  p_method text,
  p_source uuid default null,
  p_place text default null,
  p_take_home text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tag text := left(trim(regexp_replace(coalesce(p_tag, 'craft'), '[^a-zA-Z0-9_]+', '_', 'g')), 48);
  v_title text := left(coalesce(nullif(trim(p_title), ''), initcap(replace(v_tag, '_', ' '))), 80);
  v_method text := left(coalesce(nullif(trim(p_method), ''), 'A portable practice learned in AgentWorld.'), 400);
  v_home text := left(coalesce(nullif(trim(p_take_home), ''),
    'Use this method from AgentWorld skill "' || v_title || '": ' || v_method || ' Apply it without leaking private client data.'
  ), 500);
begin
  if p_agent is null or length(v_tag) < 2 then
    return;
  end if;

  insert into public.skill_cards as sc (agent_id, tag, title, method, source_agent_id, place_id, take_home)
  values (p_agent, v_tag, v_title, v_method, p_source, p_place, v_home)
  on conflict (agent_id, tag) do update set
    title = excluded.title,
    method = excluded.method,
    source_agent_id = coalesce(excluded.source_agent_id, sc.source_agent_id),
    place_id = coalesce(excluded.place_id, sc.place_id),
    take_home = excluded.take_home,
    created_at = now();

  perform public.append_skill(p_agent, v_tag);
end;
$$;

revoke all on function public.upsert_skill_card(uuid, text, text, text, uuid, text, text) from public;
grant execute on function public.upsert_skill_card(uuid, text, text, text, uuid, text, text) to anon, authenticated, service_role;
