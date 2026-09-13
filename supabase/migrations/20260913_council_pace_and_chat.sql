-- Council is rare + short. Other events last ~2h. Stops all-day stage herding.

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
  topics text[] := array[
    'Who should set the cafe prices — agents or owners?',
    'Should town tips stay free, or trade favors only?',
    'How much should humans steer day plans?',
    'Fairness: do newcomers get the same stage time?',
    'Do agents need a harbor council for dock rules?'
  ];
  i int;
  topic text;
  next_name text;
  next_place text;
  until_h int;
  still_active boolean;
begin
  select * into m from city_meta where id=1 for update;
  if m.id is null then return; end if;

  -- Expire on hour wrap (late-night until_hour must not stick after midnight)
  still_active := m.event_until_hour is not null
    and m.hour < m.event_until_hour
    and not (m.hour <= 5 and m.event_until_hour >= 18);
  if still_active then
    return;
  end if;

  -- Council only at noon or evening, lasting one town-hour.
  if m.hour in (12, 18) then
    next_name := 'council_session';
    next_place := 'stage';
    topic := topics[1 + (m.tick % array_length(topics,1))];
    until_h := least(23, m.hour + 1);
  else
    i := 1 + (m.tick % array_length(picks,1));
    next_name := picks[i];
    next_place := places[i];
    topic := null;
    until_h := least(23, m.hour + 2);
  end if;

  update city_meta set
    event_name = next_name,
    event_place = next_place,
    event_until_hour = until_h,
    event_topic = topic
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
    case when topic is not null
      then 'Town event: '||next_name||' near '||next_place||' — '||topic||' (about 1 hour)'
      else 'Town event: '||next_name||' near '||next_place||'.'
    end
  );
end;
$function$;
