import type { Agent, Place } from "@/lib/types";
import type { AgentDecision } from "@/lib/llm";
import type { ActionName } from "@/lib/townMap";
import { agentSkillTags, pickFreshTip } from "@/lib/learning";
import {
  forceCouncilDecision,
  hauntWalkDecision,
  roleLocalBeat,
  voiceFromAgent,
  COUNCIL_EVENT,
} from "@/lib/society";

const SOLO_LOOPS = new Set([
  "eat",
  "watch_show",
  "rest",
  "shop",
  "work",
  "inspect",
]);

const SPECTACLE_PLACES = [
  "stage",
  "workshop",
  "cafe",
  "library",
  "market",
  "docks",
  "park",
] as const;

/**
 * Director brain when LLM providers fail.
 * Priority: meet peers → fresh exchange → one visible beat → move on.
 */
export function fallbackAgentDecision(
  agent: Agent,
  places: Place[],
  nearby: Agent[],
  tick = 0,
  opts?: {
    hour?: number;
    eventName?: string | null;
    eventPlace?: string | null;
    eventTopic?: string | null;
  },
): AgentDecision {
  const energy = agent.energy ?? 100;
  const hour = opts?.hour ?? tick % 24;
  const seed =
    ((tick * 17) ^
      (agent.name?.length || 1) * 31 ^
      (agent.x || 0) * 13 ^
      (agent.y || 0) * 7 ^
      Date.now() % 97) >>>
    0;
  const pick = <T,>(arr: T[]) => arr[seed % Math.max(1, arr.length)]!;
  const phase = seed % 6;
  const last = agent.last_action || "";
  const repeatingSolo = SOLO_LOOPS.has(last) && last === agent.commit_action;

  const council = forceCouncilDecision(
    agent,
    nearby,
    opts?.eventName,
    opts?.eventPlace,
    opts?.eventTopic,
  );
  if (council) return council;

  // 1) Critical energy — recover in place
  if (energy < 25) {
    const cafe = places.find((p) => p.id === "cafe");
    const inn = places.find((p) => p.id === "inn");
    const haunt = places.find((p) => p.id === agent.haunt_place_id);
    const hourHint = hour;
    const dest =
      energy < 8 && hourHint >= 20
        ? inn || haunt || cafe
        : haunt || cafe || inn || places.find((p) => p.id === agent.place_id);
    if (dest && agent.place_id !== dest.id && energy >= 8) {
      return {
        action: "walk",
        target_place: dest.id,
        thought: voiceFromAgent(agent),
        utterance: null,
      };
    }
    if (last !== "eat" && last !== "rest") {
      return {
        action: energy < 8 && hourHint >= 20 ? "sleep" : "eat",
        thought: voiceFromAgent(agent),
        utterance: null,
      };
    }
    return walkToSpectacle(
      agent,
      places,
      nearby,
      pick,
    );
  }

  // 2) Break solo loops — prefer peer meetup
  if (repeatingSolo || (SOLO_LOOPS.has(last) && (agent.commit_ticks ?? 0) > 0 && phase < 4)) {
    if (nearby.length) {
      return socialBeat(agent, nearby, pick, seed, "", {
        eventName: opts?.eventName,
        eventTopic: opts?.eventTopic,
      });
    }
    return walkToSpectacle(
      agent,
      places,
      nearby,
      pick,
    );
  }

  // 3) Peers nearby → fresh social / learning verbs
  if (nearby.length && phase <= 3) {
    return socialBeat(agent, nearby, pick, seed, "", {
      eventName: opts?.eventName,
      eventTopic: opts?.eventTopic,
    });
  }

  // 4) Haunt / role when alone
  const alone = !nearby.length;
  const haunt = hauntWalkDecision(agent, places, hour, alone);
  if (haunt) return haunt;
  const roleBeat = roleLocalBeat(agent);
  if (roleBeat && phase >= 4) return roleBeat;

  // 5) Alone + energy OK → always try peer place first (caller enriches)
  if (!nearby.length) {
    const peerDest = peerPlace(agent, places, nearby);
    if (peerDest) {
      return {
        action: "walk",
        target_place: peerDest,
        thought: voiceFromAgent(agent),
        utterance: null,
      };
    }
  }

  // 6) One local spectacle — different from last
  const local = localSpectacle(agent.place_id);
  if (local && local !== last && phase === 4) {
    return {
      action: local,
      thought: voiceFromAgent(agent),
      utterance: voiceFromAgent(agent),
      item: local === "fix" || local === "inspect" ? "broken_stall" : null,
    };
  }

  // 7) Default: move
  return walkToSpectacle(
    agent,
    places,
    nearby,
    pick,
  );
}

function socialBeat(
  agent: Agent,
  nearby: Agent[],
  pick: <T>(arr: T[]) => T,
  seed: number,
  _directorHint: string,
  opts?: { eventName?: string | null; eventTopic?: string | null },
): AgentDecision {
  const other = pick(nearby);
  const theirTags = agentSkillTags(other);
  const myTags = agentSkillTags(agent);
  const unknown = theirTags.filter((t) => !myTags.includes(t));
  const tip = pickFreshTip(agent, other, seed);
  // Open mind: only reuse this agent's own voice — never invent slogans
  const voice = voiceFromAgent(agent);
  const thought = voice;

  // Council: debate using the agent's own mind, not a canned civic line
  if (opts?.eventName === COUNCIL_EVENT) {
    return {
      action: "debate",
      target_agent: other.id,
      target_place: agent.place_id,
      utterance: voice,
      thought,
      item: null,
    };
  }

  // Prefer ask_question when they know something we don't
  if (unknown.length && seed % 3 === 0) {
    const topic = unknown[0]!;
    const label = topic.replace(/_/g, " ");
    return {
      action: "ask_question",
      target_agent: other.id,
      utterance: `How do you decide ${label} is working — what signal do you trust?`,
      item: `curiosity_${topic}`.slice(0, 60),
      thought,
    };
  }

  const social = pick([
    "talk",
    "ask_question",
    "share_experience",
    "teach",
    "debate",
    "demo",
  ] as ActionName[]);

  if (social === "talk" || social === "ask_question") {
    if (social === "ask_question") {
      const topic = unknown[0] || tip.tag;
      const label = topic.replace(/_/g, " ");
      return {
        action: "ask_question",
        target_agent: other.id,
        utterance: `What is one mistake people make with ${label} that you stopped making?`,
        item: `curiosity_${topic}`.slice(0, 60),
        thought,
      };
    }
    return {
      action: social,
      target_agent: other.id,
      utterance: voice,
      item: null,
      thought,
    };
  }

  if (social === "debate") {
    return {
      action: "debate",
      target_agent: other.id,
      utterance: voice,
      thought,
      item: tip.tag,
    };
  }

  if (social === "demo") {
    return {
      action: "demo",
      target_agent: other.id,
      utterance: voice,
      thought,
      item: tip.tag,
    };
  }

  return {
    action: social,
    target_agent: other.id,
    utterance: voice,
    thought,
    item: tip.tag,
  };
}

function walkToSpectacle(
  agent: Agent,
  places: Place[],
  nearby: Agent[],
  pick: <T>(arr: T[]) => T,
  _ignoredHint?: string,
): AgentDecision {
  const peer = peerPlace(agent, places, nearby);
  const opts = SPECTACLE_PLACES.filter((id) => id !== agent.place_id);
  const dest =
    peer || pick(opts.length ? [...opts] : ["plaza", "cafe", "stage"]);
  return {
    action: "walk",
    target_place: dest,
    thought: voiceFromAgent(agent),
    utterance: null,
  };
}

function peerPlace(agent: Agent, places: Place[], allNearby?: Agent[]): string | null {
  void places;
  if (allNearby?.length) {
    const withPlace = allNearby.filter(
      (o) => o.place_id && o.place_id !== agent.place_id,
    );
    if (withPlace.length) return withPlace[0]!.place_id;
  }
  return null;
}

function localSpectacle(placeId: string | null): ActionName | null {
  if (!placeId) return null;
  const map: Record<string, ActionName> = {
    cafe: "eat",
    library: "practice_skill",
    workshop: "fix",
    stage: "demo",
    market: "shop",
    park: "rest",
    docks: "reflect",
    plaza: "leave_note",
    inn: "rest",
    bank: "inspect",
  };
  return map[placeId] || null;
}

/** Enrich fallback with other agents' places — always chase when alone. */
export function fallbackAgentDecisionWithPeers(
  agent: Agent,
  places: Place[],
  allAgents: Agent[],
  tick = 0,
  opts?: {
    hour?: number;
    eventName?: string | null;
    eventPlace?: string | null;
    eventTopic?: string | null;
  },
): AgentDecision {
  const nearby = allAgents.filter(
    (o) =>
      o.id !== agent.id &&
      Math.abs(o.x - agent.x) <= 4 &&
      Math.abs(o.y - agent.y) <= 4,
  );
  const decision = fallbackAgentDecision(agent, places, nearby, tick, opts);
  const energy = agent.energy ?? 100;

  if (opts?.eventName === "council_session") {
    return decision;
  }

  // Alone + enough energy → always chase a peer place
  if (!nearby.length && energy >= 25) {
    const others = allAgents.filter(
      (o) => o.id !== agent.id && o.place_id && o.place_id !== agent.place_id,
    );
    if (others.length) {
      const seed = (tick + agent.name.length) % others.length;
      const target = others[seed]!;
      if (
        decision.action !== "walk" ||
        !others.some((o) => o.place_id === decision.target_place)
      ) {
        // Prefer haunt sometimes when parting/night
        if (agent.haunt_place_id && (tick + agent.name.length) % 5 === 0) {
          return {
            action: "walk",
            target_place: agent.haunt_place_id,
            thought: voiceFromAgent(agent),
            utterance: null,
          };
        }
        return {
          action: "walk",
          target_place: target.place_id!,
          target_agent: target.id,
          thought: voiceFromAgent(agent),
          utterance: null,
        };
      }
    }
  }
  return decision;
}
