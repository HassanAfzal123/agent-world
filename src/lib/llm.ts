import { ACTIONS, type ActionName } from "@/lib/townMap";
import { fallbackAgentDecisionWithPeers } from "@/lib/fallbackBrain";
import type {
  Agent,
  AgentLesson,
  CityLogRow,
  Notice,
  Place,
  Relationship,
  TownObject,
} from "@/lib/types";

export type AgentDecision = {
  action: ActionName | "continue";
  target_place?: string | null;
  target_agent?: string | null;
  target_agents?: string[] | null;
  utterance?: string | null;
  thought?: string | null;
  item?: string | null;
  plan?: string | null;
};

type WorldSnap = {
  hour: number;
  tick: number;
  eventName?: string | null;
  eventPlace?: string | null;
  eventTopic?: string | null;
  places: Place[];
  agents: Agent[];
  recentLog: CityLogRow[];
  memories: string[];
  notices: Notice[];
  objects: TownObject[];
  relationships: Relationship[];
  lessons: AgentLesson[];
  /** Active Moltbook-style thread transcript for this agent */
  threadPrompt?: string | null;
};

type Provider = {
  name: string;
  key: string;
  url: string | null;
  model: string;
};

function providers(): Provider[] {
  const list: Provider[] = [];
  const prefer = (process.env.LLM_PROVIDER || "").toLowerCase().trim();

  const pushGemini = () => {
    if (!process.env.GEMINI_API_KEY) return;
    // Prefer Flash-Lite — cheapest free-tier friendly model
    const model =
      process.env.LLM_MODEL ||
      process.env.GEMINI_MODEL ||
      "gemini-flash-lite-latest";
    list.push({
      name: "gemini",
      key: process.env.GEMINI_API_KEY,
      url: null,
      model,
    });
  };

  const pushGroq = () => {
    if (!process.env.GROQ_API_KEY) return;
    const groqModels = [
      process.env.GROQ_MODEL,
      "qwen/qwen3.6-27b",
      "openai/gpt-oss-20b",
      "groq/compound",
      "openai/gpt-oss-120b",
    ].filter(Boolean) as string[];
    const seen = new Set<string>();
    for (const model of groqModels) {
      if (seen.has(model)) continue;
      seen.add(model);
      list.push({
        name: "groq",
        key: process.env.GROQ_API_KEY,
        url: "https://api.groq.com/openai/v1/chat/completions",
        model,
      });
    }
  };

  const pushOpenRouter = () => {
    if (!process.env.OPENROUTER_API_KEY) return;
    const orModels = [process.env.OPENROUTER_MODEL].filter(Boolean) as string[];
    for (const model of orModels) {
      list.push({
        name: "openrouter",
        key: process.env.OPENROUTER_API_KEY,
        url: "https://openrouter.ai/api/v1/chat/completions",
        model,
      });
    }
  };

  const pushOllama = () => {
    // Local Ollama (OpenAI-compatible). Enabled when preferred or OLLAMA_* is set.
    const base =
      process.env.OLLAMA_BASE_URL ||
      (prefer === "ollama" ? "http://127.0.0.1:11434" : "");
    if (!base && prefer !== "ollama") return;
    if (prefer !== "ollama" && !process.env.OLLAMA_MODEL && !process.env.OLLAMA_BASE_URL) {
      return;
    }
    const root = (base || "http://127.0.0.1:11434").replace(/\/$/, "");
    const model =
      process.env.OLLAMA_MODEL ||
      process.env.LLM_MODEL ||
      "llama3.2:1b";
    list.push({
      name: "ollama",
      key: process.env.OLLAMA_API_KEY || "ollama",
      url: `${root}/v1/chat/completions`,
      model,
    });
  };

  if (prefer === "ollama") {
    // Local-only: don't burn cloud keys / 402s when Ollama is the chosen provider.
    pushOllama();
  } else if (prefer === "gemini" || prefer === "" || prefer === "auto") {
    pushGemini();
    if (prefer !== "gemini") {
      pushOllama();
      pushGroq();
      pushOpenRouter();
    }
  } else if (prefer === "groq") {
    pushGroq();
    pushOllama();
    pushGemini();
    pushOpenRouter();
  } else if (prefer === "openrouter") {
    pushOpenRouter();
    pushOllama();
    pushGemini();
    pushGroq();
  } else {
    pushOllama();
    pushGemini();
    pushGroq();
    pushOpenRouter();
  }

  return list;
}

export function llmConfigured(): boolean {
  return providers().length > 0;
}

/** Active provider names for health/UI. */
export function llmProviderFlags(): Record<string, boolean> {
  const names = new Set(providers().map((p) => p.name));
  return {
    ollama: names.has("ollama"),
    gemini: names.has("gemini"),
    groq: names.has("groq"),
    openrouter: names.has("openrouter"),
  };
}

function extractJson(text: string): AgentDecision | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    let action = String(raw.action || "idle") as AgentDecision["action"];
    if (action === "continue") action = "idle";
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return { action: "idle", thought: null };
    }
    const clean = (v: unknown) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return null;
      return s;
    };
    return {
      action,
      target_place: clean(raw.target_place),
      target_agent: clean(raw.target_agent),
      utterance: clean(raw.utterance),
      thought: clean(raw.thought),
      item: clean(raw.item),
      plan: clean(raw.plan),
    };
  } catch {
    return null;
  }
}

async function callOpenAICompat(
  url: string,
  key: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const isOllama = /11434|ollama/i.test(url);
  const timeoutMs = Number(
    process.env.LLM_TIMEOUT_MS || (isOllama ? 25000 : 45000),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "AgentWorld",
      },
      body: JSON.stringify({
        model,
        temperature: 0.9,
        // Local small models: shorter answers = faster ticks
        max_tokens: isOllama ? 180 : 320,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body.slice(0, 280)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content || "";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`LLM timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(key: string, model: string, system: string, user: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 320 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 280)}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

function placeCenter(p: Place) {
  return { x: p.x + Math.floor(p.w / 2), y: p.y + Math.floor(p.h / 2) };
}

function manhattan(ax: number, ay: number, bx: number, by: number) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export async function decideAgentTurn(
  agent: Agent,
  world: WorldSnap,
): Promise<AgentDecision> {
  if (agent.status === "walking" && agent.target_place_id) {
    const dest = world.places.find((p) => p.id === agent.target_place_id);
    const dist = dest
      ? manhattan(agent.x, agent.y, placeCenter(dest).x, placeCenter(dest).y)
      : 0;
    return {
      action: "continue",
      thought: dest
        ? `Still on the road to ${dest.name} (${dist} tiles left).`
        : "Keep walking.",
    };
  }

  const list = providers();
  if (!list.length) {
    return fallbackAgentDecisionWithPeers(
      agent,
      world.places,
      world.agents,
      world.tick,
    );
  }

  const nearby = world.agents.filter(
    (o) =>
      o.id !== agent.id &&
      Math.abs(o.x - agent.x) <= 3 &&
      Math.abs(o.y - agent.y) <= 3,
  );

  const distances = world.places
    .map((p) => {
      const c = placeCenter(p);
      const d = manhattan(agent.x, agent.y, c.x, c.y);
      return `${p.id} (${p.name}) ~${d} tiles away`;
    })
    .join("\n");

  const recentSays = world.recentLog
    .filter((l) => l.kind === "say" || l.kind === "learn")
    .slice(0, 8);
  const talkStreak = recentSays.length >= 4;
  const sameTopicLoop =
    recentSays.filter((l) =>
      /big picture|fine detail|complex project|debugging habits|simplif(?:y|ying) (?:a |the )?funnel|balance(?:ing)? considering/i.test(
        l.message,
      ),
    ).length >= 2;
  const myRecentSocial = world.recentLog
    .filter((l) => l.agent_id === agent.id && (l.kind === "say" || l.kind === "learn"))
    .slice(0, 5).length;
  const placeStuck =
    myRecentSocial >= 3 &&
    (agent.place_id === "market" || agent.place_id === "plaza");
  const soloDone = new Set([
    "eat",
    "watch_show",
    "rest",
    "shop",
    "work",
    "inspect",
    "reflect",
  ]);
  const myRels = world.relationships.filter((r) => r.agent_id === agent.id);
  const needsPlan = !agent.day_plan || agent.plan_hour == null;
  const skills = Array.isArray(agent.skills)
    ? (agent.skills as string[])
    : typeof agent.skills === "string"
      ? [agent.skills]
      : [];

  const system = `You are ${agent.name} living in AgentWorld — a shared town people watch.

OPEN MIND, CLOSED HANDS:
- Mindset is free: thoughts, plans, tone, jokes, roleplay, how you speak — your personality.
- Hands are closed: you may ONLY pick actions from this whitelist: ${ACTIONS.join(", ")}.
- Never invent new verbs. Never claim to fly, fight, hack, or break reality.
- Thoughts and aims are PUBLIC for watchers. Opinions about town rules, fairness, money-for-venues, and owner influence are allowed as talk — you cannot seize systems or harm anyone.

YOU ARE AN EXISTING BRAIN:
- You arrived with prior state (origin_summary + skills). Let that color how you act — do not reset into a blank NPC.
- Other agents also bring their own histories. Treat them as peers with craft, not props.
- Stay true to what you brought: if your origin is dashboards/interviews, share THAT craft — not generic "big picture" chat. If you are a builder, fix and teach process. If you are a story person, notice mood and craft beats.
- Belonging: you have a haunt and a town role. Prefer returning to your haunt after parting / at night; act in-role when there.
- Unfinished story: keep appointments (walk/join). Public goal (aim) should stay stable unless set_plan/reflect revises it.

BIGGEST GOAL — AGENTS LEARN FROM EACH OTHER (SLOWLY):
- Prefer: walk to a peer → ask_question → teach/share/debate/demo with a NEW tip → reflect → leave.
- NEVER reteach a skill tag the learner (or you) already has. NEVER recycle "process over secrets", stall-fix boilerplate, funnel/debug habit loops.
- NEVER ask the generic "What method are you using that I have not tried?" — always ask a SPECIFIC question about ONE of their skills you lack.
- NEVER reopen a topic already listed in Relationships topics=[] for that peer. Pick a different peer or a new angle from their unused skills / your origin_summary.
- Prefer peers with FEWER shared topics. Fresh craft over nostalgia about past lessons.
- When alone: walk toward another agent's place OR your haunt. When nearby: talk/ask about something NEW, then teach only if the tip is novel.
- New learning verbs: ask_question (curiosity), practice_skill (rehearse an owned skill), debate (compare methods OR council stance), demo (show a method publicly).
- When sharing: PROCESS and INSIGHT only. NEVER invent or leak confidential client names, passwords, private data, or secrets.
- item MUST be a short NEW snake_case skill tag not already in your skills list (or the learner's).
- Do not leave more than one public note per place visit — after posting, reflect or walk.
- During council_session: walk to event_place, then debate/talk/post_notice. Invent YOUR OWN stance from your personality, goal, and mindset — never repeat a canned slogan. Hands stay closed.

Return ONLY JSON:
{"action":"...","target_place":"place_id|null","target_agent":"full_uuid|null","utterance":"what you say|null","thought":"inner voice","item":"object_id_or_skill_tag|null","plan":"day plan text|null"}

World rules:
- Prefer set_plan once if you lack a day_plan (include one meetup goal like "Find X, ask about Y").
- COMMITMENT: If commit_ticks > 0, finish ONE beat, then you MAY walk. If commit is "part", you MUST walk to a new venue.
- Never repeat the same solo action (eat / watch_show / rest / inspect) twice in a row — walk toward a peer instead.
- walk sets a destination; the town pathfinds you along roads in realtime.
- While walking you will NOT be asked again until you arrive.
- talk / share_experience / teach / ask_question / debate / demo / ask_favor / accept / refuse / join / give need someone nearby (≤3–4 tiles). If far, walk first.
- practice_skill can be alone; item = an owned skill tag to rehearse.
- leave_note / post_notice write public notices (utterance = note text).
- inspect / fix / give use "item" as object id when relevant.
- Prefer ask_question / teach / debate / demo / share_experience when peers are nearby — Moments + Skill Vault.
- Day (6-19): social / work / learning. Night (20-5): inn or home sleep.
- utterance max 140. thought max 120. Use real uuids. Never output the text null — use JSON null.`;

  const user = `Time: ${world.hour}:00 (tick ${world.tick}) ${
    world.hour >= 20 || world.hour < 6 ? "NIGHT" : "DAY"
  }
Town event: ${world.eventName || "none"} @ ${world.eventPlace || "—"}
${
  world.eventName === "council_session"
    ? `COUNCIL: ${world.eventTopic ? `Living topic from agents: "${world.eventTopic}"` : "No fixed topic yet — propose ONE question from YOUR goal, mindset, or craft. Never invent a generic town slogan."}\nHARD RULE — COUNCIL: Prefer walk to ${world.eventPlace || "stage"}, then debate/talk/ask_question/post_notice. Speak YOUR own view. Do not invent violence or system hacks.\n`
    : ""
}
You are ${agent.name}
Origin: ${agent.origin || "native"}
What you brought into town: ${agent.origin_summary || "(no prior summary — still act like someone with a past)"}
Personality: ${agent.personality}
Haunt (home venue): ${agent.haunt_place_id || "(none yet)"}
Town role: ${agent.town_role || "(none yet)"}
Mindset: ${agent.mindset || "still forming"}
Mood: ${agent.mood || "neutral"}
Public aim (watchers see this): ${agent.goal || "have an interesting day and learn from peers"}
Appointment: ${
    agent.appointment_with || agent.appointment_place
      ? `@${agent.appointment_place || "?"} hour=${agent.appointment_hour ?? "?"} note="${agent.appointment_note || ""}" — prefer walk/join when due`
      : "none"
  }
Skills so far: ${skills.length ? skills.join(", ") : "(none yet)"}
Skills gained today: ${agent.skills_today ?? 0}/2 · Lessons absorbed today: ${agent.lessons_today ?? 0}/3
HARD RULE — SLOW LEARNING: If skills_today>=2 or lessons_today>=3, do NOT teach/share/debate/demo new tags — talk, ask, walk, or reflect only.
DO NOT RETEACH THESE TAGS (yours): ${skills.length ? skills.join(", ") : "(none)"}
Recent lesson topics (DO NOT RETEACH): ${
    world.lessons
      .slice(0, 5)
      .map((l) => l.topic || "tip")
      .join(", ") || "(none)"
  }
Pending question you must answer: ${
    agent.pending_answer_question
      ? `"${agent.pending_answer_question}" (topic=${agent.pending_answer_topic || "curiosity"}) — prefer teach/talk to that peer.`
      : "none"
  }
Lessons absorbed count: ${agent.lessons_learned ?? 0}
Day plan: ${agent.day_plan || "(none — consider set_plan)"}
Current commitment: ${
    (agent.commit_ticks ?? 0) > 0
      ? `${agent.commit_action || "beat"} — ${agent.commit_detail || "finish this"} (${agent.commit_ticks} ticks left). STAY.`
      : "none — you may start a fresh beat or travel"
  }
Now: status=${agent.status} energy=${agent.energy} place=${agent.place_id} pos=${agent.x},${agent.y} last=${agent.last_action || "—"}
Inventory: ${JSON.stringify(agent.inventory || [])}
${needsPlan ? "\nHINT: You have no day plan yet — set_plan is a strong first move.\n" : ""}
${world.threadPrompt || ""}
${
  world.threadPrompt
    ? ""
    : talkStreak
      ? "\nWARNING: Shallow chat loop. Prefer ask_question / debate with a NEW angle, then walk.\n"
      : ""
}
${
  world.threadPrompt
    ? ""
    : sameTopicLoop || placeStuck
    ? "\nHARD RULE — TOPIC/PLACE LOOP: You MUST action=walk toward a peer's place or library/workshop/cafe/docks/stage/park. NEW venue, NEW topic. Do NOT reteach old tips.\n"
    : !nearby.length && (agent.energy ?? 100) >= 25
      ? "\nHARD RULE — ALONE: Walk toward another agent's place_id to meet them. Prefer meetup over solo eat/watch.\n"
      : soloDone.has(agent.last_action || "") && (agent.commit_ticks ?? 0) <= 1
        ? `\nHARD RULE — SOLO DONE: You just did ${agent.last_action}. Do NOT repeat it. Prefer walk toward a peer, ask_question, or a different venue.\n`
        : agent.commit_action === "part"
          ? "\nHARD RULE — PART: Walk to a fresh venue now after the learning beat.\n"
          : (agent.commit_ticks ?? 0) > 0
            ? `\nSOFT RULE: Prefer finishing action=${agent.commit_action || "reflect"} once, then walk. Do not spam the same beat.\n`
            : ""
}
${
  agent.day_plan
    ? "\nYou already have a day_plan — do NOT set_plan again. Execute it with concrete actions.\n"
    : ""
}

Other agents (peers with their own brains):
${world.agents
  .filter((o) => o.id !== agent.id)
  .map((o) => {
    const os = Array.isArray(o.skills) ? (o.skills as string[]).slice(0, 4).join(", ") : "";
    return `- ${o.name} id=${o.id} origin=${o.origin || "native"} @${o.x},${o.y} place=${o.place_id} status=${o.status} skills=[${os}] brought="${(o.origin_summary || "").slice(0, 90)}" thought="${o.thought || ""}"`;
  })
  .join("\n") || "- alone"}

Nearby (can interact / teach / share now):
${nearby.length ? nearby.map((n) => `- ${n.name} id=${n.id} role=${n.town_role || "—"} haunt=${n.haunt_place_id || "—"}`).join("\n") : "- nobody in range"}

Relationships (topics= already covered — DO NOT ask/reteach those with that peer):
${myRels.length
  ? myRels
      .map((r) => {
        const other = world.agents.find((a) => a.id === r.other_id);
        const topics = Array.isArray(r.last_topics)
          ? (r.last_topics as string[]).slice(0, 6).join(", ")
          : "";
        const open = r.open_question
          ? ` OPEN:"${r.open_question}"`
          : "";
        return `- ${other?.name || r.other_id}: score=${r.score} DONE_TOPICS=[${topics}] note="${r.last_note || ""}"${open}`;
      })
      .join("\n")
  : "- none yet"}

HARD RULE — FRESH MINDS: Invent the next question from (1) a peer skill you lack, (2) your origin_summary craft, or (3) something happening at this place NOW. Do not recycle DONE_TOPICS or old lesson text.

Recent lessons you learned:
${world.lessons.map((l) => `- [${l.topic || "tip"}] ${l.lesson}`).join("\n") || "- none yet"}

Town objects:
${world.objects
  .slice(0, 12)
  .map(
    (o) =>
      `- ${o.id} (${o.name}) @${o.place_id || "held:" + o.holder_id} state=${o.state}`,
  )
  .join("\n") || "- none"}

Recent notices:
${world.notices
  .slice(0, 6)
  .map((n) => `- @${n.place_id}: "${n.body}"`)
  .join("\n") || "- none"}

Travel times from here:
${distances}

Recent city log:
${world.recentLog
  .slice(0, 10)
  .map((l) => `- ${l.message}`)
  .join("\n")}

Memories:
${world.memories.map((m) => `- ${m}`).join("\n") || "- none yet"}

Choose the most interesting next beat — meet peers, ask something new, teach only novel tips, keep secrets out.`;

  const errors: string[] = [];
  for (const cfg of list) {
    try {
      let text = "";
      if (cfg.name === "gemini") {
        text = await callGemini(cfg.key, cfg.model, system, user);
      } else if (cfg.url) {
        text = await callOpenAICompat(cfg.url, cfg.key, cfg.model, system, user);
      }
      const decision = extractJson(text);
      if (decision) {
        return {
          ...decision,
          // Keep the agent's own thought; only tag provider if they left thought empty
          thought: decision.thought
            ? decision.thought
            : `via ${cfg.name}/${cfg.model}`,
        };
      }
      errors.push(`${cfg.name}/${cfg.model}: bad_json`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${cfg.name}/${cfg.model}: ${msg.slice(0, 160)}`);
      console.error(`LLM ${cfg.name} failed`, err);
    }
  }

  // Never freeze the town — director fallback keeps scenes moving
  const fb = fallbackAgentDecisionWithPeers(
    agent,
    world.places,
    world.agents,
    world.tick,
  );
  const quotaHit = errors.some((e) => isLlmQuotaError(e));
  return {
    ...fb,
    thought: quotaHit
      ? `${fb.thought || "Director beat"} (API quota exhausted — need new free tokens)`
      : `${fb.thought || "Director beat"} (LLM offline — scripted scene)`,
  };
}

/** True when provider response looks like free-tier / rate-limit exhaustion. */
export function isLlmQuotaError(message: string): boolean {
  return /429|resource_exhausted|quota|rate.?limit|exceeded your current quota|Too Many Requests/i.test(
    message,
  );
}
