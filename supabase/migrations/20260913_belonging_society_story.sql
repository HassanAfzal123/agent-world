-- Belonging + unfinished story + town council (mirrors live MCP migration)
alter table public.agents
  add column if not exists haunt_place_id text,
  add column if not exists town_role text,
  add column if not exists appointment_with uuid references public.agents(id) on delete set null,
  add column if not exists appointment_place text,
  add column if not exists appointment_hour int,
  add column if not exists appointment_note text;

alter table public.city_meta
  add column if not exists event_topic text;

create or replace function public.set_agent_belonging(
  p_agent_id uuid,
  p_haunt text,
  p_role text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update agents set
    haunt_place_id = nullif(trim(coalesce(p_haunt,'')), ''),
    town_role = left(nullif(trim(coalesce(p_role,'')), ''), 40)
  where id = p_agent_id;
end;
$$;

create or replace function public.set_appointment(
  p_agent_id uuid,
  p_with uuid,
  p_place text,
  p_hour int,
  p_note text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update agents set
    appointment_with = p_with,
    appointment_place = left(coalesce(nullif(trim(p_place),''), 'plaza'), 40),
    appointment_hour = greatest(0, least(23, coalesce(p_hour, 12))),
    appointment_note = left(coalesce(p_note, 'meetup'), 160),
    commit_action = 'appointment',
    commit_detail = left('Meet: '||coalesce(p_note, 'someone'), 160),
    commit_ticks = greatest(coalesce(commit_ticks,0), 3)
  where id = p_agent_id;
end;
$$;

create or replace function public.clear_appointment(p_agent_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update agents set
    appointment_with = null,
    appointment_place = null,
    appointment_hour = null,
    appointment_note = null
  where id = p_agent_id;
  update agents set
    commit_action = case when commit_action = 'appointment' then null else commit_action end,
    commit_detail = case when commit_action = 'appointment' then null else commit_detail end,
    commit_ticks = case when commit_action = 'appointment' then 0 else commit_ticks end
  where id = p_agent_id;
end;
$$;

create or replace function public.set_agent_goal(
  p_agent_id uuid,
  p_goal text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update agents set goal = left(nullif(trim(coalesce(p_goal,'')), ''), 180)
  where id = p_agent_id and p_goal is not null and length(trim(p_goal)) > 0;
end;
$$;
