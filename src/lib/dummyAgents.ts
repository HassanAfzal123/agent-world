/**
 * Dummy-agent cast + behavioral expectations for the test suite.
 * These mirror the real deploy cast (Brief, Triage, …) without networking.
 */

export type DummyCastMember = {
  id: string;
  name: string;
  role: string;
  haunt: string;
  /** Prefer 1:1 outside Town Hall windows */
  prefers_dyad: boolean;
  /** Speaks at Town Hall / nominates */
  meeting_active: boolean;
};

export const DUMMY_CAST: DummyCastMember[] = [
  {
    id: "a-brief",
    name: "Brief",
    role: "requirements scribe",
    haunt: "library",
    prefers_dyad: true,
    meeting_active: true,
  },
  {
    id: "a-triage",
    name: "Triage",
    role: "priority sorter",
    haunt: "clinic",
    prefers_dyad: true,
    meeting_active: true,
  },
  {
    id: "a-patch",
    name: "Patch",
    role: "fix crafter",
    haunt: "workshop",
    prefers_dyad: true,
    meeting_active: true,
  },
  {
    id: "a-scout",
    name: "Scout",
    role: "explorer",
    haunt: "park",
    prefers_dyad: true,
    meeting_active: false,
  },
  {
    id: "a-clerk",
    name: "Clerk",
    role: "records",
    haunt: "notice",
    prefers_dyad: true,
    meeting_active: true,
  },
  {
    id: "a-forge",
    name: "Forge",
    role: "builder",
    haunt: "workshop",
    prefers_dyad: false,
    meeting_active: true,
  },
  {
    id: "a-merge",
    name: "Merge",
    role: "integrator",
    haunt: "docks",
    prefers_dyad: true,
    meeting_active: true,
  },
  {
    id: "a-probe",
    name: "Probe",
    role: "tester",
    haunt: "cafe",
    prefers_dyad: true,
    meeting_active: false,
  },
  {
    id: "a-relay",
    name: "Relay",
    role: "messenger",
    haunt: "plaza",
    prefers_dyad: false,
    meeting_active: true,
  },
  {
    id: "a-hex",
    name: "Hex",
    role: "security skeptic",
    haunt: "inn",
    prefers_dyad: true,
    meeting_active: true,
  },
];

export type BehaviorPhase = "collaborate" | "meeting" | "voting" | "filing";

/** What a well-behaved dummy should prioritize in each phase. */
export function expectedPriorityHint(
  agent: DummyCastMember,
  phase: BehaviorPhase,
  alreadyInGroup: boolean,
): string {
  if (phase === "collaborate") {
    if (agent.prefers_dyad && !alreadyInGroup) {
      return "prefer_dyad_or_walk";
    }
    return "optional_group_if_tool_idea";
  }
  if (phase === "meeting") {
    if (!agent.meeting_active) return "listen_or_vote_later";
    if (!alreadyInGroup) return "join_or_form_group_at_plaza";
    return "compose_then_nominate";
  }
  if (phase === "voting") return "vote_idea";
  return agent.meeting_active ? "help_champion_or_file" : "stay_clear";
}

/** Detect invite/command spam patterns agents must not emit. */
export function isProcedureSpam(utterance: string): boolean {
  const t = utterance.trim();
  if (!t) return false;
  return (
    /lock one next step/i.test(t) ||
    /hourly tool cycle/i.test(t) ||
    /we need a real group/i.test(t) ||
    /invite_to_group|nominate_idea|compose_proposal/i.test(t) ||
    /open_group_conversation/i.test(t)
  );
}

/** After admin approve — dummy owners should enter build coordination. */
export function postApprovalOwnerActions(approved: boolean): string[] {
  if (!approved) return ["read_notice", "revise_or_drop"];
  return [
    "fetch_blueprint",
    "open_aw_tool_repo",
    "write_TOOL_md",
    "implement_standalone",
    "coordinate_in_town",
    "notify_human_when_ready",
  ];
}
