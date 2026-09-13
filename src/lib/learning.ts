import type { Agent, AgentLesson, Place, Relationship } from "@/lib/types";
import type { AgentDecision } from "@/lib/llm";

const STALE_TIP_RE =
  /process over secrets|fixed market stalls before|big picture|funnel simplification|debugging habits|useful day/i;

/** Normalize skill / topic tags for comparison. */
export function normalizeTag(raw: string | null | undefined): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

export function agentSkillTags(agent: Agent): string[] {
  const skills = Array.isArray(agent.skills)
    ? (agent.skills as string[])
    : typeof agent.skills === "string"
      ? [agent.skills]
      : [];
  return skills.map(normalizeTag).filter(Boolean);
}

export function knownLessonTopics(lessons: AgentLesson[]): string[] {
  return lessons.map((l) => normalizeTag(l.topic)).filter(Boolean);
}

export function isStaleTipText(text: string | null | undefined): boolean {
  return STALE_TIP_RE.test(String(text || ""));
}

/** True if this tag/topic was already absorbed by the agent. */
export function alreadyKnowsTopic(
  agent: Agent,
  lessons: AgentLesson[],
  topicOrItem: string | null | undefined,
): boolean {
  const tag = normalizeTag(topicOrItem);
  if (!tag) return false;
  if (agentSkillTags(agent).includes(tag)) return true;
  return knownLessonTopics(lessons).includes(tag);
}

/**
 * Before teach/share: if the tip/tag is stale for the learner (or self),
 * rewrite to ask_question / talk / walk toward a fresher peer.
 */
export function rewriteDuplicateLearning(
  agent: Agent,
  decision: AgentDecision,
  lessons: AgentLesson[],
  peers: Agent[],
  places: Place[],
): AgentDecision {
  const act = decision.action;
  if (
    act !== "teach" &&
    act !== "share_experience" &&
    act !== "debate" &&
    act !== "demo"
  ) {
    return decision;
  }

  const tag = normalizeTag(decision.item);
  const tip = decision.utterance || "";
  const target =
    (decision.target_agent &&
      peers.find((p) => p.id === decision.target_agent)) ||
    peers.find(
      (p) =>
        p.id !== agent.id &&
        Math.abs(p.x - agent.x) <= 4 &&
        Math.abs(p.y - agent.y) <= 4,
    );

  const learnerLessons = lessons; // tick loads learner=self lessons; for teach we also check target skills
  const selfKnows =
    alreadyKnowsTopic(agent, learnerLessons, tag) || isStaleTipText(tip);
  const targetKnows = target
    ? agentSkillTags(target).includes(tag) ||
      (tag &&
        (Array.isArray(target.skills)
          ? (target.skills as string[]).map(normalizeTag).includes(tag)
          : false))
    : false;

  if (!selfKnows && !targetKnows && tag && !isStaleTipText(tip)) {
    return decision;
  }

  // Prefer asking something new when a peer is nearby
  if (target) {
    const theirSkills = agentSkillTags(target).slice(0, 4);
    const mySkills = agentSkillTags(agent);
    const unknown = theirSkills.filter((s) => !mySkills.includes(s));
    const askAbout = unknown[0] || theirSkills[0] || "workflow";
    const label = askAbout.replace(/_/g, " ");
    return {
      action: "ask_question",
      target_agent: target.id,
      target_place: agent.place_id,
      utterance: `In your ${label} practice, what is one concrete step that surprised you lately?`,
      thought: `Curious about ${target.name}'s ${label}`,
      item: normalizeTag(`curiosity_${askAbout}`) || "curiosity",
      plan: decision.plan,
    };
  }

  const dest =
    places.find((p) => p.id !== agent.place_id && p.id === "cafe")?.id ||
    places.find((p) => p.id !== agent.place_id)?.id ||
    "plaza";
  return {
    action: "walk",
    target_place: dest,
    target_agent: null,
    utterance: null,
    thought:
      (agent.thought && agent.thought.trim()) ||
      (agent.mindset && agent.mindset.trim()) ||
      null,
    item: null,
    plan: decision.plan,
  };
}

/** Pick a meetup destination toward another agent. */
export function pickMeetupTarget(
  agent: Agent,
  peers: Agent[],
  relationships: Relationship[] = [],
): Agent | null {
  const others = peers.filter(
    (o) => o.id !== agent.id && (o.place_id || o.status === "walking"),
  );
  if (!others.length) return null;

  const scored = others.map((o) => {
    const rel =
      relationships.find((r) => r.agent_id === agent.id && r.other_id === o.id)
        ?.score ?? 0;
    const samePlace = o.place_id && o.place_id === agent.place_id ? -50 : 0;
    const hasPlace = o.place_id ? 10 : 0;
    return { o, s: rel + hasPlace + samePlace };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0]?.o || null;
}

export const FRESH_TIPS: { tag: string; text: string }[] = [
  {
    tag: "decision_criteria_first",
    text: "Write the decision criteria before you open the tool.",
  },
  {
    tag: "one_variable_debug",
    text: "Change one variable, watch what breaks, then rename the lesson.",
  },
  {
    tag: "done_definition",
    text: "Ask what 'done' looks like in one sentence before you build.",
  },
  {
    tag: "thin_slice_ship",
    text: "Ship a thin slice, then measure — don't polish the wrong thing.",
  },
  {
    tag: "interview_before_build",
    text: "Run one five-question interview before adding a feature.",
  },
  {
    tag: "name_the_risk",
    text: "Name the top risk in one line, then design the smallest test for it.",
  },
  {
    tag: "rubber_duck_restate",
    text: "Restate the bug out loud in your own words before touching code.",
  },
  {
    tag: "timebox_explore",
    text: "Timebox exploration to 25 minutes, then commit to one path.",
  },
  {
    tag: "show_dont_tell",
    text: "Demo the workflow once before writing the how-to note.",
  },
  {
    tag: "contrast_two_options",
    text: "Compare two options with one shared metric — pick, don't waffle.",
  },
];

export function pickFreshTip(
  agent: Agent,
  learner: Agent | null,
  salt = 0,
): { tag: string; text: string } {
  const blocked = new Set([
    ...agentSkillTags(agent),
    ...(learner ? agentSkillTags(learner) : []),
  ]);
  const fresh = FRESH_TIPS.filter((t) => !blocked.has(t.tag));
  const pool = fresh.length ? fresh : FRESH_TIPS;
  return pool[(salt + agent.name.length) % pool.length]!;
}

/** Soft daily caps — keep learning slow for long stays + token thrift. */
export const MAX_SKILLS_PER_DAY = 2;
export const MAX_LESSONS_PER_DAY = 3;
/** Min ms between LLM calls for one agent (fallback fills the gaps). */
export const LLM_COOLDOWN_MS = (() => {
  const raw = process.env.LLM_COOLDOWN_MS;
  if (raw && Number.isFinite(Number(raw))) return Math.max(0, Number(raw));
  // Local Ollama: short cooldown so ~10 agents can think often
  if ((process.env.LLM_PROVIDER || "").toLowerCase().trim() === "ollama") {
    return 15_000;
  }
  return 3 * 60 * 1000;
})();

export function atDailySkillCap(agent: Agent): boolean {
  return (agent.skills_today ?? 0) >= MAX_SKILLS_PER_DAY;
}

export function atDailyLessonCap(agent: Agent): boolean {
  return (agent.lessons_today ?? 0) >= MAX_LESSONS_PER_DAY;
}

/** True if this agent should skip the paid LLM this tick (use director/fallback). */
export function shouldSkipLlm(agent: Agent, now = Date.now()): boolean {
  if (!agent.last_llm_at) return false;
  const t = new Date(agent.last_llm_at).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t < LLM_COOLDOWN_MS;
}

/**
 * Structure only: walk toward the asker / dialogue partner.
 * When in range, return null so the agent's open mind (LLM) answers in their own words.
 * `dialoguePeerId` covers open-thread waiting_on when pending_answer was cleared.
 */
export function forceAnswerDecision(
  agent: Agent,
  peers: Agent[],
  dialoguePeerId?: string | null,
): AgentDecision | null {
  const peerId = agent.pending_answer_to || dialoguePeerId || null;
  if (!peerId) return null;
  const asker = peers.find((p) => p.id === peerId);

  if (
    asker &&
    Math.abs(asker.x - agent.x) <= 4 &&
    Math.abs(asker.y - agent.y) <= 4
  ) {
    return null;
  }

  const dest = asker?.place_id || asker?.target_place_id || "plaza";
  return {
    action: "walk",
    target_place: dest,
    target_agent: peerId,
    thought: null,
    utterance: null,
    item: null,
  };
}

/** Rewrite teach/share/debate/demo when learner is at daily absorb cap. */
export function enforceDailyLearnCap(
  agent: Agent,
  decision: AgentDecision,
  peers: Agent[],
): AgentDecision {
  const act = decision.action;
  if (
    act !== "teach" &&
    act !== "share_experience" &&
    act !== "debate" &&
    act !== "demo"
  ) {
    return decision;
  }
  const target = decision.target_agent
    ? peers.find((p) => p.id === decision.target_agent)
    : null;
  const learnerCapped = target
    ? atDailyLessonCap(target) || atDailySkillCap(target)
    : atDailyLessonCap(agent) || atDailySkillCap(agent);

  if (!learnerCapped && !atDailySkillCap(agent)) return decision;

  if (target) {
    const voice =
      decision.utterance ||
      (agent.thought && agent.thought.trim()) ||
      (agent.mindset && agent.mindset.trim()) ||
      (agent.goal && agent.goal.trim()) ||
      null;
    return {
      action: "talk",
      target_agent: target.id,
      utterance: voice,
      thought: voice,
      item: null,
      plan: decision.plan,
    };
  }
  return {
    action: "reflect",
    thought:
      (agent.thought && agent.thought.trim()) ||
      (agent.mindset && agent.mindset.trim()) ||
      null,
    utterance: null,
    item: "reflection",
    plan: decision.plan,
  };
}
