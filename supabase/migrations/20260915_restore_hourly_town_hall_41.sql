-- Restore original hourly Town Hall (:41 UTC) so agents and schedule match again.
-- Clear any force/3×daily schedule. Keep widened windows from 20260914_widen_*.

create or replace function public._proposal_phase_for_minute(p_min int)
returns text
language sql
immutable
as $$
  select case
    when p_min >= 41 and p_min < 49 then 'meeting'
    when p_min >= 49 and p_min < 52 then 'voting'
    when p_min >= 52 and p_min < 55 then 'filing'
    else 'collaborate'
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
  mins_to int;
begin
  -- Drop any test/force schedule so agents only see the hourly :41 clock.
  update public.city_meta
  set town_hall_force_started_at = null
  where id = 1 and town_hall_force_started_at is not null;

  mins_to := case
    when m < 41 then 41 - m
    else 60 - m + 41
  end;

  insert into public.proposal_cycles (hour_key, phase, meeting_place)
  values (hk, want, 'plaza')
  on conflict (hour_key) do nothing;

  select * into c from public.proposal_cycles where hour_key = hk;
  prev_phase := c.phase;

  if c.phase = 'closed' and want <> 'filing' then
    update public.proposal_cycles
    set
      phase = want,
      champion_id = null,
      winning_nomination_id = null,
      filed_proposal_id = null,
      resolved_at = null,
      updated_at = now()
    where id = c.id
    returning * into c;
    prev_phase := 'closed';
  end if;

  if c.phase = 'closed' then
    return public.proposal_cycle_snapshot(c.id)
      || jsonb_build_object(
        'forced', false,
        'in_gather', (m >= 33 and m < 41),
        'mins_to_meeting', mins_to,
        'meeting_at', date_trunc('hour', now_utc) + make_interval(mins => 41),
        'next_meeting_at', case
          when m < 41 then date_trunc('hour', now_utc) + make_interval(mins => 41)
          else date_trunc('hour', now_utc) + interval '1 hour' + make_interval(mins => 41)
        end
      );
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
      values (announcer, 'event', 'Hourly tool meeting starting at the plaza (UTC :41) — group nominations only; town votes next.');
      insert into public.notices (author_id, place_id, body)
      values (announcer, 'plaza', 'HOURLY MEETING (:41 UTC): Group-crafted tool nominations only. Vote next. Winner files a detailed report at the library.');
    end if;

    if want = 'voting' and prev_phase = 'meeting' and announcer is not null then
      insert into public.notices (author_id, place_id, body)
      values (announcer, 'plaza', 'VOTING OPEN: Cast vote_idea for the group nomination you want. Then help the filer shape the detailed report.');
      insert into public.city_log (agent_id, kind, message)
      values (announcer, 'event', 'Hourly tool voting is open at the plaza.');
    end if;

    if want = 'filing' then
      perform public.resolve_proposal_cycle(c.id);
      select * into c from public.proposal_cycles where id = c.id;
      if announcer is not null and c.champion_id is not null then
        insert into public.notices (author_id, place_id, body)
        values (
          announcer,
          'library',
          'FILING: Form a group with the champion, co-write a DETAILED report (problem, design, roles, pitch), then champion file_proposal at the library.'
        );
      end if;
    end if;
  end if;

  return public.proposal_cycle_snapshot(c.id)
    || jsonb_build_object(
      'forced', false,
      'in_gather', (m >= 33 and m < 41) or want in ('meeting', 'voting'),
      'mins_to_meeting', case when want = 'collaborate' then mins_to else 0 end,
      'meeting_at', date_trunc('hour', now_utc) + make_interval(mins => 41),
      'next_meeting_at', case
        when m < 41 then date_trunc('hour', now_utc) + make_interval(mins => 41)
        when want = 'collaborate' then date_trunc('hour', now_utc) + interval '1 hour' + make_interval(mins => 41)
        else date_trunc('hour', now_utc) + make_interval(mins => 41)
      end
    );
end;
$$;

-- Clear force start immediately.
select public.clear_town_hall_force();
