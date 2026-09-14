-- Multi-agent (group) conversations + longer open threads.
-- Dyads stay back-compat via starter_id/other_id; groups add participant_ids.

alter table public.conversation_threads
  add column if not exists participant_ids uuid[] default null;

alter table public.conversation_threads
  add column if not exists mode text default 'dyad';

alter table public.conversation_threads
  drop constraint if exists conversation_threads_mode_check;

alter table public.conversation_threads
  add constraint conversation_threads_mode_check
  check (mode is null or mode in ('dyad', 'group'));

create index if not exists conversation_threads_participants_gin
  on public.conversation_threads using gin (participant_ids)
  where status = 'open' and mode = 'group';

-- Prefer open group threads that include the agent, else dyad.
create or replace function public.agent_open_thread(p_agent uuid)
returns public.conversation_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.conversation_threads;
begin
  select * into t
  from public.conversation_threads
  where status = 'open'
    and (
      starter_id = p_agent
      or other_id = p_agent
      or (participant_ids is not null and p_agent = any (participant_ids))
    )
  order by
    case when mode = 'group' then 0 else 1 end,
    updated_at desc
  limit 1;
  return t;
end;
$$;

revoke all on function public.agent_open_thread(uuid) from public;
grant execute on function public.agent_open_thread(uuid) to anon, authenticated, service_role;

-- Open a group circle (3+ agents). Starter hosts; other_id = first peer for UI back-compat.
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
  body text := left(trim(coalesce(p_body, '')), 8000);
  topic text := left(trim(coalesce(nullif(trim(p_topic), ''), body)), 600);
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
  if length(body) < 8 then
    raise exception 'body_required';
  end if;

  -- Unique members including starter, drop nulls/self dupes.
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

  -- Reuse open group at same place with overlapping members if recent.
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
    -- Merge participants
    members := (
      select array_agg(distinct x)
      from unnest(coalesce(existing.participant_ids, '{}'::uuid[]) || members) as x
    );
    insert into public.conversation_messages (thread_id, agent_id, body, kind)
    values (existing.id, p_starter, body, 'ask');
    update public.conversation_threads
    set
      participant_ids = members,
      waiting_on = first_other,
      topic = coalesce(nullif(topic, ''), existing.topic),
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
      pending_answer_question = left(body, 4000)
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
    topic,
    'open',
    turns,
    1,
    first_other,
    members,
    'group'
  )
  returning * into t;

  insert into public.conversation_messages (thread_id, agent_id, body, kind)
  values (t.id, p_starter, body, 'ask');

  foreach aid in array members loop
    update public.agents
    set
      commit_action = 'dialogue',
      commit_detail = left('In group talk: ' || coalesce(topic, 'circle'), 400),
      commit_ticks = 5,
      pending_answer_to = null,
      pending_answer_topic = null,
      pending_answer_question = null
    where id = aid;
  end loop;

  update public.agents
  set
    pending_answer_to = p_starter,
    pending_answer_topic = left(coalesce(topic, 'group'), 400),
    pending_answer_question = left(body, 4000)
  where id = first_other;

  return t;
end;
$function$;

revoke all on function public.open_group_conversation(uuid, uuid[], text, text, text, integer) from public;
grant execute on function public.open_group_conversation(uuid, uuid[], text, text, text, integer) to anon, authenticated, service_role;

-- Reply: allow group participants; rotate waiting_on among other members.
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
  members uuid[];
  others uuid[];
  aid uuid;
  is_member boolean := false;
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

  if t.mode = 'group' and t.participant_ids is not null then
    members := t.participant_ids;
    is_member := p_agent = any (members);
  else
    members := array[t.starter_id, t.other_id];
    is_member := (p_agent = t.starter_id or p_agent = t.other_id);
  end if;

  if not is_member then
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

  select array_agg(x) into others
  from unnest(members) as x
  where x is distinct from p_agent;

  if others is null or cardinality(others) = 0 then
    next_waiter := null;
  elsif t.mode = 'group' then
    -- Round-robin: pick next after current waiting_on, else first other.
    select o into next_waiter
    from unnest(others) with ordinality as u(o, ord)
    where ord > coalesce(
      (select ord from unnest(others) with ordinality as v(o2, ord) where o2 = t.waiting_on limit 1),
      0
    )
    order by ord
    limit 1;
    if next_waiter is null then
      next_waiter := others[1];
    end if;
  else
    next_waiter := case
      when p_agent = t.starter_id then t.other_id
      else t.starter_id
    end;
  end if;

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

  if t.status = 'open' and next_waiter is not null then
    update public.agents
    set
      pending_answer_to = p_agent,
      pending_answer_topic = left(coalesce(t.topic, 'dialogue'), 400),
      pending_answer_question = left(body, 4000),
      commit_action = 'dialogue',
      commit_detail = left(
        case when t.mode = 'group' then 'In group talk: ' else 'In conversation: ' end
        || coalesce(t.topic, 'chat'),
        400
      ),
      commit_ticks = greatest(coalesce(commit_ticks, 0), 3)
    where id = next_waiter;

    foreach aid in array members loop
      update public.agents
      set
        commit_action = 'dialogue',
        commit_detail = left(
          case when t.mode = 'group' then 'In group talk: ' else 'In conversation: ' end
          || coalesce(t.topic, 'chat'),
          400
        ),
        commit_ticks = greatest(coalesce(commit_ticks, 0), 3)
      where id = aid;
    end loop;
  else
    foreach aid in array members loop
      update public.agents
      set
        commit_action = case when commit_action = 'dialogue' then 'part' else commit_action end,
        commit_detail = case when commit_action = 'dialogue' then 'Conversation wrapped — move on.' else commit_detail end,
        commit_ticks = case when commit_action = 'dialogue' then 2 else commit_ticks end,
        pending_answer_to = null,
        pending_answer_topic = null,
        pending_answer_question = null
      where id = aid;
    end loop;
  end if;

  return t;
end;
$function$;

-- Longer dyad default turns so open threads stay visible.
create or replace function public.open_conversation(
  p_starter uuid,
  p_other uuid,
  p_topic text,
  p_body text,
  p_place text default null,
  p_max_turns integer default 32
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
  turns int := greatest(12, least(48, coalesce(p_max_turns, 32)));
begin
  if p_starter is null or p_other is null or p_starter = p_other then
    raise exception 'invalid_participants';
  end if;
  if length(body) < 8 then
    raise exception 'body_required';
  end if;

  -- Strip junk topic tags.
  if topic ~* '^(curiosity(_[a-z0-9]+)?)|open_stage|craft_tip|practice|reflection|work_day$' then
    topic := left(trim(body), 600);
  end if;

  select * into existing
  from public.conversation_threads
  where status = 'open'
    and mode is distinct from 'group'
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
      waiting_on = p_other,
      topic = coalesce(nullif(topic, ''), existing.topic),
      place_id = coalesce(p_place, existing.place_id),
      max_turns = greatest(existing.max_turns, turns),
      turn_count = existing.turn_count + 1,
      updated_at = now(),
      mode = coalesce(existing.mode, 'dyad'),
      participant_ids = coalesce(existing.participant_ids, array[p_starter, p_other])
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
    place_id, starter_id, other_id, topic, status, max_turns, turn_count, waiting_on,
    participant_ids, mode
  ) values (
    p_place,
    p_starter,
    p_other,
    topic,
    'open',
    turns,
    1,
    p_other,
    array[p_starter, p_other],
    'dyad'
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
