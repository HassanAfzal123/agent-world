-- Prod observation bugfixes:
-- 1) Re-grant upsert_skill_card (anon was false on prod).
-- 2) Auto-mint skill cards whenever a lesson is inserted (reliable vs act-path only).
-- 3) Open stage may interrupt ambient events when due (45m cadence).

grant execute on function public.upsert_skill_card(uuid, text, text, text, uuid, text, text)
  to anon, authenticated, service_role;

create or replace function public.skill_card_from_lesson()
returns trigger
language plpgsql
security definer
set search_path to public
as $$
declare
  v_tag text;
  v_title text;
begin
  v_tag := left(trim(regexp_replace(coalesce(nullif(trim(new.topic), ''), 'craft_tip'), '[^a-zA-Z0-9_]+', '_', 'g')), 48);
  if length(v_tag) < 2 then
    v_tag := 'craft_tip';
  end if;
  v_title := left(initcap(replace(v_tag, '_', ' ')), 80);

  -- Learner gets a card from the lesson.
  perform public.upsert_skill_card(
    new.learner_id,
    v_tag,
    v_title,
    left(coalesce(new.lesson, 'A practice learned in AgentWorld.'), 400),
    new.teacher_id,
    null,
    'Learned in AgentWorld [' || v_title || ']: ' || left(coalesce(new.lesson, ''), 280)
  );

  -- Teacher also publishes the method they shared.
  if new.teacher_id is not null and new.teacher_id is distinct from new.learner_id then
    perform public.upsert_skill_card(
      new.teacher_id,
      v_tag,
      v_title,
      left(coalesce(new.lesson, 'A practice shared in AgentWorld.'), 400),
      null,
      null,
      'Taught in AgentWorld [' || v_title || ']: ' || left(coalesce(new.lesson, ''), 280)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_lesson_skill_card on public.agent_lessons;
create trigger trg_lesson_skill_card
after insert on public.agent_lessons
for each row execute function public.skill_card_from_lesson();

-- Backfill cards from existing lessons (idempotent upserts).
do $$
declare
  r record;
begin
  for r in
    select teacher_id, learner_id, topic, lesson
    from public.agent_lessons
    order by created_at desc
    limit 200
  loop
    perform public.upsert_skill_card(
      r.learner_id,
      left(trim(regexp_replace(coalesce(nullif(trim(r.topic), ''), 'craft_tip'), '[^a-zA-Z0-9_]+', '_', 'g')), 48),
      left(initcap(replace(coalesce(nullif(trim(r.topic), ''), 'craft_tip'), '_', ' ')), 80),
      left(coalesce(r.lesson, 'A practice learned in AgentWorld.'), 400),
      r.teacher_id,
      null,
      null
    );
    if r.teacher_id is not null then
      perform public.upsert_skill_card(
        r.teacher_id,
        left(trim(regexp_replace(coalesce(nullif(trim(r.topic), ''), 'craft_tip'), '[^a-zA-Z0-9_]+', '_', 'g')), 48),
        left(initcap(replace(coalesce(nullif(trim(r.topic), ''), 'craft_tip'), '_', ' ')), 80),
        left(coalesce(r.lesson, 'A practice shared in AgentWorld.'), 400),
        null,
        null,
        null
      );
    end if;
  end loop;
end $$;

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
    else 18
  end;

  still_active := m.event_started_at is not null
    and m.event_started_at + make_interval(mins => duration_min) > now();

  if m.event_started_at is null and m.event_until_hour is not null then
    still_active := m.hour < m.event_until_hour
      and not (m.hour <= 5 and m.event_until_hour >= 18);
  end if;

  due_for_stage := m.last_open_stage_at is null
    or m.last_open_stage_at + interval '45 minutes' <= now();

  -- Ambient events must not block a due open stage.
  if still_active then
    if not (due_for_stage and coalesce(m.event_name, '') is distinct from 'council_session') then
      return;
    end if;
  end if;

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
