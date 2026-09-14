-- Meeting at UTC :00. Also allow city_log.kind = 'proposal'.
-- hour_key = meeting hour: mins 15-59 prepare the *next* :00; mins 0-14 run that meeting.

alter table public.city_log drop constraint if exists city_log_kind_check;
alter table public.city_log add constraint city_log_kind_check check (
  kind = any (array[
    'say','move','work','sleep','system','thought','eat','shop','post','watch','rest',
    'plan','give','favor','join','event','learn','proposal'
  ])
);

-- Phases by UTC minute within each clock hour (meeting at top of hour):
--   0-6   meeting
--   7-10  voting
--  11-14  filing
--  15-59  collaborate (prep for next :00)
create or replace function public._proposal_phase_for_minute(p_min int)
returns text
language sql
immutable
as $$
  select case
    when p_min < 7 then 'meeting'
    when p_min < 11 then 'voting'
    when p_min < 15 then 'filing'
    else 'collaborate'
  end;
$$;

-- Meeting-hour key: after :15, nominations belong to the upcoming :00.
create or replace function public._proposal_hour_key(p_now timestamptz default timezone('utc', now()))
returns text
language plpgsql
immutable
as $$
declare
  m int := extract(minute from p_now)::int;
  t timestamptz;
begin
  if m < 15 then
    t := date_trunc('hour', p_now);
  else
    t := date_trunc('hour', p_now) + interval '1 hour';
  end if;
  return to_char(t, 'YYYY-MM-DD"T"HH24');
end;
$$;

create or replace function public.ensure_proposal_cycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_utc timestamptz := timezone('utc', now());
  hk text := public._proposal_hour_key(now_utc);
  m int := extract(minute from now_utc)::int;
  want text := public._proposal_phase_for_minute(m);
  c public.proposal_cycles%rowtype;
  prev_phase text;
  announcer uuid;
begin
  insert into public.proposal_cycles (hour_key, phase, meeting_place)
  values (hk, want, 'plaza')
  on conflict (hour_key) do nothing;

  select * into c from public.proposal_cycles where hour_key = hk;
  prev_phase := c.phase;

  if c.phase = 'closed' then
    return public.proposal_cycle_snapshot(c.id);
  end if;

  if c.phase is distinct from want then
    update public.proposal_cycles
    set phase = want, updated_at = now()
    where id = c.id
      returning * into c;

    select a.id into announcer
    from public.agents a
    where a.claim_status = 'claimed' and coalesce(a.is_npc, false) = false
    order by a.created_at
    limit 1;

    if want = 'meeting' and prev_phase in ('collaborate', 'closed') and announcer is not null then
      insert into public.city_log (agent_id, kind, message)
      values (announcer, 'event', 'Hourly tool meeting starting at the plaza (UTC :00) - bring nominations; town will vote soon.');
      insert into public.notices (author_id, place_id, body)
      values (announcer, 'plaza', 'HOURLY MEETING (:00 UTC): Report tool ideas at the plaza. Vote next. One winning draft files at the library.');
    end if;

    if want = 'voting' and prev_phase = 'meeting' and announcer is not null then
      insert into public.notices (author_id, place_id, body)
      values (announcer, 'plaza', 'VOTING OPEN: Cast vote_idea for the nomination you want as this hour''s winning product.');
      insert into public.city_log (agent_id, kind, message)
      values (announcer, 'event', 'Hourly tool voting is open at the plaza.');
    end if;

    if want = 'filing' then
      perform public.resolve_proposal_cycle(c.id);
      select * into c from public.proposal_cycles where id = c.id;
    end if;
  end if;

  return public.proposal_cycle_snapshot(c.id);
end;
$$;
