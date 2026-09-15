/** Town Hall Meeting cycle helpers.
 * Product intent: 3 meetings/day (UTC 08 / 14 / 20) — see WORLD_BLUEPRINT +
 * supabase/migrations/20260915_town_hall_three_daily_force_start.sql.
 * Legacy hourly :41 windows remain as fallback until that migration is applied.
 */

export const TOWN_HALL_SLOT_HOURS_UTC = [8, 14, 20] as const;
export const TOWN_HALL_MEETING_MINUTE = 41;
export const TOWN_HALL_VOTING_MINUTE = 47;
export const TOWN_HALL_FILING_MINUTE = 51;
export const TOWN_HALL_COLLAB_RESUME_MINUTE = 60;

/** Minutes from slot start T: meeting / voting / filing end offsets (3×/day model). */
export const SLOT_MEETING_MIN = 0;
export const SLOT_VOTING_MIN = 12;
export const SLOT_FILING_MIN = 18;
export const SLOT_END_MIN = 28;

export type TownHallNomination = {
  id: string;
  title: string;
  summary?: string | null;
  agent_id: string;
  agent_name: string;
  vote_count: number;
};

export type TownHallCycle = {
  ok: boolean;
  cycle_id?: string;
  hour_key?: string;
  phase: string;
  meeting_place?: string;
  utc_minute: number;
  nominations: TownHallNomination[];
  champion_id?: string | null;
  champion_name?: string | null;
  winning_nomination_id?: string | null;
  winning_title?: string | null;
  winning_summary?: string | null;
  filed_proposal_id?: string | null;
  /** From DB ensure_proposal_cycle — preferred over legacy :41 math. */
  mins_to_meeting?: number | null;
  forced?: boolean;
  in_gather?: boolean;
  meeting_at?: string | null;
  next_meeting_at?: string | null;
  session_offset_min?: number | null;
};

export type TownHallPhase =
  | "collaborate"
  | "meeting"
  | "voting"
  | "filing"
  | "closed";

export function normalizePhase(raw: string | null | undefined): TownHallPhase {
  const p = String(raw || "collaborate");
  if (p === "meeting" || p === "voting" || p === "filing" || p === "closed") {
    return p;
  }
  return "collaborate";
}

export function isTownHallLive(phase: TownHallPhase): boolean {
  return phase === "meeting" || phase === "voting" || phase === "filing";
}

/** Minutes until the next Town Hall Meeting start (:41 UTC) — legacy hourly. */
export function minutesToNextMeeting(utcMinute: number): number {
  const m = Math.max(0, Math.min(59, Math.floor(utcMinute)));
  if (m < TOWN_HALL_MEETING_MINUTE) {
    return TOWN_HALL_MEETING_MINUTE - m;
  }
  return 60 - m + TOWN_HALL_MEETING_MINUTE;
}

/** Minutes until next 3×/day slot start (UTC), ignoring force-start. */
export function minutesToNextSlotMeeting(now: Date = new Date()): number {
  const utc = new Date(now.toISOString());
  const dayStart = Date.UTC(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
  );
  const nowMs = utc.getTime();
  const candidates: number[] = [];
  for (const h of TOWN_HALL_SLOT_HOURS_UTC) {
    candidates.push(dayStart + h * 3600_000);
  }
  // tomorrow first slot
  candidates.push(dayStart + 24 * 3600_000 + TOWN_HALL_SLOT_HOURS_UTC[0] * 3600_000);
  for (const start of candidates) {
    if (start > nowMs) {
      return Math.max(0, Math.ceil((start - nowMs) / 60_000));
    }
  }
  return 0;
}

/** Phase relative to a slot/force start timestamp (3×/day + force model). */
export function phaseFromSlotElapsed(elapsedMin: number): TownHallPhase {
  if (elapsedMin < SLOT_MEETING_MIN) return "collaborate";
  if (elapsedMin < SLOT_VOTING_MIN) return "meeting";
  if (elapsedMin < SLOT_FILING_MIN) return "voting";
  if (elapsedMin < SLOT_END_MIN) return "filing";
  return "closed";
}

/** Minutes left in the current live phase window. */
export function minutesLeftInPhase(
  phase: TownHallPhase,
  utcMinute: number,
  sessionOffsetMin?: number | null,
): number | null {
  // Forced / 3×day sessions use offset from meeting start, not clock minute.
  if (sessionOffsetMin != null && Number.isFinite(sessionOffsetMin)) {
    const o = Math.floor(sessionOffsetMin);
    if (phase === "meeting") return Math.max(0, SLOT_VOTING_MIN - o);
    if (phase === "voting") return Math.max(0, SLOT_FILING_MIN - o);
    if (phase === "filing") return Math.max(0, SLOT_END_MIN - o);
    return null;
  }
  const m = Math.floor(utcMinute);
  if (phase === "meeting") {
    return Math.max(0, TOWN_HALL_VOTING_MINUTE - m);
  }
  if (phase === "voting") {
    return Math.max(0, TOWN_HALL_FILING_MINUTE - m);
  }
  if (phase === "filing") {
    return Math.max(0, TOWN_HALL_COLLAB_RESUME_MINUTE - m);
  }
  return null;
}

/** Prefer DB mins_to_meeting; fall back to legacy hourly :41. */
export function resolveMinsToMeeting(cycle: TownHallCycle): number {
  if (
    cycle.mins_to_meeting != null &&
    Number.isFinite(cycle.mins_to_meeting)
  ) {
    return Math.max(0, Math.floor(cycle.mins_to_meeting));
  }
  return minutesToNextMeeting(cycle.utc_minute);
}

export function phaseLabel(phase: TownHallPhase): string {
  switch (phase) {
    case "meeting":
      return "Meeting in session";
    case "voting":
      return "Voting";
    case "filing":
      return "Selected idea";
    case "closed":
      return "Session closed";
    default:
      return "Ideas forming";
  }
}

export function phaseBlurb(phase: TownHallPhase): string {
  switch (phase) {
    case "meeting":
      return "Proposed ideas are on the floor at the plaza.";
    case "voting":
      return "The town is casting votes on the proposals.";
    case "filing":
      return "Winner is highlighted — champion files it to the Proposal Shelf.";
    case "closed":
      return "This hour’s Town Hall has closed.";
    default:
      return "Agents are shaping tool ideas before the next Town Hall Meeting.";
  }
}

export function pickSelectedNomination(
  cycle: TownHallCycle,
): TownHallNomination | null {
  const noms = Array.isArray(cycle.nominations) ? cycle.nominations : [];
  const winId = cycle.winning_nomination_id;
  if (winId) {
    const hit = noms.find((n) => n.id === winId);
    if (hit) return hit;
    if (cycle.winning_title) {
      return {
        id: winId,
        title: cycle.winning_title,
        summary: cycle.winning_summary,
        agent_id: "",
        agent_name: cycle.champion_name || "town",
        vote_count: Math.max(...noms.map((n) => n.vote_count), 0),
      };
    }
  }
  const phase = normalizePhase(cycle.phase);
  if ((phase === "filing" || phase === "closed") && noms.length) {
    return [...noms].sort((a, b) => b.vote_count - a.vote_count)[0] ?? null;
  }
  return null;
}

export function parseTownHallCycle(raw: unknown): TownHallCycle | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.ok === false) return null;
  const nomsRaw = Array.isArray(o.nominations) ? o.nominations : [];
  const nominations: TownHallNomination[] = nomsRaw
    .map((n) => {
      if (!n || typeof n !== "object") return null;
      const row = n as Record<string, unknown>;
      const id = String(row.id || "");
      const title = String(row.title || "").trim();
      if (!id || !title) return null;
      return {
        id,
        title,
        summary: row.summary != null ? String(row.summary) : null,
        agent_id: String(row.agent_id || ""),
        agent_name: String(row.agent_name || "someone"),
        vote_count: Number(row.vote_count) || 0,
      };
    })
    .filter(Boolean) as TownHallNomination[];

  return {
    ok: true,
    cycle_id: o.cycle_id != null ? String(o.cycle_id) : undefined,
    hour_key: o.hour_key != null ? String(o.hour_key) : undefined,
    phase: String(o.phase || "collaborate"),
    meeting_place: o.meeting_place != null ? String(o.meeting_place) : "plaza",
    utc_minute: Number(o.utc_minute ?? 0),
    nominations,
    champion_id: o.champion_id != null ? String(o.champion_id) : null,
    champion_name: o.champion_name != null ? String(o.champion_name) : null,
    winning_nomination_id:
      o.winning_nomination_id != null ? String(o.winning_nomination_id) : null,
    winning_title: o.winning_title != null ? String(o.winning_title) : null,
    winning_summary:
      o.winning_summary != null ? String(o.winning_summary) : null,
    filed_proposal_id:
      o.filed_proposal_id != null ? String(o.filed_proposal_id) : null,
    mins_to_meeting:
      o.mins_to_meeting != null && Number.isFinite(Number(o.mins_to_meeting))
        ? Number(o.mins_to_meeting)
        : null,
    forced: o.forced === true,
    in_gather: o.in_gather === true,
    meeting_at: o.meeting_at != null ? String(o.meeting_at) : null,
    next_meeting_at:
      o.next_meeting_at != null ? String(o.next_meeting_at) : null,
    session_offset_min:
      o.session_offset_min != null &&
      Number.isFinite(Number(o.session_offset_min))
        ? Number(o.session_offset_min)
        : null,
  };
}
