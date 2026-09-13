-- Fresher learning: dedupe teach/share + new verbs ask_question, practice_skill, debate, demo
CREATE OR REPLACE FUNCTION public.apply_agent_action(
  p_agent_id uuid,
  p_action text,
  p_target_place text DEFAULT NULL,
  p_target_agent uuid DEFAULT NULL,
  p_utterance text DEFAULT NULL,
  p_thought text DEFAULT NULL,
  p_item text DEFAULT NULL,
  p_plan text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  a public.agents%rowtype;
  dest public.places%rowtype;
  other public.agents%rowtype;
  obj public.town_objects%rowtype;
  listener public.agents%rowtype;
  msg text;
  spoke text;
  lesson text;
  topic text;
  skill text;
  inserted int := 0;
  skipped int := 0;
begin
  select * into a from agents where id=p_agent_id for update;
  if a.id is null then return jsonb_build_object('ok',false,'error','agent_not_found'); end if;

  spoke := nullif(trim(coalesce(p_utterance,'')), '');
  if p_thought is not null and length(trim(p_thought))>0 then
    update agents set thought=left(trim(p_thought),220) where id=a.id;
  end if;

  if a.status = 'walking' and a.target_place_id is not null and p_action in ('walk','idle','continue') then
    return jsonb_build_object('ok',true,'action','walking','deferred',true,'dest',a.target_place_id);
  end if;
  if p_action='continue' then
    return jsonb_build_object('ok',true,'action','idle');
  end if;

  if p_action='set_plan' then
    update agents set
      day_plan = left(coalesce(p_plan, p_utterance, p_thought, 'Explore town.'), 280),
      plan_hour = (select hour from city_meta where id=1),
      status='planning', last_action='set_plan', last_tick_at=now()
    where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'plan', a.name||' plans: "'||left(coalesce(p_plan,p_utterance,'Explore.'),160)||'"');
    return jsonb_build_object('ok',true,'action','set_plan');
  end if;

  if p_action='idle' then
    update agents set status='idle', last_action='idle', last_tick_at=now() where id=a.id;
    return jsonb_build_object('ok',true,'action','idle');
  end if;

  if p_action='sleep' then
    select * into dest from places where kind='home' order by random() limit 1;
    if p_target_place is not null then select * into dest from places where id=p_target_place; end if;
    if dest.id is null then return jsonb_build_object('ok',false,'error','no_home'); end if;
    update agents set target_place_id=dest.id, status='walking', path='[]'::jsonb, place_id=null, last_action='sleep', last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message) values (a.id,'sleep', a.name||' is heading home to sleep.');
    return jsonb_build_object('ok',true,'action','walk','dest',dest.id,'deferred',true);
  end if;

  if p_action='walk' then
    if p_target_place is null then return jsonb_build_object('ok',false,'error','need_place'); end if;
    select * into dest from places where id=p_target_place;
    if dest.id is null then return jsonb_build_object('ok',false,'error','bad_place'); end if;
    if a.place_id = dest.id and a.target_place_id is null then
      update agents set status='idle', last_action='walk', last_tick_at=now() where id=a.id;
      return jsonb_build_object('ok',true,'action','already_there','place',dest.id);
    end if;
    update agents set target_place_id=dest.id, status='walking', path='[]'::jsonb, place_id=null, last_action='walk', last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message) values (a.id,'move', a.name||' set out for '||dest.name||'.');
    return jsonb_build_object('ok',true,'action','walk','dest',dest.id,'deferred',true);
  end if;

  if p_action='talk' then
    if p_target_agent is not null then select * into other from agents where id=p_target_agent;
    else select * into other from agents where id<>a.id and abs(x-a.x)<=3 and abs(y-a.y)<=3 order by random() limit 1;
    end if;
    if other.id is null then return jsonb_build_object('ok',false,'error','no_one_nearby'); end if;
    if abs(other.x-a.x)>3 or abs(other.y-a.y)>3 then
      return jsonb_build_object('ok',false,'error','too_far');
    end if;
    msg := coalesce(spoke, 'Hey '||other.name||'.');
    update agents set status='talking', target_place_id=null, path='[]'::jsonb, last_action='talk', last_tick_at=now(), energy=greatest(0,energy-1) where id=a.id;
    insert into city_log(agent_id,kind,message) values (a.id,'say', a.name||' → '||other.name||': "'||left(msg,180)||'"');
    insert into agent_memories(agent_id,content,kind,source_agent_id) values
      (a.id, 'I told '||other.name||': '||left(msg,140), 'memory', other.id),
      (other.id, a.name||' told me: '||left(msg,140), 'memory', a.id);
    perform public.bump_relationship(a.id, other.id, 1, 'Talked: '||left(msg,80));
    perform public.bump_relationship(other.id, a.id, 1, 'Heard: '||left(msg,80));
    -- Answering a pending question with talk still clears the obligation
    if a.pending_answer_to = other.id then
      perform public.clear_pending_answer(a.id);
      perform public.clear_open_question(a.id, other.id);
      perform public.note_peer_topic(a.id, other.id, coalesce(a.pending_answer_topic, 'reply'), null, null);
    end if;
    return jsonb_build_object('ok',true,'action','talk','to',other.name);
  end if;

  if p_action='ask_question' then
    if p_target_agent is null then return jsonb_build_object('ok',false,'error','need_agent'); end if;
    select * into other from agents where id=p_target_agent;
    if other.id is null or abs(other.x-a.x)>4 or abs(other.y-a.y)>4 then
      return jsonb_build_object('ok',false,'error','too_far');
    end if;
    msg := coalesce(spoke, 'What is one concrete step in your craft that surprised you lately?');
    topic := left(coalesce(nullif(trim(p_item),''), 'curiosity'), 60);
    update agents set status='talking', last_action='ask_question', last_tick_at=now(), energy=greatest(0,energy-1) where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'say', a.name||' asks '||other.name||' ['||topic||']: "'||left(msg,160)||'"');
    insert into agent_memories(agent_id,content,kind,source_agent_id) values
      (a.id, 'I asked '||other.name||' about '||topic||': '||left(msg,120), 'memory', other.id),
      (other.id, a.name||' asked me about '||topic||': '||left(msg,120), 'memory', a.id);
    perform public.bump_relationship(a.id, other.id, 1, 'Asked: '||left(msg,80));
    perform public.bump_relationship(other.id, a.id, 1, 'Was asked: '||left(msg,80));
    perform public.note_peer_topic(a.id, other.id, topic, msg, a.id);
    perform public.note_peer_topic(other.id, a.id, topic, msg, a.id);
    -- Target must answer next (no LLM required if tick forces reply)
    perform public.set_pending_answer(other.id, a.id, topic, msg);
    return jsonb_build_object('ok',true,'action','ask_question','to',other.name,'topic',topic);
  end if;

  if p_action='practice_skill' then
    skill := left(coalesce(nullif(trim(p_item),''), 'reflection'), 60);
    msg := coalesce(spoke, 'Practicing '||replace(skill,'_',' ')||'.');
    perform public.append_skill(a.id, skill);
    update agents set status='working', last_action='practice_skill',
      thought=left('Practicing: '||skill||' — '||msg, 200), last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'learn', a.name||' practices '||skill||'.');
    insert into agent_memories(agent_id,content,kind)
      values (a.id, 'Practiced skill '||skill||': '||left(msg,140), 'lesson');
    return jsonb_build_object('ok',true,'action','practice_skill','skill',skill);
  end if;

  if p_action='share_experience' then
    lesson := left(coalesce(spoke, p_plan, 'I had a useful day — process over secrets.'), 220);
    topic := left(coalesce(p_item, p_plan, 'work_day'), 60);
    skill := left(coalesce(nullif(trim(p_item),''), 'shared_practice'), 60);
    update agents set status='talking', last_action='share_experience', last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'learn', a.name||' shares experience ('||topic||'): "'||left(lesson,160)||'"');
    insert into agent_memories(agent_id,content,kind) values
      (a.id, 'I shared: '||left(lesson,160), 'shared');

    for listener in
      select * from agents
      where id <> a.id and abs(x-a.x)<=4 and abs(y-a.y)<=4
    loop
      if public.lesson_already_known(listener.id, topic, lesson) then
        skipped := skipped + 1;
        continue;
      end if;
      if not public.can_absorb_lesson(listener.id) then
        skipped := skipped + 1;
        continue;
      end if;
      insert into agent_lessons(teacher_id, learner_id, topic, lesson)
        values (a.id, listener.id, topic, lesson);
      insert into agent_memories(agent_id,content,kind,source_agent_id)
        values (listener.id, 'Learned from '||a.name||' ['||topic||']: '||left(lesson,160), 'lesson', a.id);
      perform public.append_skill(listener.id, skill);
      perform public.bump_relationship(listener.id, a.id, 2, 'Learned from them');
      perform public.bump_relationship(a.id, listener.id, 1, 'Taught them');
      perform public.note_peer_topic(a.id, listener.id, topic, null, null);
      perform public.note_peer_topic(listener.id, a.id, topic, null, null);
      perform public.clear_open_question(a.id, listener.id);
      if listener.pending_answer_to = a.id then
        perform public.clear_pending_answer(listener.id);
      end if;
      inserted := inserted + 1;
    end loop;

    if inserted = 0 and skipped > 0 then
      return jsonb_build_object('ok',true,'action','share_experience','topic',topic,'skipped','duplicate_lesson','skipped_n',skipped);
    end if;
    return jsonb_build_object('ok',true,'action','share_experience','topic',topic,'inserted',inserted);
  end if;

  if p_action='teach' then
    if p_target_agent is null then return jsonb_build_object('ok',false,'error','need_agent'); end if;
    select * into other from agents where id=p_target_agent;
    if other.id is null or abs(other.x-a.x)>4 or abs(other.y-a.y)>4 then
      return jsonb_build_object('ok',false,'error','too_far');
    end if;
    lesson := left(coalesce(spoke, 'Here is a practice that helped me.'), 220);
    topic := left(coalesce(p_item, 'craft'), 60);
    skill := left(coalesce(nullif(trim(p_item),''), 'craft_tip'), 60);
    update agents set status='talking', last_action='teach', last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'learn', a.name||' teaches '||other.name||' ('||topic||'): "'||left(lesson,140)||'"');

    if public.lesson_already_known(other.id, topic, lesson) then
      insert into agent_memories(agent_id,content,kind,source_agent_id) values
        (a.id, 'Tried to teach '||other.name||' ['||topic||'] but they already knew it', 'memory', other.id);
      -- Still clears pending ask if they were waiting on us
      if a.pending_answer_to = other.id then
        perform public.clear_pending_answer(a.id);
        perform public.clear_open_question(a.id, other.id);
      end if;
      return jsonb_build_object('ok',true,'action','teach','to',other.name,'skipped','duplicate_lesson');
    end if;

    if not public.can_absorb_lesson(other.id) then
      if a.pending_answer_to = other.id then
        perform public.clear_pending_answer(a.id);
        perform public.clear_open_question(a.id, other.id);
      end if;
      return jsonb_build_object('ok',true,'action','teach','to',other.name,'skipped','daily_lesson_cap');
    end if;

    insert into agent_lessons(teacher_id, learner_id, topic, lesson)
      values (a.id, other.id, topic, lesson);
    insert into agent_memories(agent_id,content,kind,source_agent_id) values
      (a.id, 'I taught '||other.name||': '||left(lesson,140), 'shared', other.id),
      (other.id, 'Lesson from '||a.name||' ['||topic||']: '||left(lesson,160), 'lesson', a.id);
    perform public.append_skill(other.id, skill);
    perform public.bump_relationship(a.id, other.id, 2, 'Taught');
    perform public.bump_relationship(other.id, a.id, 3, 'Was taught');
    perform public.note_peer_topic(a.id, other.id, topic, null, null);
    perform public.note_peer_topic(other.id, a.id, topic, null, null);
    perform public.clear_open_question(a.id, other.id);
    if a.pending_answer_to = other.id then
      perform public.clear_pending_answer(a.id);
    end if;
    return jsonb_build_object('ok',true,'action','teach','to',other.name);
  end if;

  if p_action='debate' then
    if p_target_agent is null then return jsonb_build_object('ok',false,'error','need_agent'); end if;
    select * into other from agents where id=p_target_agent;
    if other.id is null or abs(other.x-a.x)>4 or abs(other.y-a.y)>4 then
      return jsonb_build_object('ok',false,'error','too_far');
    end if;
    lesson := left(coalesce(spoke, 'We compared methods and kept the sharper step.'), 220);
    topic := left(coalesce(p_item, 'debate_insight'), 60);
    skill := left(coalesce(nullif(trim(p_item),''), 'debate_insight'), 60);
    msg := coalesce(spoke, 'Let us compare approaches.');
    update agents set status='talking', last_action='debate', last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'say', a.name||' debates '||other.name||' ['||topic||']: "'||left(msg,140)||'"');
    insert into agent_memories(agent_id,content,kind,source_agent_id) values
      (a.id, 'Debated with '||other.name||': '||left(msg,120), 'memory', other.id),
      (other.id, a.name||' debated with me: '||left(msg,120), 'memory', a.id);
    perform public.bump_relationship(a.id, other.id, 1, 'Debated');
    perform public.bump_relationship(other.id, a.id, 1, 'Debated');

    -- Novel conclusion only → lesson both ways (slow daily absorb)
    if not public.lesson_already_known(other.id, topic, lesson) and public.can_absorb_lesson(other.id) then
      insert into agent_lessons(teacher_id, learner_id, topic, lesson) values (a.id, other.id, topic, lesson);
      perform public.append_skill(other.id, skill);
      inserted := inserted + 1;
    else
      skipped := skipped + 1;
    end if;
    if not public.lesson_already_known(a.id, topic, lesson) and public.can_absorb_lesson(a.id) then
      insert into agent_lessons(teacher_id, learner_id, topic, lesson) values (other.id, a.id, topic, lesson);
      perform public.append_skill(a.id, skill);
      inserted := inserted + 1;
    else
      skipped := skipped + 1;
    end if;
    perform public.note_peer_topic(a.id, other.id, topic, null, null);
    perform public.note_peer_topic(other.id, a.id, topic, null, null);
    perform public.clear_open_question(a.id, other.id);
    if a.pending_answer_to = other.id then
      perform public.clear_pending_answer(a.id);
    end if;
    if other.pending_answer_to = a.id then
      perform public.clear_pending_answer(other.id);
    end if;
    if inserted = 0 then
      return jsonb_build_object('ok',true,'action','debate','to',other.name,'skipped','duplicate_lesson');
    end if;
    return jsonb_build_object('ok',true,'action','debate','to',other.name,'topic',topic);
  end if;

  if p_action='demo' then
    lesson := left(coalesce(spoke, 'Watch this once — here is the method.'), 220);
    topic := left(coalesce(p_item, 'demo_method'), 60);
    skill := left(coalesce(nullif(trim(p_item),''), 'demo_method'), 60);
    update agents set status='working', last_action='demo', last_tick_at=now(), energy=greatest(0,energy-2) where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'learn', a.name||' demos ('||topic||'): "'||left(lesson,140)||'"');
    insert into agent_memories(agent_id,content,kind)
      values (a.id, 'I demoed: '||left(lesson,160), 'shared');

    for listener in
      select * from agents
      where id <> a.id and abs(x-a.x)<=5 and abs(y-a.y)<=5
    loop
      if public.lesson_already_known(listener.id, topic, lesson) then
        skipped := skipped + 1;
        continue;
      end if;
      insert into agent_lessons(teacher_id, learner_id, topic, lesson)
        values (a.id, listener.id, topic, lesson);
      insert into agent_memories(agent_id,content,kind,source_agent_id)
        values (listener.id, 'Saw demo from '||a.name||' ['||topic||']: '||left(lesson,160), 'lesson', a.id);
      perform public.append_skill(listener.id, skill);
      perform public.bump_relationship(listener.id, a.id, 2, 'Saw their demo');
      inserted := inserted + 1;
    end loop;
    if inserted = 0 and skipped > 0 then
      return jsonb_build_object('ok',true,'action','demo','topic',topic,'skipped','duplicate_lesson');
    end if;
    return jsonb_build_object('ok',true,'action','demo','topic',topic,'inserted',inserted);
  end if;

  if p_action='reflect' then
    select left(al.lesson, 120) into lesson from agent_lessons al
      where al.learner_id=a.id order by al.created_at desc limit 1;
    if lesson is null then
      lesson := left(coalesce(a.origin_summary, 'I revisit what I already know.'), 120);
    end if;
    skill := left(coalesce(p_item, 'reflection'), 60);
    perform public.append_skill(a.id, skill);
    update agents set status='idle', last_action='reflect',
      thought=left('Reflecting: '||lesson, 200), last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'learn', a.name||' reflects and keeps a lesson.');
    insert into agent_memories(agent_id,content,kind)
      values (a.id, 'Reflection: '||lesson, 'lesson');
    return jsonb_build_object('ok',true,'action','reflect');
  end if;

  if p_action in ('ask_favor','accept','refuse','join') then
    if p_target_agent is null then return jsonb_build_object('ok',false,'error','need_agent'); end if;
    select * into other from agents where id=p_target_agent;
    if other.id is null then return jsonb_build_object('ok',false,'error','bad_agent'); end if;
    if abs(other.x-a.x)>4 or abs(other.y-a.y)>4 then return jsonb_build_object('ok',false,'error','too_far'); end if;
    msg := coalesce(spoke,
      case p_action when 'ask_favor' then 'Could you help me with something?'
        when 'accept' then 'Yes — I am in.' when 'refuse' then 'Not this time.'
        else 'Come with me.' end);
    update agents set status='talking', last_action=p_action, last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'favor', a.name||' ['||p_action||'] → '||other.name||': "'||left(msg,160)||'"');
    insert into agent_memories(agent_id,content,kind,source_agent_id)
      values (a.id, p_action||' toward '||other.name||': '||left(msg,120), 'memory', other.id),
             (other.id, a.name||' '||p_action||': '||left(msg,120), 'memory', a.id);
    perform public.bump_relationship(a.id, other.id,
      case p_action when 'refuse' then -1 when 'accept' then 2 when 'join' then 2 else 1 end,
      p_action||': '||left(msg,80));
    return jsonb_build_object('ok',true,'action',p_action,'to',other.name);
  end if;

  if p_action='give' then
    if p_target_agent is null then return jsonb_build_object('ok',false,'error','need_agent'); end if;
    select * into other from agents where id=p_target_agent;
    if other.id is null or abs(other.x-a.x)>3 or abs(other.y-a.y)>3 then
      return jsonb_build_object('ok',false,'error','too_far');
    end if;
    if p_item is not null then
      select * into obj from town_objects where id=p_item for update;
      if obj.id is not null then
        update town_objects set holder_id=other.id, place_id=null where id=obj.id;
      end if;
    end if;
    msg := coalesce(spoke, 'Here — take this'||case when p_item is null then '.' else ' ('||p_item||').' end);
    update agents set status='giving', last_action='give', last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message) values (a.id,'give', a.name||' gives to '||other.name||': "'||left(msg,140)||'"');
    perform public.bump_relationship(a.id, other.id, 2, 'Gave something');
    perform public.bump_relationship(other.id, a.id, 2, 'Received something');
    return jsonb_build_object('ok',true,'action','give');
  end if;

  if p_action='leave_note' then
    insert into notices(author_id, place_id, body)
      values (a.id, coalesce(p_target_place, a.place_id, 'notice'), left(coalesce(spoke, p_plan, 'Looking for company.'), 200));
    update agents set status='posting', last_action='leave_note', last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'post', a.name||' left a note: "'||left(coalesce(spoke,'Looking for company.'),140)||'"');
    return jsonb_build_object('ok',true,'action','leave_note');
  end if;

  if p_action='inspect' then
    if p_item is not null then select * into obj from town_objects where id=p_item; end if;
    if obj.id is null then
      select * into obj from town_objects where place_id=a.place_id or holder_id=a.id order by random() limit 1;
    end if;
    if obj.id is null then return jsonb_build_object('ok',false,'error','no_object'); end if;
    update agents set status='idle', last_action='inspect', thought=left('Noticing '||obj.name||': '||coalesce(obj.note,''),200), last_tick_at=now() where id=a.id;
    insert into city_log(agent_id,kind,message)
      values (a.id,'thought', a.name||' inspects '||obj.name||' ('||obj.state||').');
    insert into agent_memories(agent_id,content,kind) values (a.id, 'Saw '||obj.name||' at '||coalesce(obj.place_id,'hand')||': '||coalesce(obj.note,''), 'memory');
    return jsonb_build_object('ok',true,'action','inspect','item',obj.id);
  end if;

  if p_action='fix' then
    select * into obj from town_objects where id=coalesce(p_item,'broken_stall') for update;
    if obj.id is null then return jsonb_build_object('ok',false,'error','no_object'); end if;
    if obj.state='broken' then
      update town_objects set state='ok', note='Repaired by '||a.name where id=obj.id;
      msg := a.name||' fixed the '||obj.name||'.';
    else
      msg := a.name||' checked the '||obj.name||' — already fine.';
    end if;
    update agents set status='working', last_action='fix', last_tick_at=now(), energy=greatest(0,energy-3) where id=a.id;
    insert into city_log(agent_id,kind,message) values (a.id,'work', msg);
    return jsonb_build_object('ok',true,'action','fix');
  end if;

  if p_action in ('work','eat','shop','post_notice','watch_show','rest','start_shift') then
    update agents set
      status = case p_action when 'work' then 'working' when 'start_shift' then 'working' when 'eat' then 'eating'
        when 'shop' then 'shopping' when 'post_notice' then 'posting' when 'watch_show' then 'watching' else 'idle' end,
      target_place_id=null,
      path='[]'::jsonb,
      last_action=p_action,
      energy=case when p_action in ('eat','rest') then least(100,energy+8) else greatest(0,energy-2) end,
      last_tick_at=now()
    where id=a.id;
    if p_action in ('post_notice','leave_note') then
      insert into notices(author_id, place_id, body)
        values (a.id, coalesce(a.place_id,'notice'), left(coalesce(spoke,'Looking for company.'),200));
    end if;
    msg := case p_action
      when 'work' then a.name||' worked'||case when a.job is null then '.' else ' as '||a.job||'.' end
      when 'start_shift' then a.name||' started a shift'||case when a.job is null then '.' else ' as '||a.job||'.' end
      when 'eat' then a.name||' ate'||case when spoke is null then '.' else ': "'||left(spoke,80)||'"' end
      when 'shop' then a.name||' shopped around.'
      when 'post_notice' then a.name||' posted: "'||left(coalesce(spoke,'Hello town.'),120)||'"'
      when 'watch_show' then a.name||' watched the stage.'
      else a.name||' rested.' end;
    insert into city_log(agent_id,kind,message) values (a.id,
      case p_action when 'work' then 'work' when 'start_shift' then 'work' when 'eat' then 'eat' when 'shop' then 'shop'
        when 'post_notice' then 'post' when 'watch_show' then 'watch' else 'rest' end, msg);
    return jsonb_build_object('ok',true,'action',p_action);
  end if;

  return jsonb_build_object('ok',false,'error','unknown_action');
end;
$function$;
