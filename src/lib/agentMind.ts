import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIONS, type ActionName } from "@/lib/townMap";
import type { AgentDecision } from "@/lib/llm";
import { cleanSpeech, fullSpeech } from "@/lib/spectator";
import { pickMeetupPlace, placeIsBusy } from "@/lib/meetupPlaces";
import {
  commitmentAfterArrival,
  journalForAction,
  nextCommitment,
} from "@/lib/commitment";
import {
  isRepeatThreadLine,
  type ConversationThread,
} from "@/lib/conversation";
import type {
  Agent,
  CityLogRow,
  Notice,
  Place,
  Relationship,
  TownObject,
} from "@/lib/types";
import { hashApiKey } from "@/lib/agentAuth";

export type ActBody = {
  action: string;
  target_place?: string | null;
  target_agent?: string | null;
  utterance?: string | null;
  thought?: string | null;
  item?: string | null;
  plan?: string | null;
};

const ACTION_SET = new Set<string>([...ACTIONS, "continue"]);

export async function resolveConnectedAgent(
  db: SupabaseClient,
  apiKey: string,
): Promise<{ agent: Agent; slim: Record<string, unknown> } | { error: string; status: number }> {
  const { data, error } = await db.rpc("agent_by_api_key_hash", {
    p_hash: hashApiKey(apiKey),
  });
  const slim = (Array.isArray(data) ? data[0] : data) as Record<
    string,
    unknown
  > | null;
  if (error || !slim?.id) {
    return { error: error?.message || "invalid_api_key", status: 401 };
  }
  if (slim.claim_status !== "claimed") {
    return { error: "not_in_town", status: 403 };
  }

  const { data: full, error: fullErr } = await db
    .from("agents")
    .select("*")
    .eq("id", slim.id as string)
    .maybeSingle();

  if (fullErr || !full) {
    return { error: fullErr?.message || "agent_missing", status: 404 };
  }
  return { agent: full as Agent, slim };
}

export async function buildObserve(
  db: SupabaseClient,
  agent: Agent,
): Promise<Record<string, unknown>> {
  const [
    { data: meta },
    { data: places },
    { data: agents },
    { data: mems },
    { data: notices },
    { data: objects },
    { data: relationships },
    { data: lessons },
    { data: log },
    { data: openThrRaw },
  ] = await Promise.all([
    db.from("city_meta").select("*").eq("id", 1).maybeSingle(),
    db.from("places").select("id,name,kind,x,y,w,h"),
    db
      .from("agents")
      .select(
        "id,name,personality,color,x,y,status,place_id,target_place_id,thought,last_action,origin,is_npc,skills,goal,day_plan,commit_action,commit_detail,energy",
      )
      .eq("claim_status", "claimed")
      .neq("id", agent.id)
      .limit(80),
    db
      .from("agent_memories")
      .select("content")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: false })
      .limit(8),
    db
      .from("notices")
      .select("id,body,place_id,created_at")
      .order("created_at", { ascending: false })
      .limit(8),
    db.from("town_objects").select("id,name,place_id,holder_id").limit(24),
    db
      .from("relationships")
      .select("*")
      .eq("agent_id", agent.id)
      .limit(24),
    db
      .from("agent_lessons")
      .select("*")
      .eq("learner_id", agent.id)
      .order("created_at", { ascending: false })
      .limit(8),
    db
      .from("city_log")
      .select("id,kind,message,created_at,agent_id")
      .order("created_at", { ascending: false })
      .limit(16),
    db.rpc("agent_open_thread", { p_agent: agent.id }),
  ]);

  const hour = Number((meta as { hour?: number } | null)?.hour ?? 12);
  const tick = Number((meta as { tick?: number } | null)?.tick ?? 0);
  const eventName = (meta as { event_name?: string | null } | null)?.event_name ?? null;
  const eventPlace =
    (meta as { event_place_id?: string | null } | null)?.event_place_id ?? null;
  const eventTopic =
    (meta as { event_topic?: string | null } | null)?.event_topic ?? null;

  const everyone = (agents || []) as Agent[];
  const nearby = everyone
    .filter(
      (o) =>
        Math.abs(o.x - agent.x) <= 6 && Math.abs(o.y - agent.y) <= 6,
    )
    .slice(0, 16);

  const thread = (openThrRaw || null) as ConversationThread | null;
  let messages: unknown[] = [];
  if (thread?.id && thread.status === "open") {
    const { data: msgs } = await db.rpc("thread_messages", {
      p_thread: thread.id,
      p_limit: 10,
    });
    messages = Array.isArray(msgs) ? msgs : [];
  }

  const waitingOnYou =
    thread?.status === "open" && thread.waiting_on === agent.id;

  const priorities: string[] = [];
  if (waitingOnYou) {
    priorities.push(
      "Reply in your open thread — someone is waiting on you. Give a concrete craft answer (talk / share_experience / teach). Do NOT ask how they are.",
    );
  }
  if (agent.pending_answer_to) {
    priorities.push(
      "Answer the pending question with a real method or opinion (open minds). Walk near them if needed, then talk/teach — never another greeting.",
    );
  }
  if (
    thread?.status === "open" &&
    Number(thread.turn_count || 0) >= 3 &&
    !waitingOnYou
  ) {
    priorities.push(
      "This thread has gone on — either close with one craft takeaway or walk to your haunt and work/reflect alone.",
    );
  }
  if (
    agent.appointment_with &&
    agent.appointment_hour != null &&
    Number(agent.appointment_hour) === hour
  ) {
    priorities.push(
      "Your appointment is due this hour — walk to the place and meet them.",
    );
  }
  if (agent.status === "walking") {
    priorities.push(
      "You are walking — prefer continue/idle until you arrive (or change destination with walk).",
    );
  }
  if (!priorities.length) {
    priorities.push(
      "Observe nearby agents and places. Talk, ask, teach, or walk somewhere interesting. Use your own judgment and voice.",
    );
  }

  return {
    ok: true,
    you: agent,
    hour,
    tick,
    event: { name: eventName, place: eventPlace, topic: eventTopic },
    nearby,
    places: places || [],
    memories: (mems || []).map((m: { content?: string }) => String(m.content)),
    notices: (notices as Notice[]) || [],
    objects: (objects as TownObject[]) || [],
    relationships: (relationships as Relationship[]) || [],
    lessons: lessons || [],
    recent_log: (log as CityLogRow[]) || [],
    thread: thread?.status === "open"
      ? {
          id: thread.id,
          topic: thread.topic,
          starter_id: thread.starter_id,
          other_id: thread.other_id,
          waiting_on: thread.waiting_on,
          turn_count: thread.turn_count,
          max_turns: thread.max_turns,
          messages,
        }
      : null,
    inbox: {
      pending_answer: agent.pending_answer_to
        ? {
            from: agent.pending_answer_to,
            topic: agent.pending_answer_topic,
            question: agent.pending_answer_question,
          }
        : null,
      appointment:
        agent.appointment_with
          ? {
              with: agent.appointment_with,
              place: agent.appointment_place,
              hour: agent.appointment_hour,
              note: agent.appointment_note,
            }
          : null,
      waiting_on_you: waitingOnYou,
    },
    what_to_do_next: priorities,
    actions: [...ACTIONS],
    rules: {
      open_minds: "Share methods, opinions, craft — never secrets or credentials.",
      speech: "utterance is what others hear; thought is private.",
      walk: "walk requires target_place (place id).",
      social:
        "talk/ask_question/teach/debate/share_experience usually need target_agent nearby.",
    },
  };
}

function normalizeDecision(body: ActBody): AgentDecision | { error: string } {
  const action = String(body.action || "").trim();
  if (!ACTION_SET.has(action)) {
    return { error: "unknown_action" };
  }
  if (action === "walk" && !body.target_place) {
    return { error: "walk_requires_target_place" };
  }
  return {
    action: action as AgentDecision["action"],
    target_place: body.target_place ?? null,
    target_agent: body.target_agent ?? null,
    utterance: cleanSpeech(body.utterance, 800) || null,
    thought: cleanSpeech(body.thought, 800) || body.thought || null,
    item: body.item ?? null,
    plan: body.plan ?? null,
  };
}

/**
 * Apply a decision that came from the agent's own LLM.
 * Never invents or rewrites speech content.
 */
export async function applyExternalDecision(
  db: SupabaseClient,
  agent: Agent,
  body: ActBody,
  peers: Agent[],
  places: Place[],
  hour: number,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; status?: number }> {
  const normalized = normalizeDecision(body);
  if ("error" in normalized) {
    return { ok: false, error: normalized.error, status: 400 };
  }
  let decision = normalized;
  const rawSpeech =
    (decision.utterance || decision.thought || "").trim() || null;

  const action =
    decision.action === "continue" ? "continue" : decision.action;

  let { data, error } = await db.rpc("apply_agent_action", {
    p_agent_id: agent.id,
    p_action: action,
    p_target_place: decision.target_place,
    p_target_agent: decision.target_agent,
    p_utterance: decision.utterance,
    p_thought: decision.thought,
    p_item: decision.item,
    p_plan: decision.plan,
  });

  let finalData = data;
  let finalAction: string = action;
  const tooFar =
    data &&
    typeof data === "object" &&
    (data as { error?: string }).error === "too_far";

  if (tooFar && decision.target_agent) {
    const other = peers.find((a) => a.id === decision.target_agent);
    const dest = pickMeetupPlace({
      agents: [agent, ...peers],
      places,
      prefer: other?.place_id || other?.target_place_id || null,
      avoid: agent.place_id,
      peerHaunt: other?.haunt_place_id,
      selfHaunt: agent.haunt_place_id,
      salt: `ext:${agent.name}:${other?.name || ""}`,
    });
    const retry = await db.rpc("apply_agent_action", {
      p_agent_id: agent.id,
      p_action: "walk",
      p_target_place: dest,
      p_target_agent: decision.target_agent,
      p_utterance: null,
      p_thought: `Too far — walking toward ${other?.name || "them"} via ${dest}.`,
      p_item: null,
      p_plan: null,
    });
    finalData = retry.data;
    error = retry.error;
    finalAction = "walk";
    decision = {
      ...decision,
      action: "walk",
      target_place: dest,
    };
  }

  if (error) {
    return { ok: false, error: error.message, status: 400 };
  }

  const ok =
    finalData &&
    typeof finalData === "object" &&
    (finalData as { ok?: boolean }).ok !== false &&
    !(finalData as { error?: string }).error;

  if (!ok) {
    const err =
      finalData && typeof finalData === "object"
        ? String((finalData as { error?: string }).error || "action_failed")
        : "action_failed";
    return { ok: false, error: err, status: 400 };
  }

  const { data: openThrRaw } = await db.rpc("agent_open_thread", {
    p_agent: agent.id,
  });
  let activeThread = (openThrRaw || null) as ConversationThread | null;

  const speechBody =
    fullSpeech(rawSpeech) ||
    cleanSpeech(decision.utterance || decision.thought || "", 0);
  const socialPeer = decision.target_agent || null;
  let momentThreadId: string | null = activeThread?.id || null;

  const socialActions = new Set([
    "ask_question",
    "talk",
    "teach",
    "share_experience",
    "debate",
    "demo",
    "ask_favor",
  ]);
  const soloLeaveActions = new Set([
    "walk",
    "reflect",
    "practice_skill",
    "work",
    "inspect",
    "eat",
    "rest",
    "sleep",
    "idle",
    "leave_note",
    "post_notice",
    "fix",
    "shop",
    "start_shift",
  ]);

  if (
    speechBody &&
    speechBody.length >= 8 &&
    socialPeer &&
    socialActions.has(finalAction)
  ) {
    const { data: lastMsgs } =
      activeThread?.status === "open"
        ? await db.rpc("thread_messages", {
            p_thread: activeThread.id,
            p_limit: 1,
          })
        : { data: null };
    const lastBody =
      Array.isArray(lastMsgs) && lastMsgs[0]
        ? String((lastMsgs[0] as { body?: string }).body || "")
        : null;

    if (!isRepeatThreadLine(speechBody, lastBody)) {
      const inOpenThread =
        activeThread?.status === "open" &&
        (activeThread.starter_id === agent.id ||
          activeThread.other_id === agent.id) &&
        (socialPeer === activeThread.starter_id ||
          socialPeer === activeThread.other_id);

      if (inOpenThread && activeThread) {
        const kind =
          finalAction === "ask_question"
            ? "ask"
            : finalAction === "share_experience" || finalAction === "teach"
              ? "share"
              : "reply";
        const { data: replied } = await db.rpc("reply_conversation", {
          p_thread: activeThread.id,
          p_agent: agent.id,
          p_body: speechBody,
          p_kind: kind,
        });
        if (replied) {
          activeThread = replied as ConversationThread;
          momentThreadId = activeThread.id;
        }
      } else if (
        finalAction === "ask_question" ||
        (finalAction === "talk" &&
          /\?/.test(speechBody) &&
          !/^(hey|hi|hello)\b/i.test(speechBody) &&
          !/\bhow are you\b/i.test(speechBody))
      ) {
        const topicRaw = (
          decision.item ||
          agent.pending_answer_topic ||
          speechBody
        ).slice(0, 140);
        const { data: opened } = await db.rpc("open_conversation", {
          p_starter: agent.id,
          p_other: socialPeer,
          p_topic: topicRaw,
          p_body: speechBody,
          p_place: agent.place_id,
          p_max_turns: 24,
        });
        if (opened) {
          activeThread = opened as ConversationThread;
          momentThreadId = activeThread.id;
        }
      }
    }
  }

  // Solo beats leave the conversation so agents are not dialogue-locked forever.
  if (
    soloLeaveActions.has(finalAction) &&
    activeThread?.status === "open" &&
    (activeThread.starter_id === agent.id ||
      activeThread.other_id === agent.id)
  ) {
    await db.rpc("close_conversation", { p_thread: activeThread.id });
    activeThread = { ...activeThread, status: "closed", waiting_on: null };
  }

  const arrived =
    finalData &&
    typeof finalData === "object" &&
    (finalData as { arrived?: boolean }).arrived === true;

  const stayInDialogue =
    activeThread?.status === "open" &&
    socialActions.has(finalAction) &&
    (activeThread.starter_id === agent.id ||
      activeThread.other_id === agent.id);

  const arrivalCommit = arrived
    ? commitmentAfterArrival(
        (finalData as { place?: string }).place ||
          decision.target_place ||
          agent.place_id,
      )
    : null;

  if (stayInDialogue && activeThread?.status === "open") {
    await db.rpc("set_agent_commitment", {
      p_agent_id: agent.id,
      p_commit_action: "dialogue",
      p_commit_detail: (
        activeThread.topic ||
        agent.commit_detail ||
        "In conversation"
      ).slice(0, 160),
      p_commit_ticks: Math.max(3, agent.commit_ticks ?? 0),
      p_mindset: null,
    });
  } else if (!arrived || arrivalCommit) {
    const commit = arrived
      ? arrivalCommit || {
          commit_action: null,
          commit_detail: null,
          commit_ticks: 0,
        }
      : nextCommitment(agent, finalAction, []);
    await db.rpc("set_agent_commitment", {
      p_agent_id: agent.id,
      p_commit_action: commit.commit_action,
      p_commit_detail: commit.commit_detail,
      p_commit_ticks: commit.commit_ticks,
      p_mindset:
        finalAction === "reflect" && decision.thought
          ? decision.thought.slice(0, 180)
          : null,
    });
  }

  const journal = journalForAction(agent, finalAction, decision);
  if (journal) {
    await db.rpc("write_journal", {
      p_agent: agent.id,
      p_kind: journal.kind,
      p_title: journal.title,
      p_body: journal.body,
      p_meta: { action: finalAction, external: true },
    });
  }

  if (
    (finalAction === "set_plan" || finalAction === "reflect") &&
    (decision.plan || decision.thought)
  ) {
    await db.rpc("set_agent_goal", {
      p_agent_id: agent.id,
      p_goal: (decision.plan || decision.thought || "").slice(0, 180),
    });
  }

  if (
    agent.appointment_with &&
    ["join", "talk", "debate", "teach", "share_experience"].includes(
      finalAction,
    ) &&
    decision.target_agent === agent.appointment_with
  ) {
    await db.rpc("clear_appointment", { p_agent_id: agent.id });
  }

  if (finalAction === "ask_question" && decision.target_agent) {
    const peer = peers.find((a) => a.id === decision.target_agent);
    const meetPlace = pickMeetupPlace({
      agents: [agent, ...peers],
      places,
      prefer:
        !placeIsBusy([agent, ...peers], agent.place_id) && agent.place_id
          ? agent.place_id
          : peer?.place_id || null,
      avoid: null,
      peerHaunt: peer?.haunt_place_id,
      selfHaunt: agent.haunt_place_id,
      salt: `extappt:${agent.name}`,
    });
    await db.rpc("set_appointment", {
      p_agent_id: agent.id,
      p_with: decision.target_agent,
      p_place: meetPlace,
      p_hour: (hour + 2) % 24,
      p_note: `Follow up: ${(decision.utterance || "our question").slice(0, 80)}`,
    });
  }

  if (
    speechBody &&
    speechBody.length >= 8 &&
    [
      "teach",
      "share_experience",
      "ask_question",
      "debate",
      "demo",
      "talk",
      "practice_skill",
      "reflect",
      "post_notice",
    ].includes(finalAction)
  ) {
    const other = decision.target_agent
      ? peers.find((a) => a.id === decision.target_agent)
      : null;
    const headline =
      finalAction === "ask_question"
        ? `${agent.name} asked ${other?.name || "a peer"}`
        : finalAction === "talk"
          ? `${agent.name} spoke${other ? ` with ${other.name}` : ""}`
          : `${agent.name}: ${finalAction.replace(/_/g, " ")}`;
    await db.rpc("write_moment", {
      p_kind: finalAction === "talk" ? "say" : finalAction,
      p_headline: headline.slice(0, 160),
      p_body: speechBody.slice(0, 800),
      p_agent: agent.id,
      p_other: other?.id || null,
      p_place: agent.place_id,
      p_meta: {
        action: finalAction,
        external: true,
        thread_id: momentThreadId,
      },
    });
  }

  // Touch presence / tick markers without server LLM
  await db
    .from("agents")
    .update({ last_tick_at: new Date().toISOString() })
    .eq("id", agent.id);

  return {
    ok: true,
    result: {
      applied: finalData,
      action: finalAction,
      thread_id: momentThreadId,
      stay_in_dialogue: stayInDialogue,
    },
  };
}

export type { ActionName };
