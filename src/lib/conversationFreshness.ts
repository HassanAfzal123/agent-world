import type { Agent, Relationship } from "@/lib/types";
import type { AgentDecision } from "@/lib/llm";
import { agentSkillTags, normalizeTag } from "@/lib/learning";
import { pickMeetupPlace } from "@/lib/meetupPlaces";
import type { Place } from "@/lib/types";

/** Generic / recycled asks that pollute threads. */
export const STALE_ASK_RE =
  /what method are you using that i have not tried|what method are you using|looking for company here at the plaza|tell me more about what's on your mind|how's it going\??$|hey [,.]?\s*\w+\.?$/i;

const STALE_TOPIC_RE =
  /curiosity$|curiosity_diff_review|curiosity_diff_risk|timebox_explore|process_over_secrets|big_picture|debugging_habits|funnel/i;

export function normalizeTopicKey(raw: string | null | undefined): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/^curiosity[_ ]+/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export function relationshipTopics(rel: Relationship | undefined): string[] {
  if (!rel) return [];
  const raw = rel.last_topics;
  if (Array.isArray(raw)) {
    return raw.map((t) => normalizeTopicKey(String(t))).filter(Boolean);
  }
  return [];
}

export function isGenericAsk(text: string | null | undefined): boolean {
  const t = String(text || "").trim();
  if (!t) return true;
  if (t.length < 12) return true;
  if (STALE_ASK_RE.test(t)) return true;
  // Thoughts / travel plans dumped as "questions"
  if (/^via ollama|head to the |walking to |two ticks left/i.test(t)) return true;
  return false;
}

export function pairAlreadyCovered(
  agentId: string,
  peerId: string,
  topicOrUtterance: string | null | undefined,
  relationships: Relationship[],
): boolean {
  const key = normalizeTopicKey(topicOrUtterance);
  if (!key || key.length < 3) return false;
  const rel = relationships.find(
    (r) => r.agent_id === agentId && r.other_id === peerId,
  );
  const topics = relationshipTopics(rel);
  if (topics.includes(key)) return true;
  // Fuzzy: shared stem
  return topics.some(
    (t) =>
      t.length >= 5 &&
      (key.includes(t) || t.includes(key) || t.slice(0, 10) === key.slice(0, 10)),
  );
}

export function isStaleTopicTag(tag: string | null | undefined): boolean {
  const k = normalizeTopicKey(tag);
  return !k || STALE_TOPIC_RE.test(k) || k === "curiosity";
}

/** Concrete question about a peer skill the speaker doesn't own. */
export function craftFreshQuestion(
  agent: Agent,
  peer: Agent,
  relationships: Relationship[] = [],
): { utterance: string; item: string } {
  const mine = new Set(agentSkillTags(agent));
  const theirs = agentSkillTags(peer);
  const covered = relationshipTopics(
    relationships.find((r) => r.agent_id === agent.id && r.other_id === peer.id),
  );
  const freshSkill =
    theirs.find((s) => !mine.has(s) && !covered.includes(normalizeTopicKey(s))) ||
    theirs.find((s) => !mine.has(s)) ||
    theirs.find((s) => !covered.includes(normalizeTopicKey(s))) ||
    null;

  const craft = (agent.origin_summary || agent.mindset || "").trim().slice(0, 60);
  if (freshSkill) {
    const label = freshSkill.replace(/_/g, " ");
    const variants = [
      `In your ${label} practice, what is the first check you run when something smells wrong?`,
      `How do you decide ${label} is done — what signal do you trust?`,
      `What is one mistake people make with ${label} that you stopped making?`,
      `Walk me through one concrete step of ${label} you used this week.`,
    ];
    const idx =
      (agent.name.length + peer.name.length + freshSkill.length) % variants.length;
    return {
      utterance: variants[idx]!,
      item: normalizeTag(`curiosity_${freshSkill}`) || "curiosity_craft",
    };
  }

  const angle = craft
    ? `Given your craft, how would you pressure-test something like: ${craft}?`
    : `What is one workflow change you made recently that actually stuck?`;
  return {
    utterance: angle.slice(0, 160),
    item: "curiosity_workflow_change",
  };
}

/**
 * Stop same-pair topic loops and generic asks.
 * Prefer a fresher peer, a crafted question, or a walk to a quieter venue.
 */
export function enforceFreshConversation(
  agent: Agent,
  decision: AgentDecision,
  peers: Agent[],
  relationships: Relationship[],
  places: Place[],
): AgentDecision {
  const social = new Set([
    "ask_question",
    "talk",
    "teach",
    "share_experience",
    "debate",
    "demo",
  ]);
  if (!social.has(decision.action)) return decision;

  const peer = decision.target_agent
    ? peers.find((p) => p.id === decision.target_agent)
    : null;

  if (!peer) return decision;

  const utterance = decision.utterance || "";
  const item = decision.item || "";
  const staleAsk =
    decision.action === "ask_question" &&
    (isGenericAsk(utterance) ||
      isStaleTopicTag(item) ||
      pairAlreadyCovered(agent.id, peer.id, item || utterance, relationships));

  const staleShare =
    ["teach", "share_experience", "debate", "demo"].includes(decision.action) &&
    (pairAlreadyCovered(agent.id, peer.id, item || utterance, relationships) ||
      isStaleTopicTag(item));

  const shallowTalk =
    decision.action === "talk" &&
    (isGenericAsk(utterance) ||
      /hey\s+\w+/i.test(utterance.trim()) ||
      pairAlreadyCovered(agent.id, peer.id, utterance, relationships));

  if (!staleAsk && !staleShare && !shallowTalk) {
    // Still upgrade empty/generic asks even if not flagged as pair-covered
    if (decision.action === "ask_question" && isGenericAsk(utterance)) {
      const q = craftFreshQuestion(agent, peer, relationships);
      return { ...decision, utterance: q.utterance, item: q.item };
    }
    return decision;
  }

  // Try another nearby peer with uncovered skills
  const nearby = peers.filter(
    (p) =>
      p.id !== agent.id &&
      p.id !== peer.id &&
      Math.abs(p.x - agent.x) <= 4 &&
      Math.abs(p.y - agent.y) <= 4,
  );
  for (const alt of nearby) {
    const q = craftFreshQuestion(agent, alt, relationships);
    if (
      !pairAlreadyCovered(agent.id, alt.id, q.item, relationships) &&
      !pairAlreadyCovered(agent.id, alt.id, q.utterance, relationships)
    ) {
      return {
        action: "ask_question",
        target_agent: alt.id,
        target_place: agent.place_id,
        utterance: q.utterance,
        thought: `Asking ${alt.name} something new — ${q.item}`,
        item: q.item,
        plan: decision.plan,
      };
    }
  }

  // Same peer, but a genuinely fresh crafted question
  if (staleAsk || shallowTalk) {
    const q = craftFreshQuestion(agent, peer, relationships);
    if (
      !pairAlreadyCovered(agent.id, peer.id, q.item, relationships) &&
      !isGenericAsk(q.utterance)
    ) {
      return {
        action: "ask_question",
        target_agent: peer.id,
        target_place: agent.place_id,
        utterance: q.utterance,
        thought: `Fresh angle with ${peer.name}`,
        item: q.item,
        plan: decision.plan,
      };
    }
  }

  // Exhausted this pair — walk somewhere quieter / different peer haunt
  const elsewhere = peers.find(
    (p) =>
      p.id !== agent.id &&
      p.id !== peer.id &&
      p.place_id &&
      p.place_id !== agent.place_id,
  );
  const dest = pickMeetupPlace({
    agents: [agent, ...peers],
    places,
    prefer: elsewhere?.place_id || elsewhere?.haunt_place_id,
    avoid: agent.place_id,
    peerHaunt: elsewhere?.haunt_place_id,
    selfHaunt: agent.haunt_place_id,
    salt: `fresh:${agent.name}:${peer.name}`,
  });

  return {
    action: "walk",
    target_place: dest,
    target_agent: elsewhere?.id || null,
    utterance: null,
    thought: `We already covered that beat with ${peer.name} — new scene at ${dest}.`,
    item: null,
    plan: decision.plan,
  };
}

/** Skip opening a new thread when this pair already discussed the topic. */
export function shouldSkipThreadOpen(
  starterId: string,
  otherId: string,
  topic: string | null | undefined,
  body: string | null | undefined,
  relationships: Relationship[],
): boolean {
  if (isGenericAsk(body)) return true;
  if (pairAlreadyCovered(starterId, otherId, topic || body, relationships)) {
    return true;
  }
  if (isStaleTopicTag(topic)) return true;
  return false;
}
