export const MAP = {
  cols: 40,
  rows: 30,
  tile: 20,
} as const;

export type Place = {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type AgentStatus =
  | "idle"
  | "walking"
  | "talking"
  | "working"
  | "sleeping"
  | "eating"
  | "shopping"
  | "posting"
  | "watching"
  | "planning"
  | "giving";

export type Agent = {
  id: string;
  owner_id: string | null;
  name: string;
  personality: string;
  color: string;
  /** Procedural silhouette + creative title (auto-assigned on spawn). */
  look?: unknown;
  place_id: string | null;
  x: number;
  y: number;
  status: AgentStatus | string;
  thought: string | null;
  target_place_id: string | null;
  /** Remaining pathfinding waypoints while walking (set by /api/city/walk). */
  path?: { x: number; y: number }[] | unknown;
  job: string | null;
  energy: number;
  is_npc: boolean;
  brain?: string;
  goal?: string | null;
  inventory?: unknown;
  day_plan?: string | null;
  plan_hour?: number | null;
  mood?: string | null;
  last_action?: string | null;
  origin?: string | null;
  origin_summary?: string | null;
  skills?: string[] | unknown;
  lessons_learned?: number | null;
  skills_today?: number | null;
  lessons_today?: number | null;
  learn_day_key?: string | null;
  pending_answer_to?: string | null;
  pending_answer_topic?: string | null;
  pending_answer_question?: string | null;
  last_llm_at?: string | null;
  /** Place this agent treats as home / haunt. */
  haunt_place_id?: string | null;
  /** Soft town role: host, fixer, guide, critic, regular… */
  town_role?: string | null;
  appointment_with?: string | null;
  appointment_place?: string | null;
  appointment_hour?: number | null;
  appointment_note?: string | null;
  commit_action?: string | null;
  commit_detail?: string | null;
  commit_ticks?: number | null;
  mindset?: string | null;
  last_tick_at?: string | null;
  /** native town stock | waiting for human claim | human-connected */
  claim_status?: "native" | "pending_claim" | "claimed" | string | null;
};

export type CityMeta = {
  id: number;
  tick: number;
  hour: number;
  last_tick_at: string | null;
  paused: boolean;
  event_name?: string | null;
  event_place?: string | null;
  event_until_hour?: number | null;
  /** Public debate topic during council_session. */
  event_topic?: string | null;
};

export type CityLogRow = {
  id: number;
  agent_id: string | null;
  kind: string;
  message: string;
  created_at: string;
};

export type Notice = {
  id: number;
  author_id: string | null;
  place_id: string | null;
  body: string;
  created_at: string;
};

export type TownObject = {
  id: string;
  name: string;
  place_id: string | null;
  holder_id: string | null;
  state: string;
  note: string | null;
};

export type Relationship = {
  agent_id: string;
  other_id: string;
  score: number;
  last_note: string | null;
  updated_at: string;
  last_topics?: string[] | unknown;
  open_question?: string | null;
  open_question_from?: string | null;
  open_since?: string | null;
};

export type AgentLesson = {
  id: number;
  teacher_id: string | null;
  learner_id: string;
  topic: string | null;
  lesson: string;
  created_at: string;
};

export type AgentJournal = {
  id: number;
  agent_id: string;
  kind: string;
  title: string | null;
  body: string;
  meta?: unknown;
  created_at: string;
};

export type TownMoment = {
  id: number;
  kind: string;
  headline: string;
  body: string | null;
  agent_id: string | null;
  other_id: string | null;
  place_id: string | null;
  meta?: unknown;
  created_at: string;
};

export type SkillCard = {
  id: number;
  agent_id: string;
  tag: string;
  title: string;
  method: string;
  source_agent_id: string | null;
  lesson_id?: number | null;
  place_id: string | null;
  take_home: string | null;
  created_at: string;
};

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

export type ConversationThreadView = ConversationThread & {
  messages: ConversationMessage[];
};

export const AGENT_COLORS = [
  "#3ad4ff",
  "#ff6b6b",
  "#ffd166",
  "#06d6a0",
  "#f4a261",
  "#e9c46a",
  "#a8dadc",
  "#bdb2ff",
  "#ff6b9d",
  "#7bdff2",
];
