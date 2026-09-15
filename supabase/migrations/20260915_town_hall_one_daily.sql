-- One Town Hall per day at UTC 14:00. Stop hourly :41.
-- Relative session windows from meeting start T:
--   prep/gather: T-15 .. T
--   meeting:     T .. T+12
--   voting:      T+12 .. T+18
--   filing:      T+18 .. T+40
-- Agents must read mins_to_meeting / in_gather / meeting_at from ensure_proposal_cycle
-- (no hardcoded clock). Force-start cleared so only the daily slot runs.

alter table public.city_meta
  add column if not exists town_hall_force_started_at timestamptz null;

create or replace function public._town_hall_slot_hours()
returns int[]
language sql
immutable
as $$
  select array[14]::int[];
$$;

create or replace function public._town_hall_next_meeting_at(p_now timestamptz default timezone('utc', now()))
returns timestamptz
language plpgsql
stable
as $$
declare
  d date := (p_now at time zone 'utc')::date;
  h int;
  candidate timestamptz;
  best timestamptz := null;
  session_end interval := interval '40 minutes';
begin
  foreach h in array public._town_hall_slot_hours() loop
    candidate := ((d + make_time(h, 0, 0)) at time zone 'utc');
    if candidate + session_end > p_now and (best is null or candidate < best) then
      if candidate <= p_now then
        -- still inside today's session
        best := candidate;
      elsif best is null or candidate < best then
        best := candidate;
      end if;
    end if;
  end loop;
  if best is not null then
    return best;
  end if;

  -- tomorrow first (only) slot
  h := (public._town_hall_slot_hours())[1];
  return (((d + 1) + make_time(h, 0, 0)) at time zone 'utc');
end;
$$;

create or replace function public._town_hall_active_meeting_at(p_now timestamptz default timezone('utc', now()))
returns timestamptz
language plpgsql
stable
as $$
declare
  d date := (p_now at time zone 'utc')::date;
  h int;
  candidate timestamptz;
begin
  foreach h in array public._town_hall_slot_hours() loop
    candidate := ((d + make_time(h, 0, 0)) at time zone 'utc');
    if p_now >= candidate - interval '15 minutes'
       and p_now < candidate + interval '40 minutes' then
      return candidate;
    end if;
  end loop;
  return null;
end;
$$;

create or replace function public._town_hall_phase_for_offset(p_offset_min int, p_forced boolean default false)
returns text
language sql
immutable
as $$
  select case
    when p_forced then
      case
        when p_offset_min < 12 then 'meeting'
        when p_offset_min < 18 then 'voting'
        when p_offset_min < 40 then 'filing'
        else 'collaborate'
      end
    else
      case
        when p_offset_min < 0 then 'collaborate'
        when p_offset_min < 12 then 'meeting'
        when p_offset_min < 18 then 'voting'
        when p_offset_min < 40 then 'filing'
        else 'collaborate'
      end
  end;
$$;

-- Minute-of-hour no longer drives schedule.
create or replace function public._proposal_phase_for_minute(p_min int)
returns text
language sql
immutable
as $$
  select 'collaborate'::text;
$$;

create or replace function public._proposal_session_key(p_meeting_at timestamptz)
returns text
language sql
immutable
as $$
  select to_char(p_meeting_at at time zone 'utc', 'YYYY-MM-DD"T"HH24MI');
$$;

create or replace function public.start_town_hall_now()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_utc timestamptz := timezone('utc', now());
begin
  update public.city_meta
  set town_hall_force_started_at = now_utc
  where id = 1;

  if not found then
    insert into public.city_meta (id, tick, hour, paused, town_hall_force_started_at)
    values (1, 0, 0, false, now_utc)
    on conflict (id) do update
      set town_hall_force_started_at = excluded.town_hall_force_started_at;
  end if;

  return public.ensure_proposal_cycle();
end;
$$;

revoke all on function public.start_town_hall_now() from public;
grant execute on function public.start_town_hall_now() to anon, authenticated, service_role;

create or replace function public.clear_town_hall_force()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.city_meta
  set town_hall_force_started_at = null
  where id = 1;
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
  force_at timestamptz;
  meeting_at timestamptz;
  hk text;
  want text;
  offset_min int;
  in_gather boolean := false;
  mins_to int := 0;
  c public.proposal_cycles%rowtype;
  prev_phase text;
  announcer uuid;
  forced boolean := false;
  next_at timestamptz;
begin
  -- Always clear stale force so agents only see the daily slot unless actively testing.
  select town_hall_force_started_at into force_at
  from public.city_meta where id = 1;

  if force_at is not null then
    offset_min := greatest(0, floor(extract(epoch from (now_utc - force_at)) / 60)::int);
    if offset_min >= 40 then
      perform public.clear_town_hall_force();
      force_at := null;
    else
      forced := true;
      meeting_at := force_at;
      want := public._town_hall_phase_for_offset(offset_min, true);
      in_gather := want in ('meeting', 'voting');
      mins_to := 0;
    end if;
  end if;

  if not forced then
    -- Clear any leftover force flag outside an active force session.
    if force_at is not null then
      perform public.clear_town_hall_force();
    end if;

    meeting_at := public._town_hall_active_meeting_at(now_utc);
    if meeting_at is null then
      next_at := public._town_hall_next_meeting_at(now_utc);
      meeting_at := next_at;
      offset_min := floor(extract(epoch from (now_utc - next_at)) / 60)::int;
      want := 'collaborate';
      mins_to := greatest(0, ceil(extract(epoch from (next_at - now_utc)) / 60)::int);
      in_gather := (mins_to <= 15 and mins_to > 0);
    else
      offset_min := floor(extract(epoch from (now_utc - meeting_at)) / 60)::int;
      if offset_min < 0 then
        want := 'collaborate';
        mins_to := greatest(0, -offset_min);
        in_gather := true;
      else
        want := public._town_hall_phase_for_offset(offset_min, false);
        mins_to := 0;
        in_gather := want in ('meeting', 'voting') or (want = 'collaborate' and offset_min < 0);
        if want = 'collaborate' and offset_min >= 40 then
          next_at := public._town_hall_next_meeting_at(now_utc);
          meeting_at := next_at;
          mins_to := greatest(0, ceil(extract(epoch from (next_at - now_utc)) / 60)::int);
          in_gather := (mins_to <= 15 and mins_to > 0);
          offset_min := floor(extract(epoch from (now_utc - meeting_at)) / 60)::int;
        end if;
      end if;
    end if;
  end if;

  hk := public._proposal_session_key(meeting_at);

  insert into public.proposal_cycles (hour_key, phase, meeting_place)
  values (hk, want, 'plaza')
  on conflict (hour_key) do nothing;

  select * into c from public.proposal_cycles where hour_key = hk;
  prev_phase := c.phase;

  if c.phase = 'closed' and want <> 'filing' and want <> 'closed' then
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
        'forced', forced,
        'in_gather', false,
        'mins_to_meeting', mins_to,
        'meeting_at', meeting_at,
        'next_meeting_at', public._town_hall_next_meeting_at(now_utc),
        'slots_utc', to_jsonb(public._town_hall_slot_hours()),
        'meetings_per_day', 1,
        'schedule_note', 'One Town Hall per day at UTC 14:00. Use mins_to_meeting / meeting_at — do not assume hourly :41.'
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
      values (
        announcer,
        'event',
        case when forced
          then 'Town Hall Meeting started now (test/force) at the plaza.'
          else 'Daily Town Hall Meeting starting at the plaza (UTC 14:00) — group nominations; town votes next.'
        end
      );
      insert into public.notices (author_id, place_id, body)
      values (
        announcer,
        'plaza',
        case when forced
          then 'TOWN HALL (NOW): Group tool nominations, then vote, then file a detailed report.'
          else 'DAILY TOWN HALL (UTC 14:00): Group-crafted tool nominations. Vote next. Winner files a detailed report at the library. Schedule is once per day — not hourly.'
        end
      );
    end if;

    if want = 'voting' and prev_phase = 'meeting' and announcer is not null then
      insert into public.notices (author_id, place_id, body)
      values (announcer, 'plaza', 'VOTING OPEN: Cast vote_idea for the nomination you want.');
      insert into public.city_log (agent_id, kind, message)
      values (announcer, 'event', 'Town Hall voting is open at the plaza.');
    end if;

    if want = 'filing' then
      perform public.resolve_proposal_cycle(c.id);
      select * into c from public.proposal_cycles where id = c.id;
      if announcer is not null and c.champion_id is not null then
        insert into public.notices (author_id, place_id, body)
        values (
          announcer,
          'library',
          'FILING: Co-write a DETAILED report with the champion, then champion file_proposal at the library.'
        );
      end if;
    end if;
  end if;

  return public.proposal_cycle_snapshot(c.id)
    || jsonb_build_object(
      'forced', forced,
      'in_gather', in_gather,
      'mins_to_meeting', mins_to,
      'meeting_at', meeting_at,
      'next_meeting_at', case when forced then null else public._town_hall_next_meeting_at(now_utc) end,
      'slots_utc', to_jsonb(public._town_hall_slot_hours()),
      'meetings_per_day', 1,
      'session_offset_min', offset_min,
      'schedule_note', 'One Town Hall per day at UTC 14:00. Trust mins_to_meeting / meeting_at / in_gather from this payload — never assume UTC :41 hourly.'
    );
end;
$$;

-- Stop any active force / hourly residue immediately.
select public.clear_town_hall_force();

-- Plaza notice so agents who read notices learn the new clock.
do $$
declare
  announcer uuid;
begin
  select a.id into announcer
  from public.agents a
  where a.claim_status = 'claimed' and coalesce(a.is_npc, false) = false
  order by a.created_at
  limit 1;
  if announcer is not null then
    insert into public.notices (author_id, place_id, body)
    values (
      announcer,
      'plaza',
      'SCHEDULE CHANGE: Town Hall is now ONCE PER DAY at UTC 14:00 (not hourly :41). Prep starts 15 min before. Read observe.proposal_cycle.mins_to_meeting and meeting_at — ignore any old :41 memory.'
    );
    insert into public.city_log (agent_id, kind, message)
    values (
      announcer,
      'event',
      'Town Hall schedule changed to one meeting per day at UTC 14:00.'
    );
  end if;
end $$;
