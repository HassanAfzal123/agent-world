-- Moltbook-style conversation threads: multi-turn dialogue with watcher-visible replies.

create table if not exists public.conversation_threads (
  id uuid primary key default gen_random_uuid(),
  place_id text,
  starter_id uuid not null references public.agents(id) on delete cascade,
  other_id uuid not null references public.agents(id) on delete cascade,
  topic text,
  status text not null default 'open'
    check (status = any (array['open'::text, 'closed'::text])),
  max_turns int not null default 4,
  turn_count int not null default 1,
  waiting_on uuid references public.agents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversation_threads_status_idx
  on public.conversation_threads (status, updated_at desc);
create index if not exists conversation_threads_waiting_idx
  on public.conversation_threads (waiting_on)
  where status = 'open' and waiting_on is not null;
create index if not exists conversation_threads_agents_idx
  on public.conversation_threads (starter_id, other_id);

create table if not exists public.conversation_messages (
  id bigserial primary key,
  thread_id uuid not null references public.conversation_threads(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  body text not null,
  kind text not null default 'reply'
    check (kind = any (array['ask'::text, 'reply'::text, 'share'::text])),
  created_at timestamptz not null default now()
);

create index if not exists conversation_messages_thread_idx
  on public.conversation_messages (thread_id, created_at);

alter table public.conversation_threads enable row level security;
alter table public.conversation_messages enable row level security;

drop policy if exists conversation_threads_public_read on public.conversation_threads;
create policy conversation_threads_public_read
  on public.conversation_threads for select using (true);

drop policy if exists conversation_messages_public_read on public.conversation_messages;
create policy conversation_messages_public_read
  on public.conversation_messages for select using (true);

-- Agents currently in an open dialogue (either side).
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
    and (starter_id = p_agent or other_id = p_agent)
  order by updated_at desc
  limit 1;
  return t;
end;
$$;

revoke all on function public.agent_open_thread(uuid) from public;
grant execute on function public.agent_open_thread(uuid) to anon, authenticated, service_role;

create or replace function public.open_conversation(
  p_starter uuid,
  p_other uuid,
  p_topic text,
  p_body text,
  p_place text default null,
  p_max_turns int default 4
)
returns public.conversation_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  body text := left(trim(coalesce(p_body, '')), 280);
  topic text := left(trim(coalesce(nullif(trim(p_topic), ''), body)), 140);
  t public.conversation_threads;
  existing public.conversation_threads;
begin
  if p_starter is null or p_other is null or p_starter = p_other then
    raise exception 'invalid_participants';
  end if;
  if length(body) < 8 then
    raise exception 'body_required';
  end if;

  -- Reuse open thread between the same pair
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
    -- Append as a reply/ask instead of nesting threads
    insert into public.conversation_messages (thread_id, agent_id, body, kind)
    values (existing.id, p_starter, body, 'ask');
    update public.conversation_threads
    set
      waiting_on = case when existing.waiting_on = p_starter then p_other else p_other end,
      topic = coalesce(nullif(topic, ''), existing.topic),
      place_id = coalesce(p_place, existing.place_id),
      turn_count = least(existing.max_turns, existing.turn_count + 1),
      updated_at = now()
    where id = existing.id
    returning * into t;

    update public.agents
    set
      commit_action = 'dialogue',
      commit_detail = left('In conversation: ' || coalesce(t.topic, 'chat'), 160),
      commit_ticks = greatest(coalesce(commit_ticks, 0), 4),
      pending_answer_to = null,
      pending_answer_topic = null,
      pending_answer_question = null
    where id in (p_starter, p_other);

    update public.agents
    set pending_answer_to = p_starter,
        pending_answer_topic = left(coalesce(t.topic, 'dialogue'), 80),
        pending_answer_question = body
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
    greatest(2, least(8, coalesce(p_max_turns, 4))),
    1,
    p_other
  )
  returning * into t;

  insert into public.conversation_messages (thread_id, agent_id, body, kind)
  values (t.id, p_starter, body, 'ask');

  -- Dialogue lock both; answer debt on the other agent
  update public.agents
  set
    commit_action = 'dialogue',
    commit_detail = left('In conversation: ' || coalesce(topic, 'chat'), 160),
    commit_ticks = 4,
    pending_answer_to = null,
    pending_answer_topic = null,
    pending_answer_question = null
  where id in (p_starter, p_other);

  update public.agents
  set
    pending_answer_to = p_starter,
    pending_answer_topic = left(coalesce(topic, 'dialogue'), 80),
    pending_answer_question = body
  where id = p_other;

  return t;
end;
$$;

revoke all on function public.open_conversation(uuid, uuid, text, text, text, int) from public;
grant execute on function public.open_conversation(uuid, uuid, text, text, text, int) to anon, authenticated, service_role;

create or replace function public.reply_conversation(
  p_thread uuid,
  p_agent uuid,
  p_body text,
  p_kind text default 'reply'
)
returns public.conversation_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  body text := left(trim(coalesce(p_body, '')), 280);
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

  -- Anti-repeat: identical / near-identical last line
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

  -- Clear answer debt on speaker; set on the other if still open
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
      pending_answer_topic = left(coalesce(t.topic, 'dialogue'), 80),
      pending_answer_question = body,
      commit_action = 'dialogue',
      commit_detail = left('In conversation: ' || coalesce(t.topic, 'chat'), 160),
      commit_ticks = greatest(coalesce(commit_ticks, 0), 3)
    where id = next_waiter;

    update public.agents
    set
      commit_action = 'dialogue',
      commit_detail = left('In conversation: ' || coalesce(t.topic, 'chat'), 160),
      commit_ticks = greatest(coalesce(commit_ticks, 0), 3)
    where id = p_agent;
  else
    -- Closed: clear dialogue locks and pending on both
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
$$;

revoke all on function public.reply_conversation(uuid, uuid, text, text) from public;
grant execute on function public.reply_conversation(uuid, uuid, text, text) to anon, authenticated, service_role;

create or replace function public.close_conversation(p_thread uuid)
returns public.conversation_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.conversation_threads;
begin
  update public.conversation_threads
  set status = 'closed', waiting_on = null, updated_at = now()
  where id = p_thread
  returning * into t;

  if t.id is null then
    raise exception 'thread_not_found';
  end if;

  update public.agents
  set
    commit_action = case when commit_action = 'dialogue' then null else commit_action end,
    commit_detail = case when commit_action = 'dialogue' then null else commit_detail end,
    commit_ticks = case when commit_action = 'dialogue' then 0 else commit_ticks end,
    pending_answer_to = case
      when pending_answer_to in (t.starter_id, t.other_id) then null
      else pending_answer_to
    end,
    pending_answer_topic = case
      when pending_answer_to in (t.starter_id, t.other_id) then null
      else pending_answer_topic
    end,
    pending_answer_question = case
      when pending_answer_to in (t.starter_id, t.other_id) then null
      else pending_answer_question
    end
  where id in (t.starter_id, t.other_id);

  return t;
end;
$$;

revoke all on function public.close_conversation(uuid) from public;
grant execute on function public.close_conversation(uuid) to anon, authenticated, service_role;

-- Recent messages for a thread (prompt + UI)
create or replace function public.thread_messages(p_thread uuid, p_limit int default 8)
returns table (
  id bigint,
  thread_id uuid,
  agent_id uuid,
  body text,
  kind text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select m.id, m.thread_id, m.agent_id, m.body, m.kind, m.created_at
  from public.conversation_messages m
  where m.thread_id = p_thread
  order by m.created_at asc
  limit greatest(1, least(40, coalesce(p_limit, 8)));
$$;

revoke all on function public.thread_messages(uuid, int) from public;
grant execute on function public.thread_messages(uuid, int) to anon, authenticated, service_role;
