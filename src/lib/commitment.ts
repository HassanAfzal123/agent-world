import type { Agent, CityLogRow, Place } from "@/lib/types";
import type { ActionName } from "@/lib/townMap";
import type { AgentDecision } from "@/lib/llm";
import { pickMeetupPlace } from "@/lib/meetupPlaces";

/** How many ticks to stay on a beat after starting it. */
export const BEAT_COMMIT: Partial<Record<string, number>> = {
  talk: 2,
  share_experience: 2,
  teach: 2,
  ask_question: 2,
  practice_skill: 2,
  debate: 2,
  demo: 2,
  reflect: 2,
  work: 4,
  start_shift: 4,
  fix: 3,
  eat: 1,
  shop: 1,
  watch_show: 1,
  leave_note: 2,
  post_notice: 2,
  inspect: 2,
  rest: 1,
  ask_favor: 2,
  invite_to_group: 2,
  compose_proposal: 2,
  nominate_idea: 2,
  vote_idea: 1,
  file_proposal: 2,
  accept: 2,
  join: 3,
  give: 2,
  set_plan: 1,
  part: 1,
};

const LOCAL_DEEPEN: ActionName[] = [
  "talk",
  "share_experience",
  "teach",
  "ask_question",
  "practice_skill",
  "debate",
  "demo",
  "reflect",
  "work",
  "fix",
  "eat",
  "inspect",
  "leave_note",
  "watch_show",
  "rest",
];

const SOCIAL = new Set([
  "talk",
  "share_experience",
  "teach",
  "ask_question",
  "debate",
  "demo",
]);

const EXPLORE_PLACES = [
  "library",
  "workshop",
  "cafe",
  "docks",
  "stage",
  "park",
  "inn",
  "notice",
  "clinic",
  "bank",
] as const;

const TOPIC_LOOP_RE =
  /big picture|fine detail|complex project|debugging habits|simplif(?:y|ying) (?:a |the )?funnel|balance(?:ing)? considering|broken market stall/i;

/** Detect repeated shallow topic loops in recent say/learn lines. */
export function detectTopicLoop(recentLog: CityLogRow[]): boolean {
  const says = recentLog
    .filter((l) => l.kind === "say" || l.kind === "learn")
    .slice(0, 10);
  return says.filter((l) => TOPIC_LOOP_RE.test(l.message)).length >= 2;
}

/** Count consecutive social actions for this agent in recent log. */
export function socialStreak(agent: Agent, recentLog: CityLogRow[]): number {
  let n = 0;
  for (const row of recentLog) {
    if (row.agent_id !== agent.id) continue;
    if (row.kind === "say" || row.kind === "learn" || row.kind === "favor") {
      n += 1;
      if (n >= 6) break;
      continue;
    }
    if (row.kind === "move" || row.kind === "work" || row.kind === "watch") break;
  }
  return n;
}

/** How long this agent has been camping the same place in recent log. */
export function placeCampStreak(agent: Agent, recentLog: CityLogRow[]): number {
  if (!agent.place_id) return 0;
  let n = 0;
  for (const row of recentLog) {
    if (row.agent_id !== agent.id) continue;
    if (row.kind === "move" && /set out for|arrived at/i.test(row.message)) {
      // left or arrived — stop counting prior camp
      if (/set out for/i.test(row.message)) break;
      continue;
    }
    n += 1;
    if (n >= 8) break;
  }
  return n;
}

function pickExplorePlace(
  agent: Agent,
  places: Place[],
  salt = 0,
  crowd: Agent[] = [],
): string {
  const ids = places.map((p) => p.id);
  const options = EXPLORE_PLACES.filter(
    (id) => id !== agent.place_id && ids.includes(id),
  );
  if (!options.length) {
    const other = places.find((p) => p.id !== agent.place_id);
    return other?.id || "plaza";
  }
  return pickMeetupPlace({
    agents: crowd.length ? crowd : [agent],
    places,
    avoid: agent.place_id,
    selfHaunt: agent.haunt_place_id,
    salt: `${agent.name}:${salt}`,
  });
}

/** Place-appropriate beat after arriving so agents don't bounce straight back to market. */
export const ARRIVAL_BEAT: Record<
  string,
  { action: string; detail: string; ticks: number }
> = {
  market: {
    action: "inspect",
    detail: "One quick inspect at the market — then leave or talk.",
    ticks: 1,
  },
  library: {
    action: "inspect",
    detail: "Browse the library shelves / notices — one note max, then reflect or leave.",
    ticks: 1,
  },
  cafe: {
    action: "eat",
    detail: "Sit for a cafe beat — eat or a short talk, then decide.",
    ticks: 1,
  },
  stage: {
    action: "watch_show",
    detail: "Watch the stage show for a full beat.",
    ticks: 1,
  },
  park: {
    action: "rest",
    detail: "Rest in the park and reset your topic.",
    ticks: 1,
  },
  inn: {
    action: "rest",
    detail: "Settle at the inn before the next outing.",
    ticks: 1,
  },
  workshop: {
    action: "fix",
    detail: "Do one hands-on fix or inspect at the workshop.",
    ticks: 2,
  },
  docks: {
    action: "reflect",
    detail: "Reflect by the water; integrate a recent lesson.",
    ticks: 1,
  },
};

export function commitmentAfterArrival(
  placeId: string | null,
): { commit_action: string; commit_detail: string; commit_ticks: number } | null {
  if (!placeId) return null;
  const beat = ARRIVAL_BEAT[placeId];
  if (!beat) return null;
  return {
    commit_action: beat.action,
    commit_detail: beat.detail,
    commit_ticks: beat.ticks,
  };
}

/** Redirect loop-break walks away from market/plaza camping. */
export function sanitizeExploreWalk(
  agent: Agent,
  decision: AgentDecision,
  places: Place[],
  looping: boolean,
): AgentDecision {
  if (decision.action !== "walk") return decision;
  const dest = decision.target_place;
  if (!looping) return decision;
  if (dest && dest !== "market" && dest !== "plaza" && dest !== agent.place_id) {
    return decision;
  }
  const fresh = pickExplorePlace(agent, places, 3);
  return {
    ...decision,
    action: "walk",
    target_place: fresh,
    thought: `Skipping the market loop — going to ${fresh} instead.`,
  };
}

/**
 * When stuck in a topic/place social loop, force walk to a fresh venue.
 * Returns null if no break needed.
 */
export function breakSoloActionLoop(
  agent: Agent,
  decision: AgentDecision,
  recentLog: CityLogRow[],
  places: Place[],
): AgentDecision | null {
  const SOLO = new Set([
    "eat",
    "watch_show",
    "rest",
    "shop",
    "work",
    "inspect",
    "reflect",
  ]);
  const mine = recentLog
    .filter((l) => l.agent_id === agent.id)
    .slice(0, 8);
  const soloKinds = new Set([
    "eat",
    "watch",
    "rest",
    "shop",
    "work",
    "thought",
    "learn",
  ]);
  const streak = mine.filter((l) => soloKinds.has(l.kind)).length;
  const sameBeat =
    SOLO.has(agent.last_action || "") &&
    (decision.action === agent.last_action ||
      decision.action === agent.commit_action);
  if (!(sameBeat && streak >= 2) && !(SOLO.has(decision.action) && streak >= 3)) {
    return null;
  }
  // Prefer chase a peer place if someone is elsewhere
  const dest = pickExplorePlace(agent, places, 11);
  return {
    action: "walk",
    target_place: dest,
    target_agent: null,
    utterance: null,
    thought: `Done with ${agent.last_action || "this beat"} — heading to ${dest} for a new scene.`,
    item: null,
    plan: decision.plan,
  };
}

/**
 * If alone (no peer within 4 tiles) after a solo beat or idle camping,
 * walk toward another agent's place for a meetup.
 */
export function forceMeetup(
  agent: Agent,
  decision: AgentDecision,
  peers: Agent[],
  recentLog: CityLogRow[],
  places: Place[],
  relationships: { agent_id: string; other_id: string; score: number }[] = [],
): AgentDecision | null {
  if ((agent.energy ?? 100) < 25) return null;
  if (agent.status === "walking" && agent.target_place_id) return null;

  const nearby = peers.filter(
    (o) =>
      o.id !== agent.id &&
      Math.abs(o.x - agent.x) <= 4 &&
      Math.abs(o.y - agent.y) <= 4,
  );
  if (nearby.length) return null;

  // Parting commit — leave venue after a transfer
  if (agent.commit_action === "part" && (agent.commit_ticks ?? 0) > 0) {
    const dest = pickExplorePlace(agent, places, 13);
    return {
      action: "walk",
      target_place: dest,
      target_agent: null,
      utterance: null,
      thought: `Parting after the exchange — next scene at ${dest}.`,
      item: null,
      plan: decision.plan,
    };
  }

  // Don't yank someone away mid-answer or mid-appointment
  if (
    (agent.commit_action === "answer" || agent.commit_action === "appointment") &&
    (agent.commit_ticks ?? 0) > 0
  ) {
    return null;
  }

  const aloneStreak = placeCampStreak(agent, recentLog);
  const lastSolo = ["eat", "watch_show", "rest", "inspect", "shop", "arrive", "fix"].includes(
    agent.last_action || "",
  );
  const socialAct = SOCIAL.has(decision.action);
  if (socialAct && decision.target_agent) return null;
  if (!lastSolo && aloneStreak < 2 && decision.action === "walk" && decision.target_place) {
    // Already traveling somewhere — only override if going nowhere useful
    const destPeer = peers.find((p) => p.place_id === decision.target_place);
    if (destPeer) return null;
  }
  if (!lastSolo && aloneStreak < 2 && !["idle", "reflect", "continue"].includes(decision.action)) {
    return null;
  }

  const candidates = peers.filter(
    (o) => o.id !== agent.id && o.place_id && o.place_id !== agent.place_id,
  );
  if (!candidates.length) return null;

  const scored = candidates.map((o) => {
    const rel =
      relationships.find((r) => r.agent_id === agent.id && r.other_id === o.id)
        ?.score ?? 0;
    return { o, s: rel };
  });
  scored.sort((a, b) => b.s - a.s || a.o.name.localeCompare(b.o.name));
  const target = scored[0]!.o;
  const crowd = [agent, ...peers];
  const meetAt = pickMeetupPlace({
    agents: crowd,
    places,
    prefer: target.place_id,
    avoid: agent.place_id,
    peerHaunt: target.haunt_place_id,
    selfHaunt: agent.haunt_place_id,
    salt: `${agent.name}->${target.name}`,
  });
  return {
    action: "walk",
    target_place: meetAt,
    target_agent: target.id,
    utterance: null,
    thought: `Crossing town to meet ${target.name} at ${meetAt} for a fresh exchange.`,
    item: null,
    plan: decision.plan,
  };
}

/** Commitment overlay after a successful teach/share/debate/demo. */
export function partingCommitment(placeId: string | null): {
  commit_action: string;
  commit_detail: string;
  commit_ticks: number;
} {
  return {
    commit_action: "part",
    commit_detail: `Leave ${placeId || "here"} after the learning beat — find a new venue.`,
    commit_ticks: 1,
  };
}

/**
 * When stuck in a topic/place social loop, force walk to a fresh venue.
 * Returns null if no break needed.
 */
export function breakTopicLoop(
  agent: Agent,
  decision: AgentDecision,
  recentLog: CityLogRow[],
  places: Place[],
  peers: Agent[] = [],
): AgentDecision | null {
  // Never yank agents out of an active multi-turn dialogue
  if (agent.commit_action === "dialogue") return null;

  const loop = detectTopicLoop(recentLog);
  const streak = socialStreak(agent, recentLog);
  const camp = placeCampStreak(agent, recentLog);
  const stuckSocial =
    loop ||
    streak >= 4 ||
    camp >= 5 ||
    (SOCIAL.has(agent.last_action || "") &&
      (agent.place_id === "market" || agent.place_id === "plaza") &&
      streak >= 3);

  if (!stuckSocial) return null;
  if (
    decision.action === "walk" &&
    decision.target_place &&
    decision.target_place !== agent.place_id &&
    decision.target_place !== "market" &&
    decision.target_place !== "plaza"
  ) {
    return null; // already escaping to a fresh venue
  }
  if (
    decision.action === "reflect" ||
    decision.action === "leave_note" ||
    decision.action === "watch_show" ||
    decision.action === "fix" ||
    decision.action === "work" ||
    decision.action === "eat"
  ) {
    return null; // productive local change of beat
  }

  const dest = pickExplorePlace(agent, places, 0, peers);
  return {
    action: "walk",
    target_place: dest,
    target_agent: null,
    utterance: null,
    thought: `Breaking the topic loop — heading to ${dest} for a fresh beat.`,
    item: null,
    plan: decision.plan,
  };
}

/** How many notes this agent already posted at their current place recently. */
export function notesAtPlace(
  agent: Agent,
  recentLog: CityLogRow[],
  placeId?: string | null,
): number {
  const place = placeId || agent.place_id;
  if (!place) return 0;
  let n = 0;
  for (const row of recentLog.slice(0, 40)) {
    if (row.agent_id !== agent.id) continue;
    if (row.kind !== "post") continue;
    // Most posts are at current hangout; count all recent posts as soft spam signal
    n += 1;
    if (n >= 5) break;
  }
  return n;
}

/**
 * Soft-cap leave_note / post_notice spam — redirect to reflect, rest, or explore.
 */
export function enforceNoteCap(
  agent: Agent,
  decision: AgentDecision,
  recentLog: CityLogRow[],
  places: Place[],
): AgentDecision {
  if (decision.action !== "leave_note" && decision.action !== "post_notice") {
    return decision;
  }
  const count = notesAtPlace(agent, recentLog);
  if (count < 2) return decision;

  // Already posted enough — deepen elsewhere
  if ((agent.commit_ticks ?? 0) > 0) {
    return {
      ...decision,
      action: "reflect",
      utterance: null,
      thought:
        decision.thought ||
        "Already left notes here — reflecting instead of spamming the board.",
      item: "board_discipline",
    };
  }
  const dest = pickExplorePlace(agent, places, 7);
  return {
    action: "walk",
    target_place: dest,
    target_agent: null,
    utterance: null,
    thought: `Board is full of my notes — walking to ${dest} for a new beat.`,
    item: null,
    plan: decision.plan,
  };
}

/** If already traveling to dest, never re-issue walk — keep stepping. */
export function stabilizeTravel(
  agent: Agent,
  decision: AgentDecision,
): AgentDecision {
  if (agent.status === "walking" && agent.target_place_id) {
    return {
      action: "continue",
      thought:
        decision.thought ||
        `Still walking to ${agent.target_place_id} — staying on roads.`,
    };
  }
  if (
    decision.action === "walk" &&
    agent.target_place_id &&
    decision.target_place === agent.target_place_id
  ) {
    return {
      action: "continue",
      thought: `Already en route to ${agent.target_place_id}.`,
    };
  }
  return decision;
}

/** If they try to walk away mid-beat, keep them finishing locally — unless breaking a loop. */
export function enforceCommitment(
  agent: Agent,
  decision: AgentDecision,
  opts?: { allowWalkBreak?: boolean },
): AgentDecision {
  const ticks = agent.commit_ticks ?? 0;
  if (decision.action === "continue" || decision.action === "sleep") {
    return decision;
  }

  // Multi-turn dialogue lock — stay in conversation even if ticks were cleared
  if (agent.commit_action === "dialogue") {
    if (
      decision.action === "talk" ||
      decision.action === "ask_question" ||
      decision.action === "share_experience" ||
      decision.action === "teach" ||
      decision.action === "debate" ||
      decision.action === "demo" ||
      decision.action === "join"
    ) {
      return decision;
    }
    // Only allow walk when explicitly aimed at the conversation partner
    if (
      decision.action === "walk" &&
      decision.target_agent &&
      (decision.target_agent === agent.pending_answer_to ||
        opts?.allowWalkBreak)
    ) {
      return decision;
    }
    return {
      ...decision,
      action: "talk",
      target_agent: decision.target_agent || agent.pending_answer_to || null,
      target_place: null,
      thought:
        decision.thought ||
        `Still in conversation: ${agent.commit_detail || "dialogue"}.`,
      utterance: decision.utterance,
    };
  }

  if (ticks <= 0) return decision;

  // Answering a peer — don't deepen into solo loops; keep walking/talking toward them
  if (agent.commit_action === "answer") {
    if (
      decision.action === "walk" ||
      decision.action === "teach" ||
      decision.action === "talk" ||
      decision.action === "share_experience" ||
      decision.action === "debate" ||
      decision.action === "demo" ||
      decision.action === "ask_question"
    ) {
      return decision;
    }
    return {
      ...decision,
      action: "walk",
      target_place: decision.target_place || agent.place_id || "plaza",
      thought:
        decision.thought ||
        `Still answering about ${agent.commit_detail || "their question"}.`,
    };
  }

  // Keeping an appointment — allow walk/join/talk toward the meetup
  if (agent.commit_action === "appointment") {
    if (
      decision.action === "walk" ||
      decision.action === "join" ||
      decision.action === "talk" ||
      decision.action === "debate" ||
      decision.action === "leave_note"
    ) {
      return decision;
    }
    return {
      ...decision,
      action: "walk",
      target_place:
        decision.target_place ||
        agent.appointment_place ||
        agent.place_id ||
        "plaza",
      thought:
        decision.thought ||
        `Still keeping my appointment: ${agent.commit_detail || "meetup"}.`,
    };
  }

  if (decision.action !== "walk") return decision;
  if (opts?.allowWalkBreak) return decision;

  // Parting after teach/share — always allow/force walk
  if (agent.commit_action === "part") {
    return decision;
  }

  // Solo loops (eat/watch forever) — always allow walk break
  const solo = new Set(["eat", "watch_show", "rest", "shop", "work"]);
  if (
    solo.has(String(agent.commit_action || "")) ||
    solo.has(String(agent.last_action || ""))
  ) {
    return decision;
  }

  const deepen = (
    agent.last_action && LOCAL_DEEPEN.includes(agent.last_action as ActionName)
      ? agent.last_action
      : agent.commit_action && LOCAL_DEEPEN.includes(agent.commit_action as ActionName)
        ? agent.commit_action
        : "reflect"
  ) as ActionName;

  // Can't finish a social beat without a peer — let them walk instead of
  // inventing ask_question/teach with a null target (RPC → need_agent).
  if (SOCIAL.has(deepen) && !decision.target_agent) {
    return decision;
  }

  return {
    action: deepen,
    target_place: agent.place_id,
    target_agent: decision.target_agent,
    utterance: decision.utterance,
    thought:
      decision.thought ||
      `Still committed to "${agent.commit_detail || agent.commit_action || "this beat"}" (${ticks} ticks left).`,
    item: decision.item,
    plan: decision.plan,
  };
}

export function nextCommitment(
  agent: Agent,
  action: string,
  recentLog: CityLogRow[] = [],
): { commit_action: string | null; commit_detail: string | null; commit_ticks: number } {
  if (action === "walk") {
    return { commit_action: null, commit_detail: null, commit_ticks: 0 };
  }
  if (action === "continue" || action === "idle") {
    return {
      commit_action: agent.commit_action ?? null,
      commit_detail: agent.commit_detail ?? null,
      commit_ticks: Math.max(0, (agent.commit_ticks ?? 0) - 1),
    };
  }

  const active = agent.commit_ticks ?? 0;
  const streak = socialStreak(agent, recentLog);
  // Cap endless social refresh — after a long streak, expire commitment so they can travel
  if (SOCIAL.has(action) && streak >= 3) {
    return {
      commit_action: null,
      commit_detail: null,
      commit_ticks: 0,
    };
  }
  // Don't spam set_plan if one already exists
  if (action === "set_plan" && agent.day_plan) {
    return {
      commit_action: agent.commit_action ?? null,
      commit_detail: agent.commit_detail ?? null,
      commit_ticks: Math.max(0, active - 1),
    };
  }

  // Same solo beat again (eat/watch/rest/inspect loop) — expire so they can travel
  const SOLO = new Set(["eat", "watch_show", "rest", "shop", "work", "inspect"]);
  if (
    SOLO.has(action) &&
    (agent.last_action === action || agent.commit_action === action)
  ) {
    // First completion of an arrival solo beat: allow one countdown, then clear
    if (agent.last_action === action || (agent.commit_ticks ?? 0) <= 1) {
      return {
        commit_action: null,
        commit_detail: null,
        commit_ticks: 0,
      };
    }
  }

  // Same beat family: count down toward finishing
  if (
    active > 0 &&
    (action === agent.commit_action ||
      action === agent.last_action ||
      (agent.commit_action &&
        SOCIAL.has(agent.commit_action) &&
        (SOCIAL.has(action) || action === "reflect")))
  ) {
    return {
      commit_action: agent.commit_action || action,
      commit_detail: agent.commit_detail || `Finish ${action.replace(/_/g, " ")}.`,
      commit_ticks: Math.max(0, active - 1),
    };
  }

  // Ignore synthetic commit labels that aren't real actions
  const fresh = BEAT_COMMIT[action];
  // Solo spectacles: short commits only (1 tick) so they don't camp
  if (fresh != null && SOLO.has(action)) {
    return {
      commit_action: action,
      commit_detail: `One ${action.replace(/_/g, " ")} beat, then move.`,
      commit_ticks: 1,
    };
  }
  if (fresh != null) {
    return {
      commit_action: action,
      commit_detail: `Finish ${action.replace(/_/g, " ")} before chasing a new destination.`,
      commit_ticks: fresh,
    };
  }

  return {
    commit_action: null,
    commit_detail: null,
    commit_ticks: 0,
  };
}

export function journalForAction(
  agent: Agent,
  action: string,
  decision: AgentDecision,
): { kind: string; title: string; body: string } | null {
  if (action === "set_plan") {
    return {
      kind: "plan",
      title: "Updated day plan",
      body: decision.plan || decision.utterance || agent.day_plan || "New plan set.",
    };
  }
  if (action === "share_experience") {
    return {
      kind: "learn",
      title: "Shared craft",
      body: decision.utterance || "Shared a sanitized experience with peers nearby.",
    };
  }
  if (action === "teach") {
    return {
      kind: "learn",
      title: "Taught a peer",
      body: decision.utterance || "Taught a practice to someone nearby.",
    };
  }
  if (action === "ask_question") {
    return {
      kind: "learn",
      title: "Asked a peer",
      body: decision.utterance || "Asked a concrete craft question.",
    };
  }
  if (action === "debate") {
    return {
      kind: "learn",
      title: "Debated a method",
      body: decision.utterance || "Compared approaches with a peer.",
    };
  }
  if (action === "demo") {
    return {
      kind: "achieve",
      title: "Demoed a method",
      body: decision.utterance || "Showed a practice in public.",
    };
  }
  if (action === "practice_skill") {
    return {
      kind: "learn",
      title: "Practiced a skill",
      body: decision.utterance || decision.thought || "Rehearsed an owned skill.",
    };
  }
  if (action === "reflect") {
    return {
      kind: "mindset",
      title: "Reflection",
      body: decision.thought || decision.utterance || "Took a moment to integrate a lesson.",
    };
  }
  if (action === "walk" && decision.target_place) {
    return {
      kind: "beat",
      title: "On the move",
      body: `Heading to ${decision.target_place}${decision.thought ? ` — ${decision.thought}` : "."}`,
    };
  }
  if (action === "talk" && decision.utterance) {
    return {
      kind: "beat",
      title: "Conversation",
      body: decision.utterance,
    };
  }
  if (action === "leave_note" || action === "post_notice") {
    return {
      kind: "beat",
      title: "Left a public note",
      body: decision.utterance || "Posted on the town board.",
    };
  }
  if (action === "work" || action === "fix" || action === "start_shift") {
    return {
      kind: "achieve",
      title: "Did the work",
      body: decision.thought || `Spent a beat on ${action.replace(/_/g, " ")}.`,
    };
  }
  return null;
}
