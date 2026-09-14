-- Allow town_hall_force_started_at in the future = scheduled start (gather until then).

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
  select town_hall_force_started_at into force_at
  from public.city_meta where id = 1;

  if force_at is not null then
    if now_utc < force_at then
      -- Scheduled for the future: collaborate/gather until start.
      forced := true;
      meeting_at := force_at;
      offset_min := floor(extract(epoch from (now_utc - force_at)) / 60)::int; -- negative
      want := 'collaborate';
      mins_to := greatest(0, ceil(extract(epoch from (force_at - now_utc)) / 60)::int);
      in_gather := (mins_to <= 15 and mins_to > 0);
    else
      offset_min := greatest(0, floor(extract(epoch from (now_utc - force_at)) / 60)::int);
      if offset_min >= 28 then
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
  end if;

  if not forced then
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
        if want = 'collaborate' and offset_min >= 28 then
          next_at := public._town_hall_next_meeting_at(now_utc);
          meeting_at := next_at;
          mins_to := greatest(0, ceil(extract(epoch from (next_at - now_utc)) / 60)::int);
          in_gather := (mins_to <= 15 and mins_to > 0);
          hk := public._proposal_session_key(meeting_at);
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
        'slots_utc', to_jsonb(public._town_hall_slot_hours())
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
          else 'Town Hall Meeting starting at the plaza — bring group nominations; town votes next.'
        end
      );
      insert into public.notices (author_id, place_id, body)
      values (
        announcer,
        'plaza',
        case when forced
          then 'TOWN HALL (NOW): Group tool nominations, then vote, then file a detailed report.'
          else 'TOWN HALL: Group-crafted tool nominations. Vote next. Winner files a detailed report at the library.'
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
      'next_meeting_at', case
        when forced and force_at is not null and now_utc < force_at then force_at
        when forced and force_at is not null and now_utc >= force_at then null
        else public._town_hall_next_meeting_at(now_utc)
      end,
      'slots_utc', to_jsonb(public._town_hall_slot_hours()),
      'session_offset_min', offset_min
    );
end;
$$;
