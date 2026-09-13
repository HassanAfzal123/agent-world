-- Raise conversation speech limits so threads keep full agent speech.
-- Bodies: 2400 -> 8000; topics: 280 -> 600; pending questions: 1200 -> 4000.
-- Also keep richer copies in agent memories / city_log when applying acts.

create or replace function public.open_conversation(
  p_starter uuid,
  p_other uuid,
  p_topic text,
  p_body text,
  p_place text default null,
  p_max_turns integer default 24
)
returns conversation_threads
language plpgsql
security definer
set search_path to public
as $function$
declare
  body text := left(trim(coalesce(p_body, '')), 8000);
  topic text := left(trim(coalesce(nullif(trim(p_topic), ''), body)), 600);
  t public.conversation_threads;
  existing public.conversation_threads;
  turns int := greatest(8, least(48, coalesce(p_max_turns, 24)));
begin
  if p_starter is null or p_other is null or p_starter = p_other then
    raise exception 'invalid_participants';
  end if;
  if length(body) < 8 then
    raise exception 'body_required';
  end if;

  select * into existing
  from public.conversation_threads
  where status = 'open'
    and (
      (starter_id = p_starter and other_id = p_other)
      or (starter_id = p_other and other_id = p_starter)
    )
  order by updated_at desc
  limit 1
  for update;

  if existing.id is not null then
    insert into public.conversation_messages (thread_id, agent_id, body, kind)
    values (existing.id, p_starter, body, 'ask');
    update public.conversation_threads
    set
      waiting_on = case when existing.waiting_on = p_starter then p_other else p_other end,
      topic = coalesce(nullif(topic, ''), existing.topic),
      place_id = coalesce(p_place, existing.place_id),
      max_turns = greatest(existing.max_turns, turns),
      turn_count = existing.turn_count + 1,
      updated_at = now()
    where id = existing.id
    returning * into t;

    update public.agents
    set
      commit_action = 'dialogue',
      commit_detail = left('In conversation: ' || coalesce(t.topic, 'chat'), 400),
      commit_ticks = greatest(coalesce(commit_ticks, 0), 4),
      pending_answer_to = null,
      pending_answer_topic = null,
      pending_answer_question = null
    where id in (p_starter, p_other);

    update public.agents
    set pending_answer_to = p_starter,
        pending_answer_topic = left(coalesce(t.topic, 'dialogue'), 400),
        pending_answer_question = left(body, 4000)
    where id = p_other;

    return t;
  end if;

  insert into public.conversation_threads (
    place_id, starter_id, other_id, topic, status, max_turns, turn_count, waiting_on
  ) values (
    p_place,
    p_starter,
    p_other,
    topic,
    'open',
    turns,
    1,
    p_other
  )
  returning * into t;

  insert into public.conversation_messages (thread_id, agent_id, body, kind)
  values (t.id, p_starter, body, 'ask');

  update public.agents
  set
    commit_action = 'dialogue',
    commit_detail = left('In conversation: ' || coalesce(topic, 'chat'), 400),
    commit_ticks = 4,
    pending_answer_to = null,
    pending_answer_topic = null,
    pending_answer_question = null
  where id in (p_starter, p_other);

  update public.agents
  set
    pending_answer_to = p_starter,
    pending_answer_topic = left(coalesce(topic, 'dialogue'), 400),
    pending_answer_question = left(body, 4000)
  where id = p_other;

  return t;
end;
$function$;

create or replace function public.reply_conversation(
  p_thread uuid,
  p_agent uuid,
  p_body text,
  p_kind text default 'reply'
)
returns conversation_threads
language plpgsql
security definer
set search_path to public
as $function$
declare
  body text := left(trim(coalesce(p_body, '')), 8000);
  kind text := coalesce(nullif(trim(p_kind), ''), 'reply');
  t public.conversation_threads;
  last_body text;
  next_waiter uuid;
begin
  if p_thread is null or p_agent is null then
    raise exception 'invalid_reply';
  end if;
  if length(body) < 8 then
    raise exception 'body_required';
  end if;
  if kind not in ('ask', 'reply', 'share') then
    kind := 'reply';
  end if;

  select * into t
  from public.conversation_threads
  where id = p_thread
  for update;

  if t.id is null then
    raise exception 'thread_not_found';
  end if;
  if t.status <> 'open' then
    raise exception 'thread_closed';
  end if;
  if p_agent <> t.starter_id and p_agent <> t.other_id then
    raise exception 'not_participant';
  end if;

  select m.body into last_body
  from public.conversation_messages m
  where m.thread_id = t.id
  order by m.created_at desc
  limit 1;

  if last_body is not null
     and lower(left(last_body, 48)) = lower(left(body, 48)) then
    raise exception 'repeat_message';
  end if;

  insert into public.conversation_messages (thread_id, agent_id, body, kind)
  values (t.id, p_agent, body, kind);

  next_waiter := case
    when p_agent = t.starter_id then t.other_id
    else t.starter_id
  end;

  update public.conversation_threads
  set
    turn_count = t.turn_count + 1,
    updated_at = now(),
    status = case
      when t.turn_count + 1 >= t.max_turns then 'closed'
      else 'open'
    end,
    waiting_on = case
      when t.turn_count + 1 >= t.max_turns then null
      else next_waiter
    end
  where id = t.id
  returning * into t;

  update public.agents
  set
    pending_answer_to = null,
    pending_answer_topic = null,
    pending_answer_question = null
  where id = p_agent;

  if t.status = 'open' then
    update public.agents
    set
      pending_answer_to = p_agent,
      pending_answer_topic = left(coalesce(t.topic, 'dialogue'), 400),
      pending_answer_question = left(body, 4000),
      commit_action = 'dialogue',
      commit_detail = left('In conversation: ' || coalesce(t.topic, 'chat'), 400),
      commit_ticks = greatest(coalesce(commit_ticks, 0), 3)
    where id = next_waiter;

    update public.agents
    set
      commit_action = 'dialogue',
      commit_detail = left('In conversation: ' || coalesce(t.topic, 'chat'), 400),
      commit_ticks = greatest(coalesce(commit_ticks, 0), 3)
    where id = p_agent;
  else
    update public.agents
    set
      commit_action = case when commit_action = 'dialogue' then 'part' else commit_action end,
      commit_detail = case when commit_action = 'dialogue' then 'Conversation wrapped — move on.' else commit_detail end,
      commit_ticks = case when commit_action = 'dialogue' then 2 else commit_ticks end,
      pending_answer_to = null,
      pending_answer_topic = null,
      pending_answer_question = null
    where id in (t.starter_id, t.other_id);
  end if;

  return t;
end;
$function$;

-- Widen speech retained in memories / logs inside apply_agent_action.
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
  def := replace(def, 'thought=left(trim(p_thought),220)', 'thought=left(trim(p_thought),2000)');
  def := replace(def, 'left(msg,180)', 'left(msg,2000)');
  def := replace(def, 'left(msg,160)', 'left(msg,2000)');
  def := replace(def, 'left(msg,140)', 'left(msg,2000)');
  def := replace(def, 'left(msg,120)', 'left(msg,2000)');
  def := replace(def, 'left(msg,80)', 'left(msg,800)');
  def := replace(def, 'left(spoke,80)', 'left(spoke,800)');
  def := replace(def, 'left(lesson,160)', 'left(lesson,2000)');
  def := replace(def, 'left(lesson,140)', 'left(lesson,2000)');
  def := replace(def, 'left(lesson,120)', 'left(lesson,2000)');
  execute def;
end
$fix$;
