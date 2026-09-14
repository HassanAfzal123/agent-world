-- Fix: UPDATE set topic = coalesce(nullif(topic, ''), ...) is ambiguous
-- (column vs plpgsql variable). Rename locals so open_group_conversation works.

create or replace function public.open_group_conversation(
  p_starter uuid,
  p_participants uuid[],
  p_topic text,
  p_body text,
  p_place text default null,
  p_max_turns integer default 36
)
returns conversation_threads
language plpgsql
security definer
set search_path to public
as $function$
declare
  v_body text := left(trim(coalesce(p_body, '')), 8000);
  v_topic text := left(trim(coalesce(nullif(trim(p_topic), ''), v_body)), 600);
  t public.conversation_threads;
  existing public.conversation_threads;
  members uuid[];
  first_other uuid;
  turns int := greatest(12, least(64, coalesce(p_max_turns, 36)));
  aid uuid;
begin
  if p_starter is null then
    raise exception 'invalid_participants';
  end if;
  if length(v_body) < 8 then
    raise exception 'body_required';
  end if;

  select array_agg(distinct x order by x) into members
  from unnest(array_prepend(p_starter, coalesce(p_participants, '{}'::uuid[]))) as x
  where x is not null;

  if members is null or cardinality(members) < 3 then
    raise exception 'group_needs_three';
  end if;

  select x into first_other
  from unnest(members) as x
  where x <> p_starter
  limit 1;

  select * into existing
  from public.conversation_threads
  where status = 'open'
    and mode = 'group'
    and (p_place is null or place_id is not distinct from p_place or place_id = p_place)
    and participant_ids && members
  order by updated_at desc
  limit 1
  for update;

  if existing.id is not null then
    members := (
      select array_agg(distinct x)
      from unnest(coalesce(existing.participant_ids, '{}'::uuid[]) || members) as x
    );
    insert into public.conversation_messages (thread_id, agent_id, body, kind)
    values (existing.id, p_starter, v_body, 'ask');
    update public.conversation_threads
    set
      participant_ids = members,
      waiting_on = first_other,
      topic = coalesce(nullif(v_topic, ''), existing.topic),
      place_id = coalesce(p_place, existing.place_id),
      max_turns = greatest(existing.max_turns, turns),
      turn_count = existing.turn_count + 1,
      updated_at = now()
    where id = existing.id
    returning * into t;

    foreach aid in array members loop
      update public.agents
      set
        commit_action = 'dialogue',
        commit_detail = left('In group talk: ' || coalesce(t.topic, 'circle'), 400),
        commit_ticks = greatest(coalesce(commit_ticks, 0), 5)
      where id = aid;
    end loop;

    update public.agents
    set
      pending_answer_to = p_starter,
      pending_answer_topic = left(coalesce(t.topic, 'group'), 400),
      pending_answer_question = left(v_body, 4000)
    where id = first_other;

    return t;
  end if;

  insert into public.conversation_threads (
    place_id, starter_id, other_id, topic, status, max_turns, turn_count, waiting_on,
    participant_ids, mode
  ) values (
    p_place,
    p_starter,
    first_other,
    v_topic,
    'open',
    turns,
    1,
    first_other,
    members,
    'group'
  )
  returning * into t;

  insert into public.conversation_messages (thread_id, agent_id, body, kind)
  values (t.id, p_starter, v_body, 'ask');

  foreach aid in array members loop
    update public.agents
    set
      commit_action = 'dialogue',
      commit_detail = left('In group talk: ' || coalesce(v_topic, 'circle'), 400),
      commit_ticks = 5,
      pending_answer_to = null,
      pending_answer_topic = null,
      pending_answer_question = null
    where id = aid;
  end loop;

  update public.agents
  set
    pending_answer_to = p_starter,
    pending_answer_topic = left(coalesce(v_topic, 'group'), 400),
    pending_answer_question = left(v_body, 4000)
  where id = first_other;

  return t;
end;
$function$;
