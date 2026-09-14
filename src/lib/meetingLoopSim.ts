/**
 * In-memory Town Hall meeting loop simulator with dummy agents.
 * Pure TS — no DB. Used by the test suite to lock procedure behavior.
 */

export type SimPhase =
  | "collaborate"
  | "meeting"
  | "voting"
  | "filing"
  | "closed";

export type DummyAgent = {
  id: string;
  name: string;
  place_id: string;
  draft_title?: string;
  draft_body?: string;
  in_group?: boolean;
  group_turns?: number;
};

export type Nomination = {
  id: string;
  agent_id: string;
  title: string;
  summary: string;
  votes: string[];
};

export type MeetingSimState = {
  phase: SimPhase;
  meeting_place: string;
  agents: DummyAgent[];
  nominations: Nomination[];
  winner_id: string | null;
  champion_id: string | null;
  filed: { title: string; body: string; by: string } | null;
  log: string[];
};

const DETAIL_MIN = 400;

export function createMeetingSim(
  agents: DummyAgent[],
  meetingPlace = "plaza",
): MeetingSimState {
  return {
    phase: "collaborate",
    meeting_place: meetingPlace,
    agents: agents.map((a) => ({ ...a })),
    nominations: [],
    winner_id: null,
    champion_id: null,
    filed: null,
    log: ["sim_created"],
  };
}

export function snapAllToMeeting(state: MeetingSimState): MeetingSimState {
  return {
    ...state,
    agents: state.agents.map((a) => ({
      ...a,
      place_id: state.meeting_place,
    })),
    log: [...state.log, "snap_all_to_meeting"],
  };
}

export function openGroup(
  state: MeetingSimState,
  memberIds: string[],
): MeetingSimState {
  if (memberIds.length < 3) {
    return { ...state, log: [...state.log, "group_failed_need_three"] };
  }
  const set = new Set(memberIds);
  return {
    ...state,
    agents: state.agents.map((a) =>
      set.has(a.id)
        ? { ...a, in_group: true, group_turns: a.group_turns || 0 }
        : a,
    ),
    log: [...state.log, `group_open:${memberIds.length}`],
  };
}

export function tickGroupTalk(state: MeetingSimState): MeetingSimState {
  return {
    ...state,
    agents: state.agents.map((a) =>
      a.in_group
        ? { ...a, group_turns: (a.group_turns || 0) + 1 }
        : a,
    ),
    log: [...state.log, "group_talk"],
  };
}

export function composeDraft(
  state: MeetingSimState,
  agentId: string,
  title: string,
  body: string,
): MeetingSimState {
  return {
    ...state,
    agents: state.agents.map((a) =>
      a.id === agentId
        ? { ...a, draft_title: title, draft_body: body }
        : a,
    ),
    log: [...state.log, `compose:${agentId}`],
  };
}

export function setPhase(
  state: MeetingSimState,
  phase: SimPhase,
): MeetingSimState {
  return { ...state, phase, log: [...state.log, `phase:${phase}`] };
}

export type NominateResult =
  | { ok: true; state: MeetingSimState }
  | { ok: false; error: string; state: MeetingSimState };

export function nominate(
  state: MeetingSimState,
  agentId: string,
): NominateResult {
  if (state.phase !== "meeting" && state.phase !== "collaborate") {
    // Allow empty-ballot salvage in early voting
    if (!(state.phase === "voting" && state.nominations.length === 0)) {
      return {
        ok: false,
        error: "nominate_wrong_phase",
        state: { ...state, log: [...state.log, "nominate_wrong_phase"] },
      };
    }
  }
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    return { ok: false, error: "no_agent", state };
  }
  const groupmates = state.agents.filter((a) => a.in_group);
  if (groupmates.length < 3 || (agent.group_turns || 0) < 4) {
    return {
      ok: false,
      error: "need_group_collab",
      state: { ...state, log: [...state.log, "need_group_collab"] },
    };
  }
  const title = (agent.draft_title || "").trim();
  const body = (agent.draft_body || "").trim();
  if (title.length < 8) {
    return { ok: false, error: "title_too_short", state };
  }
  if (body.length < DETAIL_MIN) {
    return {
      ok: false,
      error: "summary_too_short",
      state: { ...state, log: [...state.log, "summary_too_short"] },
    };
  }
  if (agent.place_id !== state.meeting_place && state.phase === "meeting") {
    // still allow if snapped earlier; soft warn only
  }
  const nom: Nomination = {
    id: `nom-${state.nominations.length + 1}`,
    agent_id: agentId,
    title,
    summary: body,
    votes: [],
  };
  return {
    ok: true,
    state: {
      ...state,
      nominations: [...state.nominations, nom],
      log: [...state.log, `nominated:${title}`],
    },
  };
}

export function vote(
  state: MeetingSimState,
  agentId: string,
  nominationId: string,
): MeetingSimState {
  if (state.phase !== "voting" && state.phase !== "meeting") {
    return { ...state, log: [...state.log, "vote_wrong_phase"] };
  }
  return {
    ...state,
    nominations: state.nominations.map((n) =>
      n.id === nominationId && !n.votes.includes(agentId)
        ? { ...n, votes: [...n.votes, agentId] }
        : n,
    ),
    log: [...state.log, `vote:${agentId}->${nominationId}`],
  };
}

export function resolveWinner(state: MeetingSimState): MeetingSimState {
  if (!state.nominations.length) {
    return {
      ...state,
      phase: "closed",
      winner_id: null,
      champion_id: null,
      log: [...state.log, "closed_empty"],
    };
  }
  const ranked = [...state.nominations].sort(
    (a, b) => b.votes.length - a.votes.length,
  );
  const win = ranked[0];
  return {
    ...state,
    winner_id: win.id,
    champion_id: win.agent_id,
    phase: "filing",
    log: [...state.log, `winner:${win.title}`],
  };
}

export function fileWinning(
  state: MeetingSimState,
  agentId: string,
): MeetingSimState {
  if (state.phase !== "filing") {
    return { ...state, log: [...state.log, "file_wrong_phase"] };
  }
  if (agentId !== state.champion_id) {
    return { ...state, log: [...state.log, "file_not_champion"] };
  }
  const win = state.nominations.find((n) => n.id === state.winner_id);
  if (!win || win.summary.length < DETAIL_MIN) {
    return { ...state, log: [...state.log, "file_body_too_short"] };
  }
  const agent = state.agents.find((a) => a.id === agentId);
  if (agent?.place_id !== "library") {
    return { ...state, log: [...state.log, "file_need_library"] };
  }
  return {
    ...state,
    phase: "closed",
    filed: { title: win.title, body: win.summary, by: agentId },
    log: [...state.log, `filed:${win.title}`],
  };
}

/** Happy-path script used by tests. */
export function runHappyTownHall(agents: DummyAgent[]): MeetingSimState {
  let s = createMeetingSim(agents);
  s = snapAllToMeeting(s);
  s = openGroup(
    s,
    s.agents.slice(0, 3).map((a) => a.id),
  );
  for (let i = 0; i < 4; i++) s = tickGroupTalk(s);
  const body =
    "Problem: agents lose track of plaza upkeep.\n".repeat(12) +
    "Design: hourly rotation tool with roles and success checks.\n" +
    "Risks: spam invites. Success: one clean plaza plan per day.";
  s = composeDraft(s, s.agents[0].id, "Plaza Rotation Tool", body);
  s = setPhase(s, "meeting");
  const nom = nominate(s, s.agents[0].id);
  if (!nom.ok) return nom.state;
  s = nom.state;
  s = setPhase(s, "voting");
  for (const a of s.agents) {
    s = vote(s, a.id, s.nominations[0].id);
  }
  s = resolveWinner(s);
  s = {
    ...s,
    agents: s.agents.map((a) =>
      a.id === s.champion_id ? { ...a, place_id: "library" } : a,
    ),
  };
  s = fileWinning(s, s.champion_id!);
  return s;
}
