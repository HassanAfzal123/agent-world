import type { Agent } from "@/lib/types";
import { fullSpeech } from "@/lib/spectator";

export type ConversationThread = {
  id: string;
  place_id: string | null;
  starter_id: string;
  other_id: string;
  topic: string | null;
  status: "open" | "closed" | string;
  max_turns: number;
  turn_count: number;
  waiting_on: string | null;
  participant_ids?: string[] | null;
  mode?: "dyad" | "group" | string | null;
  created_at: string;
  updated_at: string;
};

export type ConversationMessage = {
  id: number;
  thread_id: string;
  agent_id: string;
  body: string;
  kind: string;
  created_at: string;
};

export type ThreadLine = {
  agentId: string;
  name: string;
  body: string;
  kind: string;
  at: string;
};

export function isDialogueLocked(agent: Agent): boolean {
  return agent.commit_action === "dialogue";
}

export function peerInDialogue(
  thread: ConversationThread | null | undefined,
  agentId: string,
): boolean {
  if (!thread || thread.status !== "open") return false;
  return thread.starter_id === agentId || thread.other_id === agentId;
}

/** True if this body is too similar to the last thread line. */
export function isRepeatThreadLine(
  body: string | null | undefined,
  lastBody: string | null | undefined,
): boolean {
  const a = fullSpeech(body) || (body || "").trim();
  const b = fullSpeech(lastBody) || (lastBody || "").trim();
  if (!a || !b) return false;
  return a.slice(0, 48).toLowerCase() === b.slice(0, 48).toLowerCase();
}

export function formatThreadPrompt(
  lines: ThreadLine[],
  agent: Agent,
): string {
  if (!lines.length) return "";
  const transcript = lines
    .slice(-5)
    .map((l) => `- ${l.name}: "${l.body}"`)
    .join("\n");
  const origin = (agent.origin_summary || "").trim().slice(0, 160);
  const mind = (agent.mindset || "").trim().slice(0, 100);
  const skills = Array.isArray(agent.skills)
    ? (agent.skills as string[]).slice(0, 6).join(", ")
    : "";
  return `
HARD RULE — ACTIVE THREAD (Moltbook-style):
You are mid-conversation. Address the LAST line with a NEW detail — do NOT repeat their question or yours.
Do NOT ask "What method are you using that I have not tried?" or any generic curiosity filler.
Include ONE concrete detail from your own past (origin_summary / skills / mindset) — never invent a new biography.
Advance the topic: answer, then offer a related NEW angle from your craft, or close politely if the beat is done.
Origin you actually have: ${origin || "(none written — use personality/skills only)"}
Mindset: ${mind || "(none)"}
Skills: ${skills || "(none)"}
Prefer action talk (or ask_question / share_experience) aimed at your conversation partner.
Thread so far:
${transcript}
`;
}
