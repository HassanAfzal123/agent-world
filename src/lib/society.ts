import type { Agent, Place, CityLogRow } from "@/lib/types";
import type { AgentDecision } from "@/lib/llm";
import type { ActionName } from "@/lib/townMap";
import { cleanSpeech } from "@/lib/spectator";

export const COUNCIL_EVENT = "council_session";

const ROLE_VENUE: Record<string, ActionName> = {
  fixer: "fix",
  host: "talk",
  guide: "inspect",
  critic: "watch_show",
  regular: "reflect",
};

/**
 * Pull words only from the agent's own open-mind fields — never invent slogans.
 * Returns null if they have nothing of their own yet.
 */
export function voiceFromAgent(agent: Agent, max = 140): string | null {
  const raw =
    (agent.thought && agent.thought.trim()) ||
    (agent.mindset && agent.mindset.trim()) ||
    (agent.goal && agent.goal.trim()) ||
    (agent.personality && agent.personality.trim()) ||
    "";
  if (!raw) return null;
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/**
 * Council agenda from open minds only — never a hardcoded slogan list.
 * Prefers live questions agents already asked; else goals / thoughts / craft aims.
 */
export function councilTopicFromAgents(
  agents: Agent[],
  log: CityLogRow[] = [],
  tick = 0,
): string | null {
  const scored: { text: string; weight: number }[] = [];

  for (const row of log.slice(0, 40)) {
    if (row.kind !== "say" && row.kind !== "ask_question" && row.kind !== "event") {
      continue;
    }
    const msg = row.message || "";
    const quoted =
      msg.match(/:"([^"]{12,})"/)?.[1] ||
      msg.match(/: "([^"]{12,})"/)?.[1] ||
      null;
    const q = cleanSpeech(quoted);
    if (!q) continue;
    const weight = /\?/.test(q) ? 30 : 12;
    scored.push({ text: q, weight });
  }

  for (const a of agents) {
    const pending = cleanSpeech(a.pending_answer_question || a.pending_answer_topic);
    if (pending) scored.push({ text: pending, weight: 28 });

    const goal = cleanSpeech(a.goal);
    if (goal) {
      scored.push({
        text: /\?/.test(goal) ? goal : `How should town handle: ${goal}`,
        weight: 18,
      });
    }

    const thought = cleanSpeech(a.thought);
    if (thought && thought.length > 24) {
      scored.push({
        text: /\?/.test(thought) ? thought : thought,
        weight: /\?/.test(thought) ? 22 : 10,
      });
    }

    const note = cleanSpeech(a.appointment_note);
    if (note) scored.push({ text: note, weight: 14 });

    const mind = cleanSpeech(a.mindset);
    if (mind && mind.length > 20) scored.push({ text: mind, weight: 8 });
  }

  if (!scored.length) return null;

  // Stable pick from living material (not a fixed slogan bank)
  const total = scored.reduce((s, x) => s + x.weight, 0);
  let cursor = Math.abs(tick) % Math.max(1, total);
  for (const row of scored) {
    cursor -= row.weight;
    if (cursor < 0) {
      const t = row.text.trim().replace(/\s+/g, " ");
      return t.length > 140 ? `${t.slice(0, 139)}…` : t;
    }
  }
  const fallback = scored[0].text.trim().replace(/\s+/g, " ");
  return fallback.length > 140 ? `${fallback.slice(0, 139)}…` : fallback;
}

/** Turn an agent's spoken line into a council topic when none exists yet. */
export function topicFromUtterance(utterance: string | null | undefined): string | null {
  const q = cleanSpeech(utterance);
  if (!q) return null;
  if (q.length < 16) return null;
  return q.length > 140 ? `${q.slice(0, 139)}…` : q;
}

/** Appointment is due if hour is at/after booked hour (same day window). */
export function appointmentDue(agent: Agent, hour: number): boolean {
  if (!agent.appointment_with && !agent.appointment_place) return false;
  if (agent.appointment_hour == null) return true;
  const h = agent.appointment_hour;
  if (hour >= h) return true;
  if (hour >= h - 1) return true;
  return false;
}

export function peerInRange(agent: Agent, other: Agent | undefined | null): boolean {
  if (!other) return false;
  return Math.abs(other.x - agent.x) <= 4 && Math.abs(other.y - agent.y) <= 4;
}

/**
 * Structure only: walk toward a booked meetup.
 * When already in range, return null so the agent's open mind (LLM) speaks.
 */
export function forceAppointmentDecision(
  agent: Agent,
  peers: Agent[],
  hour: number,
): AgentDecision | null {
  if (!appointmentDue(agent, hour)) return null;
  if (!agent.appointment_with && !agent.appointment_place) return null;

  const other = agent.appointment_with
    ? peers.find((p) => p.id === agent.appointment_with)
    : null;
  const dest =
    agent.appointment_place ||
    other?.place_id ||
    other?.target_place_id ||
    agent.haunt_place_id ||
    "plaza";

  if (peerInRange(agent, other)) {
    // In range — do not script dialogue; let LLM / open-mind path decide
    return null;
  }

  if (agent.place_id === dest && !other) {
    // At place, no peer object — still no canned speech
    return null;
  }

  return {
    action: "walk",
    target_place: dest,
    target_agent: agent.appointment_with,
    thought: null,
    utterance: null,
    item: null,
  };
}

const COUNCIL_SPEECH = new Set([
  "talk",
  "debate",
  "ask_question",
  "share_experience",
  "post_notice",
  "demo",
  "teach",
]);

/**
 * Soft council invite — walk to venue once.
 * After an agent has spoken (or marked council_attended), do NOT yank them back
 * every tick (that caused stage yo-yo with no time for cafe/workshop life).
 */
export function forceCouncilDecision(
  agent: Agent,
  _peers: Agent[],
  eventName: string | null | undefined,
  eventPlace: string | null | undefined,
  _eventTopic?: string | null | undefined,
): AgentDecision | null {
  if (eventName !== COUNCIL_EVENT) return null;
  const place = eventPlace || "stage";

  if (agent.place_id === place) return null;
  if (agent.commit_action === "council_attended") return null;
  if (COUNCIL_SPEECH.has(String(agent.last_action || ""))) return null;

  // Don't interrupt an active walk to somewhere else (meetup / haunt / explore)
  if (
    agent.status === "walking" &&
    agent.target_place_id &&
    agent.target_place_id !== place
  ) {
    return null;
  }

  // Appointments win over council herding
  if (agent.appointment_with || agent.appointment_place) return null;

  return {
    action: "walk",
    target_place: place,
    thought: null,
    utterance: null,
    item: null,
  };
}

/**
 * Ambient town events (rain_break, market_day, quiet_afternoon, …) should also
 * pull free agents toward event_place — softer than council but not ignoreable.
 */
export function forceEventGatherDecision(
  agent: Agent,
  _peers: Agent[],
  eventName: string | null | undefined,
  eventPlace: string | null | undefined,
): AgentDecision | null {
  if (!eventName || !eventPlace) return null;
  if (eventName === COUNCIL_EVENT) return null; // handled by forceCouncilDecision
  if (agent.place_id === eventPlace) return null;
  if (agent.pending_answer_to) return null;
  if (agent.appointment_with || agent.appointment_place) return null;
  if (agent.commit_action === "dialogue") return null;
  if (
    agent.status === "walking" &&
    agent.target_place_id &&
    agent.target_place_id !== eventPlace
  ) {
    return null;
  }
  // Soft herding: only when idle / arrived, not mid-speech.
  if (agent.status === "talking") return null;

  return {
    action: "walk",
    target_place: eventPlace,
    thought: null,
    utterance: null,
    item: null,
  };
}

/** True during forced plaza gather windows (all claimed agents).
 * Prefer live `inGather` from ensure_proposal_cycle — never hardcode :33/:41. */
export function inProposalPlazaGather(
  phase: string | null | undefined,
  inGather?: boolean | null,
): boolean {
  if (inGather === true) return true;
  if (phase === "meeting" || phase === "voting") return true;
  return false;
}

/** Prep gather window: every agent walks to plaza before the daily meeting. */
export function forceProposalPrepDecision(
  agent: Agent,
  phase: string | null | undefined,
  inGather: boolean | null | undefined,
  meetingPlace: string | null | undefined,
): AgentDecision | null {
  if (phase !== "collaborate") return null;
  if (!inGather) return null;
  const place = meetingPlace || "plaza";
  if (agent.place_id === place) return null;
  if (
    agent.status === "walking" &&
    agent.target_place_id === place
  ) {
    return null;
  }
  return {
    action: "walk",
    target_place: place,
    thought:
      "Forced process: pre-meeting prep — every agent to plaza before daily Town Hall. Form a GROUP, co-write a detailed tool draft (ideas still ours).",
    utterance: null,
    item: null,
  };
}

/** Town Hall meeting / voting: every agent to plaza (redirect mid-walk). */
export function forceProposalMeetingDecision(
  agent: Agent,
  phase: string | null | undefined,
  meetingPlace: string | null | undefined,
): AgentDecision | null {
  if (phase !== "meeting" && phase !== "voting") return null;
  const place = meetingPlace || "plaza";
  if (agent.place_id === place) return null;
  if (
    agent.status === "walking" &&
    agent.target_place_id === place
  ) {
    return null;
  }
  // Redirect even if already walking elsewhere — process beats open stage / chitchat.
  return {
    action: "walk",
    target_place: place,
    thought: `Forced process: every agent reports to ${place} for Town Hall ${phase}. Decisions (ideas/votes) stay yours.`,
    utterance: null,
    item: null,
  };
}

/**
 * After LLM / other nudges: nobody leaves plaza during prep/meeting/voting,
 * and anyone elsewhere is sent there.
 */
export function clampToProposalGather(
  agent: Agent,
  decision: AgentDecision,
  phase: string | null | undefined,
  inGather: boolean | null | undefined,
  meetingPlace: string | null | undefined,
  championId?: string | null,
): AgentDecision {
  // Champion must stay on library path during filing.
  if (
    phase === "filing" &&
    championId &&
    agent.id === championId
  ) {
    const leavingLib =
      decision.action === "walk" &&
      decision.target_place &&
      decision.target_place !== "library";
    if (agent.place_id === "library") {
      if (leavingLib) {
        return {
          action: "idle",
          target_place: null,
          target_agent: null,
          item: null,
          utterance: null,
          thought:
            "Forced process: stay at library — file_proposal with the DETAILED group report now.",
        };
      }
      return decision;
    }
    if (!(decision.action === "walk" && decision.target_place === "library")) {
      return {
        action: "walk",
        target_place: "library",
        target_agent: null,
        item: null,
        utterance: null,
        thought:
          "Forced process: filing champion reports to library with the detailed winning report.",
      };
    }
    return decision;
  }

  if (!inProposalPlazaGather(phase, inGather)) return decision;
  const place = meetingPlace || "plaza";
  const label =
    phase === "collaborate" ? "prep" : String(phase || "meeting");

  const goingToPlace =
    decision.action === "walk" && decision.target_place === place;
  const leavingPlace =
    decision.action === "walk" &&
    Boolean(decision.target_place) &&
    decision.target_place !== place;

  if (agent.place_id === place) {
    if (leavingPlace) {
      return {
        action: "idle",
        target_place: null,
        target_agent: null,
        item: null,
        utterance: null,
        thought: `Forced process: stay at ${place} for Town Hall ${label} — invite_to_group, co-write a DETAILED draft, nominate as a group; do not leave.`,
      };
    }
    return decision;
  }

  if (goingToPlace) return decision;
  if (
    agent.status === "walking" &&
    agent.target_place_id === place &&
    !leavingPlace
  ) {
    return decision;
  }

  return {
    action: "walk",
    target_place: place,
    target_agent: null,
    item: null,
    utterance: null,
    thought: `Forced process: every agent reports to ${place} for Town Hall ${label}.`,
  };
}

/** Filing phase: champion walks to library (redirect mid-walk). */
export function forceProposalFilingDecision(
  agent: Agent,
  phase: string | null | undefined,
  championId: string | null | undefined,
): AgentDecision | null {
  if (phase !== "filing") return null;
  if (!championId || agent.id !== championId) return null;
  if (agent.place_id === "library") return null;
  if (
    agent.status === "walking" &&
    agent.target_place_id === "library"
  ) {
    return null;
  }
  return {
    action: "walk",
    target_place: "library",
    thought:
      "Forced process: I am filing champion — walk to library, then file_proposal with the DETAILED group report.",
    utterance: null,
    item: null,
  };
}

/** Non-champions during filing: gather at library to help pitch the report. */
export function forceProposalFilingSupportDecision(
  agent: Agent,
  phase: string | null | undefined,
  championId: string | null | undefined,
): AgentDecision | null {
  if (phase !== "filing") return null;
  if (!championId || agent.id === championId) return null;
  if (agent.place_id === "library") return null;
  if (
    agent.status === "walking" &&
    agent.target_place_id === "library"
  ) {
    return null;
  }
  return {
    action: "walk",
    target_place: "library",
    thought:
      "Forced process: help the champion at the library — group-discuss the DETAILED filing report and pitch.",
    utterance: null,
    item: null,
  };
}

/** True when this agent should speak with an open mind (prefer LLM). */
export function needsOpenMindSpeech(
  agent: Agent,
  peers: Agent[],
  hour: number,
  eventName: string | null | undefined,
  eventPlace: string | null | undefined,
): boolean {
  if (agent.pending_answer_to) {
    const asker = peers.find((p) => p.id === agent.pending_answer_to);
    if (peerInRange(agent, asker)) return true;
  }
  if (appointmentDue(agent, hour) && agent.appointment_with) {
    const other = peers.find((p) => p.id === agent.appointment_with);
    if (peerInRange(agent, other)) return true;
  }
  if (
    eventName === COUNCIL_EVENT &&
    agent.place_id === (eventPlace || "stage")
  ) {
    return true;
  }
  return false;
}

/** Prefer haunt after parting / at night / when alone — walk only, no scripted mind. */
export function hauntWalkDecision(
  agent: Agent,
  places: Place[],
  hour: number,
  alone: boolean,
): AgentDecision | null {
  const haunt = agent.haunt_place_id;
  if (!haunt) return null;
  if (agent.place_id === haunt) return null;
  const night = hour >= 20 || hour < 6;
  const parting = agent.commit_action === "part";
  if (!night && !parting && !alone) return null;
  if (!places.some((p) => p.id === haunt)) return null;
  return {
    action: "walk",
    target_place: haunt,
    thought: null,
    utterance: null,
    item: null,
  };
}

/** Local beat colored by town_role — action only; mind stays empty for LLM later. */
export function roleLocalBeat(agent: Agent): AgentDecision | null {
  const role = (agent.town_role || "").toLowerCase();
  if (!role) return null;
  const haunt = agent.haunt_place_id;
  if (!haunt || agent.place_id !== haunt) return null;
  const act = ROLE_VENUE[role] || "reflect";
  if (act === "talk" || act === "fix") {
    return {
      action: role === "fixer" ? "inspect" : "reflect",
      target_place: haunt,
      thought: null,
      utterance: null,
      item: role === "fixer" ? "broken_stall" : null,
    };
  }
  return {
    action: act,
    target_place: haunt,
    thought: null,
    utterance: null,
    item: null,
  };
}

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  return role.replace(/_/g, " ");
}
