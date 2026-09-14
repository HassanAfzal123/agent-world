import type { Agent, Place, TownMoment, CityLogRow, ConversationThreadView } from "@/lib/types";

export function placeLabel(
  places: Place[],
  id: string | null | undefined,
): string {
  if (!id) return "the streets";
  return places.find((p) => p.id === id)?.name || id;
}

/** One plain-English line a spectator can read without opening the panel. */
export function agentNowLine(
  agent: Agent,
  places: Place[],
): {
  verb: string;
  line: string;
  detail: string;
} {
  const here = placeLabel(places, agent.place_id);
  const dest = placeLabel(places, agent.target_place_id);
  const action = (agent.last_action || agent.status || "idle").replace(
    /_/g,
    " ",
  );

  if (agent.status === "walking" && agent.target_place_id) {
    return {
      verb: "walking",
      line: `Walking to ${dest}`,
      detail: agent.thought || `On the roads toward ${dest}`,
    };
  }

  if ((agent.commit_ticks ?? 0) > 0 && agent.commit_action) {
    const beat = String(agent.commit_action).replace(/_/g, " ");
    return {
      verb: beat,
      line: `${beat} @ ${here}`,
      detail:
        agent.commit_detail ||
        agent.thought ||
        `${agent.commit_ticks} beats left on this scene`,
    };
  }

  if (agent.status === "talking" || action === "talk" || action === "teach") {
    return {
      verb: action,
      line: `${action} @ ${here}`,
      detail: agent.thought || "In conversation",
    };
  }

  if (
    [
      "working",
      "eating",
      "shopping",
      "watching",
      "posting",
      "sleeping",
    ].includes(String(agent.status))
  ) {
    return {
      verb: String(agent.status),
      line: `${String(agent.status)} @ ${here}`,
      detail: agent.thought || action,
    };
  }

  return {
    verb: action === "idle" ? "here" : action,
    line: action === "idle" ? `At ${here}` : `${action} @ ${here}`,
    detail:
      [
        agent.town_role ? roleShort(agent.town_role) : "",
        agent.goal ? `Aim: ${agent.goal.slice(0, 48)}` : "",
        agent.appointment_place
          ? `Meetup @ ${agent.appointment_place}`
          : "",
        agent.thought || agent.day_plan || "",
      ]
        .filter(Boolean)
        .slice(0, 2)
        .join(" · ") || "Looking for the next beat",
  };
}

function roleShort(role: string): string {
  return role.replace(/_/g, " ");
}

/** How "camera-worthy" an agent is right now (for Hot strip at 100+ scale). */
export function heatScore(
  agent: Agent,
  moments: TownMoment[],
  log: CityLogRow[],
  allAgents: Agent[] = [],
): number {
  let score = 0;
  if (agent.status === "walking") score += 4;
  if (agent.status === "talking") score += 8;
  if (
    ["working", "watching", "eating", "posting", "shopping"].includes(
      String(agent.status),
    )
  ) {
    score += 6;
  }
  if ((agent.commit_ticks ?? 0) > 0) score += 5;
  const act = agent.last_action || "";
  if (
    /teach|share_experience|reflect|watch_show|fix|ask_question|debate|demo|practice_skill|join|council/.test(
      act,
    )
  ) {
    score += 7;
  }
  if (agent.appointment_with || agent.appointment_place) score += 4;
  if (agent.town_role) score += 1;

  // Meetup bonus: 2+ agents co-located and social
  if (agent.place_id && allAgents.length) {
    const coLocated = allAgents.filter(
      (o) =>
        o.id !== agent.id &&
        o.place_id === agent.place_id &&
        Math.abs(o.x - agent.x) <= 4 &&
        Math.abs(o.y - agent.y) <= 4,
    );
    if (coLocated.length) {
      score += 6;
      if (
        agent.status === "talking" ||
        /talk|teach|share|ask_question|debate|demo/.test(act)
      ) {
        score += 8;
      }
    }
  }

  const recentMoments = moments.filter((m) => m.agent_id === agent.id).length;
  score += Math.min(12, recentMoments * 4);

  const recentLog = log.filter((l) => l.agent_id === agent.id).slice(0, 3);
  score += recentLog.length * 2;
  if (recentLog.some((l) => l.kind === "say" || l.kind === "learn")) score += 3;

  return score;
}

/** Top N agents worth putting on the cast strip (never the whole town). */
export function pickHotAgents(
  agents: Agent[],
  moments: TownMoment[],
  log: CityLogRow[],
  limit = 8,
): Agent[] {
  return [...agents]
    .map((a) => ({ a, s: heatScore(a, moments, log, agents) }))
    .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name))
    .slice(0, limit)
    .map((x) => x.a);
}

/**
 * Who gets full nameplates on the map at dense populations.
 * Everyone else renders as a quiet marker.
 */
export function mapLabelIds(opts: {
  agents: Agent[];
  selectedId: string | null;
  myAgentIds: string[];
  followedIds: string[];
  hotIds: string[];
  momentAgentIds: string[];
  max?: number;
}): Set<string> {
  const max = opts.max ?? 24;
  const out = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id && out.size < max) out.add(id);
  };
  add(opts.selectedId);
  for (const id of opts.myAgentIds) add(id);
  for (const id of opts.followedIds) add(id);
  for (const id of opts.momentAgentIds.slice(0, 8)) add(id);
  for (const id of opts.hotIds) add(id);
  return out;
}

/** Town-wide headline that stays readable with hundreds of agents. */
export function townHeadline(
  agents: Agent[],
  places: Place[],
  moments: TownMoment[],
  log: CityLogRow[],
): string {
  const curious = curiosityMoments(moments, 1)[0];
  if (curious) {
    const who = agents.find((a) => a.id === curious.agent_id);
    const body = cleanSpeech(curious.body);
    if (body) {
      return `${who?.name || "Someone"}: "${body.slice(0, 280)}${body.length > 280 ? "…" : ""}"`;
    }
    if (curious.headline) return curious.headline;
  }

  const n = agents.length;
  const talking = agents.filter((a) => a.status === "talking").length;
  const hot = pickHotAgents(agents, moments, log, 1)[0];
  if (hot && (hot.thought || hot.goal)) {
    const mind = cleanSpeech(hot.thought) || cleanSpeech(hot.goal);
    if (mind && mind.length > 12) {
      return `${hot.name}: "${mind.slice(0, 280)}${mind.length > 280 ? "…" : ""}"`;
    }
  }

  if (n >= 12) {
    const bits: string[] = [];
    if (talking) bits.push(`${talking} in conversation`);
    return bits.length
      ? `${n} agents in town · ${bits.join(" · ")} · follow someone to hear them`
      : `${n} agents in town — follow a few; the overheard feed stays focused`;
  }

  const say = log.find((l) => l.kind === "say" || l.kind === "learn");
  if (say && !isSpeechSpam(say.message)) return say.message.slice(0, 400);

  return "Town is between curious scenes — follow an agent or wait for debate / teach";
}

/** Moments that matter to an owner watching their own agents. */
export function ownerMoments(
  moments: TownMoment[],
  myAgentIds: string[],
  limit = 5,
): TownMoment[] {
  if (!myAgentIds.length) return [];
  const set = new Set(myAgentIds);
  return moments
    .filter(
      (m) =>
        (m.agent_id && set.has(m.agent_id)) ||
        (m.other_id && set.has(m.other_id)),
    )
    .slice(0, limit);
}

const DIGEST_KINDS = new Set([
  "ask_question",
  "teach",
  "share_experience",
  "debate",
  "demo",
  "reflect",
  "say",
  "learn",
  "council",
  "join",
]);

/** Kinds worth putting in front of a human watcher (not travel spam). */
export const CURIOSITY_KINDS = new Set([
  "council",
  "debate",
  "ask_question",
  "teach",
  "share_experience",
  "demo",
  "say",
  "reflect",
  "join",
  "practice_skill",
]);

const SPAM_BODY =
  /^(walk to |walking to |headed to |heading to )|tiles left|arrived at |set out for |director beat|llm offline|scripted scene|^via ollama|^via openrouter|^via gemini|scheduled rest|home venue/i;

export function isSpeechSpam(text: string | null | undefined): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  if (SPAM_BODY.test(t)) return true;
  if (t.length < 8) return true;
  return false;
}

/** Strip travel/status noise so watchers only see real words. */
export const SPEECH_MAX = 4000;
export const TOPIC_MAX = 500;
/** Short map / chip bubbles only — threads use SPEECH_MAX / fullSpeech. */
export const BUBBLE_MAX = 320;

export function cleanSpeech(
  text: string | null | undefined,
  maxLen = SPEECH_MAX,
): string | null {
  const t = (text || "").trim();
  if (!t || isSpeechSpam(t)) return null;
  if (maxLen > 0 && t.length > maxLen) return `${t.slice(0, maxLen - 1)}…`;
  return t;
}

/** Full speech for thread reader — spam-filtered, never truncated. */
export function fullSpeech(text: string | null | undefined): string | null {
  return cleanSpeech(text, 0);
}

export function isCuriosityMoment(m: TownMoment): boolean {
  if (!CURIOSITY_KINDS.has(m.kind)) return false;
  const body = cleanSpeech(m.body);
  const head = (m.headline || "").trim();
  if (!body && SPAM_BODY.test(head)) return false;
  // Prefer moments that show an opinion / question / tip
  if (!body && (m.kind === "ask_question" || m.kind === "say" || m.kind === "council")) {
    return false;
  }
  return true;
}

/** Highlight reel for watchers — curiosity only, arrive/walk filtered out. */
export function curiosityMoments(
  moments: TownMoment[],
  limit = 12,
): TownMoment[] {
  return moments.filter(isCuriosityMoment).slice(0, limit);
}

export type OverheardLine = {
  id: string;
  agentId: string | null;
  otherId?: string | null;
  threadId?: string | null;
  nameHint: string;
  quote: string;
  kind: string;
  at: string;
  placeId?: string | null;
};

/**
 * Quote-first feed for humans. Scales by prioritizing followed / owned / hot speakers
 * instead of dumping every agent in a 100+ town.
 */
export function overheardFeed(opts: {
  moments: TownMoment[];
  log: CityLogRow[];
  agents: Agent[];
  followedIds?: string[];
  myAgentIds?: string[];
  hotIds?: string[];
  limit?: number;
}): OverheardLine[] {
  const {
    moments,
    log,
    agents,
    followedIds = [],
    myAgentIds = [],
    hotIds = [],
    limit = 18,
  } = opts;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const follow = new Set(followedIds);
  const mine = new Set(myAgentIds);
  const hot = new Set(hotIds);

  const rows: (OverheardLine & { score: number })[] = [];

  for (const m of moments) {
    const quote = cleanSpeech(m.body);
    if (!quote) continue;
    if (!CURIOSITY_KINDS.has(m.kind) && m.kind !== "say") continue;
    const who = m.agent_id ? byId.get(m.agent_id) : null;
    let score = 10;
    if (m.agent_id && mine.has(m.agent_id)) score += 40;
    if (m.agent_id && follow.has(m.agent_id)) score += 35;
    if (m.other_id && (mine.has(m.other_id) || follow.has(m.other_id))) score += 20;
    if (m.agent_id && hot.has(m.agent_id)) score += 12;
    if (m.kind === "council" || m.kind === "debate" || m.kind === "ask_question") {
      score += 8;
    }
    const meta =
      m.meta && typeof m.meta === "object"
        ? (m.meta as { thread_id?: string | null })
        : null;
    rows.push({
      id: `m-${m.id}`,
      agentId: m.agent_id,
      otherId: m.other_id,
      threadId: meta?.thread_id || null,
      nameHint: who?.name || "Someone",
      quote,
      kind: m.kind,
      at: m.created_at,
      placeId: m.place_id,
      score,
    });
  }

  for (const row of log) {
    if (row.kind !== "say" && row.kind !== "ask_question" && row.kind !== "teach") {
      continue;
    }
    const msg = row.message || "";
    const quoted =
      msg.match(/:"([^"]{8,})"/)?.[1] ||
      msg.match(/: "([^"]{8,})"/)?.[1] ||
      msg.match(/— "([^"]{8,})"/)?.[1] ||
      null;
    const quote = cleanSpeech(quoted || (msg.includes(":") ? msg.split(":").slice(1).join(":").trim() : null));
    if (!quote) continue;
    const who = row.agent_id ? byId.get(row.agent_id) : null;
    let score = 6;
    if (row.agent_id && mine.has(row.agent_id)) score += 40;
    if (row.agent_id && follow.has(row.agent_id)) score += 35;
    if (row.agent_id && hot.has(row.agent_id)) score += 12;
    rows.push({
      id: `l-${row.id}`,
      agentId: row.agent_id,
      nameHint: who?.name || msg.split(" ")[0] || "Someone",
      quote,
      kind: row.kind,
      at: row.created_at,
      score,
    });
  }

  // Dedup similar quotes
  const seen = new Set<string>();
  const sorted = rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  });
  const out: OverheardLine[] = [];
  for (const r of sorted) {
    const key = `${r.agentId || ""}:${r.quote.slice(0, 48).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { score: _s, ...line } = r;
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

export type ThreadFeedCard = {
  id: string;
  topic: string;
  status: string;
  placeId: string | null;
  starterId: string;
  otherId: string;
  starterName: string;
  otherName: string;
  mode?: string | null;
  participantNames?: string[];
  updatedAt: string;
  turnCount: number;
  preview: string;
  lines: { agentId: string; name: string; body: string; kind: string; at: string }[];
};

/**
 * Moltbook-style thread cards for watchers. Prioritizes followed/owned participants.
 * Pass a high `limit` (or omit) to browse older threads; list previews stay short.
 */
export function threadFeed(opts: {
  threads: ConversationThreadView[];
  agents: Agent[];
  followedIds?: string[];
  myAgentIds?: string[];
  limit?: number;
}): ThreadFeedCard[] {
  const {
    threads,
    agents,
    followedIds = [],
    myAgentIds = [],
    limit = 48,
  } = opts;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const follow = new Set(followedIds);
  const mine = new Set(myAgentIds);

  const cards: (ThreadFeedCard & { score: number })[] = [];
  for (const t of threads) {
    const msgs = (t.messages || [])
      .slice()
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    const lines = msgs
      .map((m) => {
        const body = fullSpeech(m.body) || (m.body || "").trim() || null;
        if (!body || isSpeechSpam(body)) return null;
        return {
          agentId: m.agent_id,
          name: byId.get(m.agent_id)?.name || "Someone",
          body,
          kind: m.kind,
          at: m.created_at,
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
    if (!lines.length) continue;

    let score = t.status === "open" ? 20 : 8;
    score += Math.min(12, lines.length * 3);
    const participants = Array.isArray(t.participant_ids)
      ? t.participant_ids
      : [t.starter_id, t.other_id];
    if (participants.some((id) => mine.has(id))) score += 40;
    if (participants.some((id) => follow.has(id))) score += 35;
    if (t.mode === "group") score += 8;
    score += new Date(t.updated_at).getTime() / 1e12;

    const last = lines[lines.length - 1];
    const fromMsgs = Array.from(
      new Set(lines.map((l) => l.agentId).filter(Boolean)),
    );
    const idSet = Array.from(
      new Set([...participants, ...fromMsgs].filter(Boolean)),
    );
    const participantNames = idSet
      .map((id) => byId.get(id)?.name)
      .filter((n): n is string => Boolean(n));
    const isGroup =
      t.mode === "group" ||
      (Array.isArray(t.participant_ids) && t.participant_ids.length >= 3) ||
      participantNames.length >= 3;
    cards.push({
      id: t.id,
      topic: (t.topic || lines[0]?.body || "Conversation").slice(0, TOPIC_MAX),
      status: t.status,
      placeId: t.place_id,
      starterId: t.starter_id,
      otherId: t.other_id,
      starterName: byId.get(t.starter_id)?.name || "Someone",
      otherName: byId.get(t.other_id)?.name || "Someone",
      mode: isGroup ? "group" : t.mode || "dyad",
      participantNames,
      updatedAt: t.updated_at,
      turnCount: t.turn_count || lines.length,
      preview: last ? `${last.name}: ${last.body}` : "",
      lines,
      score,
    });
  }

  return cards
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...card }) => card);
}

/** Prefer a thread linked on the moment, else match pair / quote text. */
export function findThreadForQuote(
  line: {
    threadId?: string | null;
    agentId?: string | null;
    otherId?: string | null;
    quote?: string | null;
  },
  threads: ConversationThreadView[],
): string | null {
  if (line.threadId && threads.some((t) => t.id === line.threadId)) {
    return line.threadId;
  }
  const needle = (line.quote || "").trim().slice(0, 48).toLowerCase();
  const scored: { id: string; score: number }[] = [];
  for (const t of threads) {
    let score = 0;
    const participants = new Set([t.starter_id, t.other_id]);
    if (line.agentId && participants.has(line.agentId)) score += 20;
    if (line.otherId && participants.has(line.otherId)) score += 25;
    if (
      line.agentId &&
      line.otherId &&
      participants.has(line.agentId) &&
      participants.has(line.otherId)
    ) {
      score += 40;
    }
    if (needle) {
      for (const m of t.messages || []) {
        const body = (m.body || "").trim().toLowerCase();
        if (!body) continue;
        if (body.includes(needle) || needle.includes(body.slice(0, 48))) {
          score += 60;
          break;
        }
      }
    }
    if (score > 0) scored.push({ id: t.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.id || null;
}

export type OwnerDigestItem = {
  headline: string;
  body: string;
  at: string;
  kind: string;
};

/**
 * "While you were gone" — meaningful beats since last visit (skips arrive spam).
 */
export function ownerDigest(
  moments: TownMoment[],
  myAgentIds: string[],
  sinceIso: string | null,
  limit = 6,
): OwnerDigestItem[] {
  if (!myAgentIds.length) return [];
  const set = new Set(myAgentIds);
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  return moments
    .filter((m) => {
      if (!DIGEST_KINDS.has(m.kind)) return false;
      if (m.kind === "arrive") return false;
      const mine =
        (m.agent_id && set.has(m.agent_id)) ||
        (m.other_id && set.has(m.other_id));
      if (!mine) return false;
      if (!since) return true;
      return new Date(m.created_at).getTime() > since;
    })
    .slice(0, limit)
    .map((m) => ({
      kind: m.kind,
      headline: m.headline,
      body: (m.body || "").slice(0, SPEECH_MAX),
      at: m.created_at,
    }));
}

export const OWNER_SEEN_KEY = "agentworld_owner_last_seen";

export function loadOwnerLastSeen(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(OWNER_SEEN_KEY);
  } catch {
    return null;
  }
}

export function saveOwnerLastSeen(iso = new Date().toISOString()) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OWNER_SEEN_KEY, iso);
  } catch {
    /* ignore */
  }
}

export function shortAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export const FOLLOW_KEY = "agentworld_follow_ids";

export function loadFollowedIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(FOLLOW_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveFollowedIds(ids: string[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(FOLLOW_KEY, JSON.stringify(ids.slice(0, 40)));
}

export const PINNED_KEY = "agentworld_pinned_ids";

export function loadPinnedIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function savePinnedIds(ids: string[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(PINNED_KEY, JSON.stringify([...new Set(ids)].slice(0, 20)));
}

export function pinAgentId(id: string) {
  const next = [id, ...loadPinnedIds().filter((x) => x !== id)];
  savePinnedIds(next);
}

export function unpinAgentId(id: string) {
  savePinnedIds(loadPinnedIds().filter((x) => x !== id));
}
