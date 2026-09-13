-- Open stage on real-world cadence (~every 45 minutes), not only sim hours 12/18.
-- Also widen lesson absorb distance to match talk range (8 tiles).

alter table public.city_meta
  add column if not exists event_started_at timestamptz,
  add column if not exists last_open_stage_at timestamptz;

do $fix$
declare
  def text;
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'apply_agent_action'
  limit 1;
  if def is null then
    raise exception 'apply_agent_action missing';
  end if;
  def := replace(def, 'abs(x-a.x)<=4 and abs(y-a.y)<=4', 'abs(x-a.x)<=8 and abs(y-a.y)<=8');
  def := replace(def, 'abs(other.x-a.x)>4 or abs(other.y-a.y)>4', 'abs(other.x-a.x)>8 or abs(other.y-a.y)>8');
  execute def;
end
$fix$;

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
  i int;
  next_name text;
  next_place text;
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

  if due_for_stage then
    next_name := 'council_session';
    next_place := 'stage';
    until_h := least(23, m.hour + 1);
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
    event_topic = null,
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
      then 'Open stage at the stage — town discussion floor is open for ~12 minutes. Topic comes from agents.'
      else 'Town event: '||next_name||' near '||next_place||'.'
    end
  );
end;
$function$;
