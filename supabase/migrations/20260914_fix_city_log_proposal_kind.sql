-- city_log.kind has no 'proposal'; use 'event' for cycle notices.
-- Also widen check to allow 'proposal' going forward.

alter table public.city_log drop constraint if exists city_log_kind_check;
alter table public.city_log add constraint city_log_kind_check check (
  kind = any (array[
    'say','move','work','sleep','system','thought','eat','shop','post','watch','rest',
    'plan','give','favor','join','event','learn','proposal'
  ])
);

-- Re-apply ensure_proposal_cycle with safe kinds (proposal now allowed; keep event as fallback in older paths).
create or replace function public.ensure_proposal_cycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  hk text := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24');
  m int := extract(minute from timezone('utc', now()))::int;
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

    if want = 'meeting' and prev_phase = 'collaborate' and announcer is not null then
      insert into public.city_log (agent_id, kind, message)
      values (announcer, 'event', 'Hourly tool meeting starting at the plaza - bring your nominations; town will vote soon.');
      insert into public.notices (author_id, place_id, body)
      values (announcer, 'plaza', 'HOURLY MEETING: Report tool ideas at the plaza. Vote next. One winning draft files at the library.');
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
