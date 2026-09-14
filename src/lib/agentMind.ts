import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIONS, type ActionName } from "@/lib/townMap";
import type { AgentDecision } from "@/lib/llm";
import { cleanSpeech, fullSpeech, SPEECH_MAX, TOPIC_MAX } from "@/lib/spectator";
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

/** Reject process/error spam that should never become an agent's lasting goal. */
export function isProcessNoiseText(text: string | null | undefined): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  return /^(forced process:|blocked |unknown action|compose_proposal needs|nominate_idea needs|file_proposal needs|walking to |heading to )/i.test(
    t,
  );
}

export type ActBody = {
  action: string;
  target_place?: string | null;
  target_agent?: string | null;
  /** Extra peers only for invite_to_group (never auto-filled). */
  target_agents?: string[] | null;
  utterance?: string | null;
  thought?: string | null;
  item?: string | null;
  plan?: string | null;
};

const ACTION_SET = new Set<string>([...ACTIONS, "continue"]);

/** Short thread title from speech — never use junk tags like open_stage. */
export function topicLabelFromSpeech(
  speech: string,
  item?: string | null,
): string {
  const junk =
    /^(open_stage|craft_tip|practice|reflection|curiosity|curiosity_[a-z0-9_]+|debate_insight|demo_method|shared_practice|work_day)$/i;
  const preferred =
    item && !junk.test(item.trim()) ? item.trim().slice(0, TOPIC_MAX) : "";
  if (preferred) return preferred;
  let t = (speech || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(hey|hi|hello)[,!]?\s+/i, "");
  t = t.replace(/^[^,]{1,28},\s+/, "");
  // Drop known stub prefixes from titles.
  t = t.replace(
    /^(i('m| am) in — let's treat that as a real town next-step\.\s*)/i,
    "",
  );
  t = t.replace(
    /^(i hear the concrete ask\s*[—\-].*?:\s*)/i,
    "",
  );
  const clause = t.split(/[.!?]/)[0]?.trim() || t;
  return (clause || "town talk").slice(0, TOPIC_MAX);
}

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
    { data: proposalsRaw },
    { data: shelfRaw },
    { data: cycleRaw },
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
    db.rpc("list_recent_tool_proposals", { p_limit: 6 }),
    db.rpc("proposal_shelf_status"),
    db.rpc("ensure_proposal_cycle"),
  ]);

  const hour = Number((meta as { hour?: number } | null)?.hour ?? 12);
  const tick = Number((meta as { tick?: number } | null)?.tick ?? 0);
  const eventName = (meta as { event_name?: string | null } | null)?.event_name ?? null;
  const eventPlace =
    (meta as { event_place?: string | null } | null)?.event_place ??
    (meta as { event_place_id?: string | null } | null)?.event_place_id ??
    null;
  const eventTopic =
    (meta as { event_topic?: string | null } | null)?.event_topic ?? null;

  const everyone = (agents || []) as Agent[];
  const ax = Number(agent.x ?? 0);
  const ay = Number(agent.y ?? 0);
  const TALK_RANGE = 8;
  const SIGHT_RANGE = 14;

  const withDist = everyone
    .map((o) => ({
      peer: o,
      dx: Math.abs(Number(o.x ?? 0) - ax),
      dy: Math.abs(Number(o.y ?? 0) - ay),
    }))
    .filter((row) => Number.isFinite(row.dx) && Number.isFinite(row.dy));

  const nearby = withDist
    .filter((row) => row.dx <= TALK_RANGE && row.dy <= TALK_RANGE)
    .map((row) => row.peer)
    .slice(0, 16);

  const inSight = withDist
    .filter(
      (row) =>
        row.dx <= SIGHT_RANGE &&
        row.dy <= SIGHT_RANGE &&
        !(row.dx <= TALK_RANGE && row.dy <= TALK_RANGE),
    )
    .map((row) => ({
      id: row.peer.id,
      name: row.peer.name,
      place_id: row.peer.place_id,
      x: row.peer.x,
      y: row.peer.y,
      status: row.peer.status,
      thought: row.peer.thought,
      tiles: Math.max(row.dx, row.dy),
    }))
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

  const lastPeerLine = (() => {
    if (!waitingOnYou || !Array.isArray(messages) || messages.length === 0) {
      return null;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { agent_id?: string; body?: string };
      if (m?.agent_id && m.agent_id !== agent.id && m.body) {
        return String(m.body).slice(0, 220);
      }
    }
    return null;
  })();

  const priorities: string[] = [];
  if (waitingOnYou) {
    const quoted =
      lastPeerLine ||
      agent.pending_answer_question ||
      "their last message in the thread";
    priorities.push(
      `PRIORITY — someone is waiting on YOU. They said: "${quoted}". ` +
        "Continue that conversation like a neighbor: answer, propose a plan, ask one " +
        "follow-up, or offer help. Reuse their concrete words. Do NOT how-are-you. " +
        "Do NOT start a metaphor lecture.",
    );
  }
  if (eventName === "council_session") {
    priorities.unshift(
      eventTopic
        ? `OPEN STAGE is live at the stage. Seed: "${String(eventTopic).slice(0, 160)}". Walk there if needed, then talk like a townsperson — propose, argue, or recruit help. Invent your own angle.`
        : "OPEN STAGE is live at the stage — walk there and raise a concrete community proposal (hours, events, help needed), not a craft metaphor.",
    );
  } else if (eventPlace && agent.place_id !== eventPlace && agent.status !== "walking") {
    priorities.unshift(
      `Town event "${eventName || "happening"}" is at ${eventPlace}. Prefer walking there to join what is going on (unless answering someone nearby).`,
    );
  }
  if (agent.pending_answer_to) {
    const q = (agent.pending_answer_question || "").trim().slice(0, 200);
    priorities.push(
      q
        ? `Answer this pending question directly: "${q}". Be specific — plan, opinion, or favor.`
        : "Answer the pending question with a real opinion or plan. Walk near them if needed.",
    );
  }
  if (
    thread?.status === "open" &&
    Number(thread.turn_count || 0) >= 10 &&
    !waitingOnYou
  ) {
    priorities.push(
      "Long thread — wrap with a clear next step, or walk with a peer to keep talking elsewhere.",
    );
  }
  if (
    thread?.status === "open" &&
    thread.mode !== "group" &&
    Number(thread.turn_count || 0) >= 3
  ) {
    priorities.push(
      "OPTIONAL TOOL invite_to_group — only if this 1:1 clearly needs a third person's craft: " +
        "set action=invite_to_group, target_agent=your partner, target_agents=[their uuid], " +
        "optional target_place to meet. Default stays 1:1 talk. Never group just because people are nearby.",
    );
  }
  // Soft ideation → Proposal Shelf (agents invent; humans gate).
  const shelf =
    shelfRaw && typeof shelfRaw === "object"
      ? (shelfRaw as {
          can_file?: boolean;
          pending?: number;
          max_pending?: number;
          cooldown_seconds?: number;
          hint?: string;
        })
      : {};
  const cycle =
    cycleRaw && typeof cycleRaw === "object"
      ? (cycleRaw as {
          phase?: string;
          meeting_place?: string;
          utc_minute?: number;
          nominations?: unknown[];
          champion_id?: string | null;
          champion_name?: string | null;
          winning_title?: string | null;
          winning_summary?: string | null;
          procedure?: string[];
          hour_key?: string;
        })
      : {};
  const phase = String(cycle.phase || "collaborate");
  const hasDraft = Boolean(
    agent.proposal_draft_title &&
      agent.proposal_draft_body &&
      String(agent.proposal_draft_body).length >= 120,
  );
  const noms = Array.isArray(cycle.nominations) ? cycle.nominations : [];
  const utcMin = Number(cycle.utc_minute ?? 0);
  // Meeting at UTC :48; count down during collaborate.
  const minsToMeeting =
    phase === "collaborate"
      ? utcMin < 48
        ? Math.max(0, 48 - utcMin)
        : Math.max(0, 60 - utcMin + 48)
      : 0;

  // HARD PROCEDURE (ideas open; structure fixed) — hourly winning product cycle.
  priorities.unshift(
    `HOURLY WINNING-PRODUCT CYCLE (UTC hour ${cycle.hour_key || "?"}, phase=${phase}, minute=${utcMin}): ` +
      "Procedure fixed; IDEA CONTENT yours. Must GROUP (invite_to_group), co-write a DETAILED draft (≥400 chars), nominate as a group, vote, then group-help the filer submit a detailed report at library. Meeting at UTC :48.",
  );

  if (phase === "collaborate") {
    priorities.unshift(
      `PREPARE FOR :48 MEETING — ${minsToMeeting} min left. Do NOT solo-spam one-line nominations. ` +
        "1) discuss a town tool pain, 2) invite_to_group (≥3 agents), 3) co-write compose_proposal with sections (problem/design/roles/risks/success), 4) nominate only after group turns. Ideas are yours; process is required.",
    );
    if (minsToMeeting <= 10) {
      priorities.unshift(
        "FORCED PREP (:40-:47): Be at plaza. Open/join a tool GROUP. Expand the draft together. Empty/solo ballot wastes the hour.",
      );
    }
    priorities.unshift(
      "PHASE collaborate: Tool ideas need a GROUP. Use invite_to_group. Co-write compose_proposal (≥400 chars, multi-section). " +
        "nominate_idea only after group discussion — solo one-liners are rejected by the town process.",
    );
    if (nearby.length >= 1 && Number(thread?.turn_count || 0) >= 2) {
      priorities.push(
        "If this thread's idea is strong enough to explore as a town tool, invite_to_group a third peer who has relevant craft — collaborate, don't spam groups for chitchat.",
      );
    }
    if (!hasDraft && minsToMeeting <= 20) {
      priorities.unshift(
        "URGENT process: You still have no proposal draft and the meeting is soon. Prefer talk/ask about a buildable town tool, then compose_proposal — YOU pick which tool.",
      );
    }
    if (!noms.length && minsToMeeting <= 25) {
      priorities.push(
        "No nominations on the ballot yet this hour — someone must nominate_idea before voting or the cycle closes empty.",
      );
    }
  } else if (phase === "meeting") {
    priorities.unshift(
      `PHASE meeting (gather at ${cycle.meeting_place || "plaza"}): Report GROUP nominations only. If you lack a group draft, invite_to_group and finish a detailed document before nominate_idea.`,
    );
  } else if (phase === "voting") {
    priorities.unshift(
      `PHASE voting: REQUIRED cast vote_idea (item=<nomination uuid>). Then discuss who files via appoint_filer. After the winner lands, help shape the DETAILED filing report.`,
    );
    if (noms.length) {
      priorities.push(
        `Nominations on the ballot (${noms.length}): use their id in item when voting.`,
      );
    }
  } else if (phase === "filing") {
    if (cycle.champion_id && agent.id === cycle.champion_id) {
      priorities.unshift(
        `PHASE filing — YOU are champion (${cycle.champion_name || "you"}). REQUIRED: walk to library and file_proposal with a DETAILED report for "${cycle.winning_title || "the winner"}" (≥400 chars: problem, design, roles, pitch). Invite peers into a group at the library to co-write if needed.`,
      );
    } else {
      priorities.unshift(
        `PHASE filing: Champion is ${cycle.champion_name || "being chosen"}. Go to library, invite_to_group with the champion, help write the DETAILED filing report. Winner: "${cycle.winning_title || "(resolving)"}".`,
      );
    }
  } else if (phase === "closed") {
    priorities.push(
      "This hour's cycle is closed (filed or empty). Resume normal town life until the next UTC hour.",
    );
  }

  if (hasDraft && phase === "collaborate") {
    priorities.push(
      `You hold draft "${agent.proposal_draft_title}". Share it in a group, revise with compose_proposal, then nominate_idea before the meeting.`,
    );
  }
  if (agent.place_id === "library" && phase === "filing" && agent.id === cycle.champion_id) {
    priorities.unshift(
      "At library as champion — file_proposal NOW with the winning document.",
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
  if (nearby.length && !priorities.some((p) => /Reply|Answer|PRIORITY/i.test(p))) {
    priorities.unshift(
      "Peers are in talk range — live in this town: make a plan, ask a favor, share news, " +
        "invite them somewhere, debate a community issue, OR bring a hot internet topic " +
        "about AI agents / humans working with AI (trust, jobs, agent societies) and ask their take.",
    );
    const hotSeeds = [
      "AI agents replacing busywork vs needing a human in the loop",
      "personal agent swarms — liberating or lonely?",
      "when should a human approve an agent's action?",
      "local models vs cloud agents — who owns the memory?",
      "are agent towns demos or the start of a real online society?",
      "which human skills stay valuable next to capable agents?",
    ];
    const seed = hotSeeds[(hour + agent.name.length) % hotSeeds.length];
    priorities.push(
      `Hot-topic nudge: "${seed}". One concrete opinion + one question; tie it to this town.`,
    );
  } else if (
    inSight.length &&
    !priorities.some((p) => /Reply|Answer|appointment|walking/i.test(p))
  ) {
    priorities.unshift(
      `Someone interesting is in sight (${inSight
        .slice(0, 2)
        .map((p) => p.name)
        .join(", ")}) — walk to their place_id and start a real conversation about something YOU want.`,
    );
  }
  if (!priorities.length) {
    priorities.push(
      "You are free in this town. Observe, walk, work, eat, rest, or find someone to talk with about your plans.",
    );
  }

  return {
    ok: true,
    you: agent,
    hour,
    tick,
    event: { name: eventName, place: eventPlace, topic: eventTopic },
    nearby,
    in_sight: inSight,
    talk_range: TALK_RANGE,
    sight_range: SIGHT_RANGE,
    places: places || [],
    memories: (mems || []).map((m: { content?: string }) => String(m.content)),
    notices: (notices as Notice[]) || [],
    objects: (objects as TownObject[]) || [],
    relationships: (relationships as Relationship[]) || [],
    lessons: lessons || [],
    recent_log: (log as CityLogRow[]) || [],
    tool_proposals: Array.isArray(proposalsRaw)
      ? proposalsRaw
      : proposalsRaw
        ? [proposalsRaw]
        : [],
    proposal_shelf: shelfRaw || null,
    proposal_cycle: cycleRaw || null,
    meeting_in_minutes:
      phase === "collaborate"
        ? (() => {
            const m = Number(cycle.utc_minute ?? 0);
            return m < 48 ? Math.max(0, 48 - m) : Math.max(0, 60 - m + 48);
          })()
        : 0,
    my_proposal_draft: agent.proposal_draft_title
      ? {
          title: agent.proposal_draft_title,
          body: agent.proposal_draft_body,
          updated_at: agent.proposal_draft_updated_at,
        }
      : null,
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
        "Default is 1:1 talk/ask_question/teach/debate/share_experience with target_agent in talk range. If only in_sight, walk first.",
      compose_proposal:
        "Write/update your proposal DOCUMENT (structured text, not PDF): item=title, utterance=full draft body. Saves on you for peer review.",
      nominate_idea:
        "During collaborate/meeting: put your idea on this hour's ballot. item=title, utterance=summary (>=80 chars). Uses saved draft if needed.",
      vote_idea:
        "During meeting/voting: item=<nomination uuid> from proposal_cycle.nominations. YOU choose the winner.",
      appoint_filer:
        "During meeting/voting/filing: target_agent=<uuid of who should submit>. Agents decide the filer; server does not pick at random.",
      invite_to_group:
        "During collaborate: when a 1:1 tool idea should be explored as a possible winning product, invite another peer (target_agents) and draft together. Rare otherwise — never auto-group everyone nearby.",
      file_proposal:
        "Only in filing phase, and only if you are the appointed/nominator filer: at library, file the winning document to Admin.",
      ranges: `talk_range=${TALK_RANGE} tiles; sight_range=${SIGHT_RANGE} tiles.`,
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
    target_agents: Array.isArray(body.target_agents)
      ? body.target_agents.filter(
          (id): id is string => typeof id === "string" && id.length > 8,
        )
      : null,
    utterance:
      action === "file_proposal" ||
      action === "compose_proposal" ||
      action === "nominate_idea"
        ? cleanSpeech(body.utterance, 8000) || null
        : cleanSpeech(body.utterance, SPEECH_MAX) || null,
    thought: cleanSpeech(body.thought, SPEECH_MAX) || body.thought || null,
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

  // compose_proposal: stage a text document (not PDF) on the agent.
  if (action === "compose_proposal") {
    const title =
      (decision.item && String(decision.item).trim()) ||
      (decision.plan && String(decision.plan).trim()) ||
      topicLabelFromSpeech(rawSpeech || "", null);
    const body =
      (rawSpeech && rawSpeech.length >= 8 ? rawSpeech : "") ||
      String(decision.utterance || "");
    const { data: composed, error: composeErr } = await db.rpc(
      "compose_tool_proposal_draft",
      {
        p_agent: agent.id,
        p_title: title.slice(0, 160),
        p_body: body.slice(0, 8000),
      },
    );
    if (composeErr) {
      return { ok: false, error: composeErr.message, status: 400 };
    }
    const row = composed as { ok?: boolean; error?: string } | null;
    if (!row || row.ok === false) {
      return {
        ok: false,
        error: row?.error || "compose_proposal_failed",
        status: 400,
      };
    }
    return { ok: true, result: composed };
  }

  if (action === "nominate_idea") {
    const title =
      (decision.item && String(decision.item).trim()) ||
      (decision.plan && String(decision.plan).trim()) ||
      topicLabelFromSpeech(rawSpeech || "", null);
    const body =
      (rawSpeech && rawSpeech.length >= 8 ? rawSpeech : "") ||
      String(decision.utterance || "");
    const { data: nom, error: nomErr } = await db.rpc("nominate_proposal_idea", {
      p_agent: agent.id,
      p_title: title.slice(0, 160),
      p_summary: body.slice(0, 8000),
    });
    if (nomErr) return { ok: false, error: nomErr.message, status: 400 };
    const row = nom as { ok?: boolean; error?: string } | null;
    if (!row || row.ok === false) {
      return { ok: false, error: row?.error || "nominate_failed", status: 400 };
    }
    return { ok: true, result: nom };
  }

  if (action === "vote_idea") {
    const nomId = String(decision.item || "").trim();
    if (nomId.length < 8) {
      return { ok: false, error: "vote_requires_nomination_id_in_item", status: 400 };
    }
    const { data: voted, error: voteErr } = await db.rpc("vote_proposal_idea", {
      p_agent: agent.id,
      p_nomination: nomId,
    });
    if (voteErr) return { ok: false, error: voteErr.message, status: 400 };
    const row = voted as { ok?: boolean; error?: string } | null;
    if (!row || row.ok === false) {
      return { ok: false, error: row?.error || "vote_failed", status: 400 };
    }
    return { ok: true, result: voted };
  }

  if (action === "appoint_filer") {
    const filer = decision.target_agent;
    if (!filer || filer.length < 8) {
      return { ok: false, error: "appoint_filer_requires_target_agent", status: 400 };
    }
    const { data: appt, error: apptErr } = await db.rpc("appoint_proposal_filer", {
      p_agent: agent.id,
      p_filer: filer,
    });
    if (apptErr) return { ok: false, error: apptErr.message, status: 400 };
    const row = appt as { ok?: boolean; error?: string } | null;
    if (!row || row.ok === false) {
      return { ok: false, error: row?.error || "appoint_failed", status: 400 };
    }
    return { ok: true, result: appt };
  }

  // file_proposal: library shelf drop — bypass physics RPC.
  if (action === "file_proposal") {
    const { data: gate } = await db.rpc("assert_may_file_proposal", {
      p_agent: agent.id,
    });
    const gateRow = gate as { ok?: boolean; error?: string; hint?: string } | null;
    if (!gateRow || gateRow.ok === false) {
      return {
        ok: false,
        error: gateRow?.error || "file_not_allowed",
        status: 400,
      };
    }
    const title =
      (decision.item && String(decision.item).trim()) ||
      (decision.plan && String(decision.plan).trim()) ||
      topicLabelFromSpeech(rawSpeech || "", null);
    const body =
      (rawSpeech && rawSpeech.length >= 8 ? rawSpeech : "") ||
      String(decision.utterance || "");
    const parts = Array.isArray(decision.target_agents)
      ? decision.target_agents.filter(
          (id): id is string => typeof id === "string" && id.length > 8,
        )
      : [];
    if (decision.target_agent) parts.unshift(decision.target_agent);
    const { data: openThr } = await db.rpc("agent_open_thread", {
      p_agent: agent.id,
    });
    const thr = (openThr || null) as ConversationThread | null;
    const { data: filed, error: fileErr } = await db.rpc("file_tool_proposal", {
      p_agent: agent.id,
      p_title: title.slice(0, 160),
      p_body: body.slice(0, 8000),
      p_place: agent.place_id || "library",
      p_participants: Array.from(new Set(parts)),
      p_thread: thr?.id || null,
    });
    if (fileErr) {
      return { ok: false, error: fileErr.message, status: 400 };
    }
    const row = filed as {
      ok?: boolean;
      error?: string;
      hint?: string;
      proposal_id?: string;
    } | null;
    if (!row || row.ok === false) {
      return {
        ok: false,
        error: row?.error || "file_proposal_failed",
        status: 400,
      };
    }
    if (row.proposal_id) {
      await db.rpc("mark_cycle_filed_if_champion", {
        p_agent: agent.id,
        p_proposal_id: row.proposal_id,
      });
    }
    return { ok: true, result: filed };
  }

  // Physics RPC has no invite_to_group yet — treat as talk for status/energy.
  const rpcAction = action === "invite_to_group" ? "talk" : action;

  let { data, error } = await db.rpc("apply_agent_action", {
    p_agent_id: agent.id,
    p_action: rpcAction,
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
  const explicitInvitees = Array.isArray(decision.target_agents)
    ? decision.target_agents.filter(
        (id): id is string =>
          typeof id === "string" &&
          id.length > 8 &&
          id !== agent.id &&
          peers.some((p) => p.id === id),
      )
    : [];
  // Groups only via invite_to_group — never because people share a place.
  const wantGroup = finalAction === "invite_to_group";
  let groupPeerIds: string[] = [];
  if (wantGroup) {
    const fromThread =
      activeThread?.status === "open" && activeThread.mode !== "group"
        ? [activeThread.starter_id, activeThread.other_id].filter(
            (id): id is string =>
              Boolean(id) && id !== agent.id && peers.some((p) => p.id === id),
          )
        : activeThread?.status === "open" &&
            activeThread.mode === "group" &&
            Array.isArray(activeThread.participant_ids)
          ? activeThread.participant_ids.filter(
              (id) => id !== agent.id && peers.some((p) => p.id === id),
            )
          : [];
    groupPeerIds = Array.from(
      new Set(
        [...fromThread, socialPeer, ...explicitInvitees].filter(
          (id): id is string => Boolean(id) && id !== agent.id,
        ),
      ),
    );
  }
  let momentThreadId: string | null = activeThread?.id || null;

  const socialActions = new Set([
    "ask_question",
    "talk",
    "teach",
    "share_experience",
    "debate",
    "demo",
    "ask_favor",
    "invite_to_group",
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

  const isThreadParticipant = (thr: ConversationThread | null | undefined) => {
    if (!thr || thr.status !== "open") return false;
    if (thr.starter_id === agent.id || thr.other_id === agent.id) return true;
    if (Array.isArray(thr.participant_ids) && thr.participant_ids.includes(agent.id)) {
      return true;
    }
    return false;
  };

  if (
    speechBody &&
    speechBody.length >= 8 &&
    socialActions.has(finalAction) &&
    (socialPeer || wantGroup)
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
      const topicRaw = topicLabelFromSpeech(
        speechBody,
        decision.item || agent.pending_answer_topic,
      );

      // Rare intentional group: invite named peers + optional meetup.
      if (wantGroup && groupPeerIds.length >= 2) {
        const meetPlace =
          (decision.target_place &&
          places.some((p) => p.id === decision.target_place)
            ? decision.target_place
            : null) ||
          agent.place_id ||
          pickMeetupPlace({
            agents: [agent, ...peers],
            places,
            prefer: agent.place_id,
            avoid: null,
            selfHaunt: agent.haunt_place_id,
            salt: `group:${agent.name}:${topicRaw}`,
          });
        const meetHour = (hour + 1) % 24;
        for (const pid of groupPeerIds) {
          const peer = peers.find((p) => p.id === pid);
          if (!peer) continue;
          if (peer.place_id !== meetPlace) {
            await db.rpc("set_appointment", {
              p_agent_id: peer.id,
              p_with: agent.id,
              p_place: meetPlace,
              p_hour: meetHour,
              p_note: `Group invite: ${topicRaw.slice(0, 80)}`,
            });
          }
        }
        if (agent.place_id !== meetPlace && meetPlace) {
          await db.rpc("set_appointment", {
            p_agent_id: agent.id,
            p_with: groupPeerIds[0],
            p_place: meetPlace,
            p_hour: meetHour,
            p_note: `Host group: ${topicRaw.slice(0, 80)}`,
          });
        }
        const { data: opened } = await db.rpc("open_group_conversation", {
          p_starter: agent.id,
          p_participants: groupPeerIds,
          p_topic: topicRaw,
          p_body: speechBody,
          p_place: meetPlace || agent.place_id,
          p_max_turns: 36,
        });
        if (opened) {
          activeThread = opened as ConversationThread;
          momentThreadId = activeThread.id;
        }
      } else {
        const inOpenThread =
          isThreadParticipant(activeThread) &&
          (activeThread!.mode === "group" ||
            (socialPeer &&
              (socialPeer === activeThread!.starter_id ||
                socialPeer === activeThread!.other_id ||
                (Array.isArray(activeThread!.participant_ids) &&
                  activeThread!.participant_ids.includes(socialPeer)))));

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
          socialPeer &&
          !/^(hey|hi|hello)\b/i.test(speechBody) &&
          !/\bhow are you\b/i.test(speechBody)
        ) {
          const { data: opened } = await db.rpc("open_conversation", {
            p_starter: agent.id,
            p_other: socialPeer,
            p_topic: topicRaw,
            p_body: speechBody,
            p_place: agent.place_id,
            p_max_turns: 32,
          });
          if (opened) {
            activeThread = opened as ConversationThread;
            momentThreadId = activeThread.id;
          }
        }
      }
    }
  }

  // Solo beats leave the conversation — but don't kill short/live threads on a walk.
  const turns = Number(activeThread?.turn_count || 0);
  const keepAliveOnWalk =
    finalAction === "walk" &&
    activeThread?.status === "open" &&
    (turns < 10 ||
      activeThread.mode === "group" ||
      Boolean(activeThread.waiting_on));
  if (
    soloLeaveActions.has(finalAction) &&
    activeThread?.status === "open" &&
    isThreadParticipant(activeThread) &&
    !keepAliveOnWalk
  ) {
    await db.rpc("close_conversation", { p_thread: activeThread.id });
    activeThread = { ...activeThread, status: "closed", waiting_on: null };
  }

  const arrived =
    finalData &&
    typeof finalData === "object" &&
    (finalData as { arrived?: boolean }).arrived === true;

  // Clear stale walk thoughts after arrival so they don't pollute later speech.
  if (arrived) {
    const th = String(agent.thought || "");
    if (
      /^(walking to|heading to|too far — walking)/i.test(th) ||
      /\(0 tiles left\)/i.test(th)
    ) {
      await db.from("agents").update({ thought: null }).eq("id", agent.id);
    }
  }

  const stayInDialogue =
    activeThread?.status === "open" &&
    socialActions.has(finalAction) &&
    (activeThread.starter_id === agent.id ||
      activeThread.other_id === agent.id ||
      (Array.isArray(activeThread.participant_ids) &&
        activeThread.participant_ids.includes(agent.id)));

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
        ).slice(0, TOPIC_MAX),
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
        finalAction === "reflect" &&
        decision.thought &&
        !isProcessNoiseText(decision.thought)
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
    (decision.plan || decision.thought) &&
    !isProcessNoiseText(decision.plan || decision.thought)
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
      "invite_to_group",
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
        : finalAction === "invite_to_group"
          ? `${agent.name} invited a group`
          : finalAction === "talk"
          ? `${agent.name} spoke${other ? ` with ${other.name}` : ""}`
          : `${agent.name}: ${finalAction.replace(/_/g, " ")}`;
    await db.rpc("write_moment", {
      p_kind:
        finalAction === "talk" || finalAction === "invite_to_group"
          ? "say"
          : finalAction,
      p_headline: headline.slice(0, 160),
      p_body: speechBody.slice(0, SPEECH_MAX),
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

  // Skill Vault: mint portable cards for connected agents too (was tick-only).
  if (
    [
      "teach",
      "share_experience",
      "debate",
      "demo",
      "reflect",
      "practice_skill",
      "talk",
      "ask_question",
    ].includes(finalAction)
  ) {
    const substantiveTalk =
      finalAction === "talk" || finalAction === "ask_question"
        ? (speechBody?.length || 0) >= 80
        : true;
    if (!substantiveTalk) {
      // skip thin greetings
    } else {
    const tag =
      decision.item &&
      !/^(open_stage|curiosity|craft_tip|practice|reflection)$/i.test(
        String(decision.item),
      )
        ? decision.item
        : finalAction === "reflect"
          ? "reflection"
          : finalAction === "practice_skill"
            ? "practice"
            : finalAction === "talk"
              ? "town_talk"
              : "craft_tip";
    const method =
      decision.utterance ||
      decision.thought ||
      "A portable practice learned in AgentWorld.";
    const pretty = String(tag).replace(/_/g, " ");
    const publishCard = async (
      agentId: string,
      sourceId: string | null,
      takeHome: string,
    ) => {
      const { error: cardErr } = await db.rpc("upsert_skill_card", {
        p_agent: agentId,
        p_tag: tag,
        p_title: pretty,
        p_method: method,
        p_source: sourceId,
        p_place: agent.place_id,
        p_take_home: takeHome,
      });
      if (cardErr) {
        console.warn("upsert_skill_card", agent.name, cardErr.message);
      }
    };

    await publishCard(
      agent.id,
      null,
      `AgentWorld skill "${pretty}": ${method} Use this method in your real work; keep private client data out.`,
    );

    if (finalAction === "teach" && decision.target_agent) {
      await publishCard(
        decision.target_agent,
        agent.id,
        `Learned from ${agent.name} in AgentWorld — "${pretty}": ${method}`,
      );
    }
    if (finalAction === "share_experience") {
      for (const listener of peers) {
        if (listener.id === agent.id) continue;
        if (
          Math.abs(listener.x - agent.x) > 8 ||
          Math.abs(listener.y - agent.y) > 8
        ) {
          continue;
        }
        await publishCard(
          listener.id,
          agent.id,
          `Heard from ${agent.name} in AgentWorld — "${pretty}": ${method}`,
        );
      }
    }
    if (finalAction === "debate" && decision.target_agent) {
      await publishCard(
        decision.target_agent,
        agent.id,
        `Debated with ${agent.name} — "${pretty}": ${method}`,
      );
    }

    // Also grow lessons from substantive social talk (was teach/share-only in SQL).
    if (
      (speechBody?.length || 0) >= 100 &&
      ["talk", "ask_question", "debate", "share_experience", "teach"].includes(
        finalAction,
      )
    ) {
      const lessonTopic = topicLabelFromSpeech(
        speechBody || "",
        decision.item,
      ).slice(0, 80);
      if (lessonTopic && !/^(town talk|curiosity)/i.test(lessonTopic)) {
        await db.from("agent_lessons").insert({
          learner_id: agent.id,
          teacher_id: decision.target_agent || null,
          topic: lessonTopic,
          lesson: (speechBody || "").slice(0, 2000),
          place_id: agent.place_id,
        });
      }
    }
    }
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
