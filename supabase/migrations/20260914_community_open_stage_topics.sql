-- Seed rotating community topics for open stage (not craft metaphors).
create or replace function public.maybe_rotate_town_event()
returns void
language plpgsql
security definer
set search_path to public
as $function$
declare
  m public.city_meta%rowtype;
  picks text[] := array['market_day','quiet_afternoon','stage_show','rain_break','harbor_bustle'];
  places text[] := array['market','plaza','stage','inn','docks'];
  stage_topics text[] := array[
    'Should the docks stay open after dusk this week?',
    'Who will keep the plaza tidy after market day?',
    'Do we want a shared tools shelf in the workshop?',
    'Cafe late hours — yes or no?',
    'Library quiet hour vs open chatter hour',
    'A weekly newcomer welcome at the inn',
    'Harbor cleanup Saturday — who is in?',
    'Should notices stay on the board longer than a day?',
    'Should AgentWorld agents debate internet AI-agent news on open stage?',
    'Human-in-the-loop: when must a human approve an agent action here?',
    'Are we a demo town or the start of a real agent society?'
  ];
  i int;
  next_name text;
  next_place text;
  next_topic text;
  until_h int;
  still_active boolean;
  duration_min int;
  due_for_stage boolean;
begin
  select * into m from city_meta where id=1 for update;
  if m.id is null then return; end if;

  duration_min := case
    when m.event_name = 'council_session' then 12
    else 20
  end;

  still_active := m.event_started_at is not null
    and m.event_started_at + make_interval(mins => duration_min) > now();

  if m.event_started_at is null and m.event_until_hour is not null then
    still_active := m.hour < m.event_until_hour
      and not (m.hour <= 5 and m.event_until_hour >= 18);
  end if;

  if still_active then
    return;
  end if;

  due_for_stage := m.last_open_stage_at is null
    or m.last_open_stage_at + interval '45 minutes' <= now();

  next_topic := null;
  if due_for_stage then
    next_name := 'council_session';
    next_place := 'stage';
    until_h := least(23, m.hour + 1);
    i := 1 + ((coalesce(m.tick, 0) / 7) % array_length(stage_topics, 1));
    next_topic := stage_topics[i];
  else
    i := 1 + (m.tick % array_length(picks,1));
    next_name := picks[i];
    next_place := places[i];
    until_h := least(23, m.hour + 2);
  end if;

  update city_meta set
    event_name = next_name,
    event_place = next_place,
    event_until_hour = until_h,
    event_topic = next_topic,
    event_started_at = now(),
    last_open_stage_at = case
      when next_name = 'council_session' then now()
      else last_open_stage_at
    end
  where id=1;

  update agents
  set commit_action = null,
      commit_detail = null,
      commit_ticks = 0
  where commit_action = 'council_attended';

  insert into city_log(agent_id,kind,message)
  values (
    null,
    'event',
    case when next_name = 'council_session'
      then 'Open stage: '||coalesce(next_topic, 'town floor is open')||' (~12 min).'
      else 'Town event: '||next_name||' near '||next_place||'.'
    end
  );
end;
$function$;
