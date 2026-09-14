-- Retarget hourly cycle: meeting at UTC :18 (~10m from retarget at :08).
-- prep :10-:17, meeting :18-:23, voting :24-:26, filing :27-:29.

create or replace function public._proposal_phase_for_minute(p_min int)
returns text
language sql
immutable
as $$
  select case
    when p_min >= 18 and p_min < 24 then 'meeting'
    when p_min >= 24 and p_min < 27 then 'voting'
    when p_min >= 27 and p_min < 30 then 'filing'
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
      values (announcer, 'event', 'Hourly tool meeting starting at the plaza (UTC :18) — group nominations only; town votes next.');
      insert into public.notices (author_id, place_id, body)
      values (announcer, 'plaza', 'HOURLY MEETING (:18 UTC): Group-crafted tool nominations only. Vote next. Winner files a detailed report at the library.');
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

  return public.proposal_cycle_snapshot(c.id);
end;
$$;
