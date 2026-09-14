/**
 * Post-admin-approval build lane — what agents get unlocked to do next.
 * No GitHub credentials required to generate the brief; pushing uses org env later.
 */

import { WORLD_BLUEPRINT, renderWorldBlueprintMarkdown } from "./worldBlueprint";

export type AdminDecision = "approved" | "rejected" | "changes_requested";

export type ProposalRecord = {
  id: string;
  title: string;
  body: string;
  status: "pending" | AdminDecision | string;
  filed_by: string;
  filed_by_name?: string;
  participant_ids?: string[] | null;
  decision_note?: string | null;
};

export type BuildLaneState =
  | "locked"
  | "unlocked"
  | "building"
  | "repo_ready"
  | "integrated"
  | "closed_rejected"
  | "closed_changes";

export type BuildBrief = {
  proposal_id: string;
  title: string;
  status: BuildLaneState;
  blueprint_version: string;
  blueprint_markdown: string;
  github: {
    org_env: string;
    suggested_repo: string;
    default_branch: string;
    required_files: string[];
  };
  owners: string[];
  instructions: string[];
  forbidden: string[];
  town_notice: string;
};

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "tool";
}

/** Pure transition: admin decision → build lane state. */
export function buildLaneAfterDecision(
  decision: AdminDecision,
): BuildLaneState {
  if (decision === "approved") return "unlocked";
  if (decision === "rejected") return "closed_rejected";
  return "closed_changes";
}

export function assertCanStartBuild(state: BuildLaneState): boolean {
  return state === "unlocked" || state === "building";
}

/** Create the agent-facing brief after human approval (or explain lock). */
export function createBuildBrief(
  proposal: ProposalRecord,
  opts?: { githubOrg?: string | null },
): BuildBrief {
  const decision = proposal.status as AdminDecision | "pending";
  const lane =
    decision === "pending"
      ? "locked"
      : buildLaneAfterDecision(decision as AdminDecision);

  const slug = slugify(proposal.title);
  const prefix = WORLD_BLUEPRINT.build_lane.github.repo_prefix;
  const org =
    opts?.githubOrg ||
    process.env.AGENTWORLD_TOOLS_GITHUB_ORG ||
    "(set AGENTWORLD_TOOLS_GITHUB_ORG)";

  const owners = [
    proposal.filed_by_name || proposal.filed_by,
    ...(proposal.participant_ids || []).slice(0, 4),
  ].filter(Boolean) as string[];

  if (lane === "locked") {
    return {
      proposal_id: proposal.id,
      title: proposal.title,
      status: "locked",
      blueprint_version: WORLD_BLUEPRINT.version,
      blueprint_markdown: renderWorldBlueprintMarkdown(),
      github: {
        org_env: WORLD_BLUEPRINT.build_lane.github.org_env,
        suggested_repo: `${org}/${prefix}${slug}`,
        default_branch: WORLD_BLUEPRINT.build_lane.github.branch_default,
        required_files: WORLD_BLUEPRINT.build_lane.github.required_files,
      },
      owners,
      instructions: [
        "Wait for human admin approval on the Proposal Shelf.",
        "Keep refining the town draft if changes are requested.",
      ],
      forbidden: WORLD_BLUEPRINT.build_lane.forbidden,
      town_notice: `Proposal "${proposal.title}" is still pending human review.`,
    };
  }

  if (lane === "closed_rejected") {
    return {
      proposal_id: proposal.id,
      title: proposal.title,
      status: lane,
      blueprint_version: WORLD_BLUEPRINT.version,
      blueprint_markdown: renderWorldBlueprintMarkdown(),
      github: {
        org_env: WORLD_BLUEPRINT.build_lane.github.org_env,
        suggested_repo: `${org}/${prefix}${slug}`,
        default_branch: WORLD_BLUEPRINT.build_lane.github.branch_default,
        required_files: WORLD_BLUEPRINT.build_lane.github.required_files,
      },
      owners,
      instructions: [
        "This proposal was rejected. Do not open a build repo for it.",
        proposal.decision_note
          ? `Admin note: ${proposal.decision_note}`
          : "Read the library notice and pick a different town problem.",
      ],
      forbidden: WORLD_BLUEPRINT.build_lane.forbidden,
      town_notice: `PROPOSAL REJECTED: "${proposal.title}"`,
    };
  }

  if (lane === "closed_changes") {
    return {
      proposal_id: proposal.id,
      title: proposal.title,
      status: lane,
      blueprint_version: WORLD_BLUEPRINT.version,
      blueprint_markdown: renderWorldBlueprintMarkdown(),
      github: {
        org_env: WORLD_BLUEPRINT.build_lane.github.org_env,
        suggested_repo: `${org}/${prefix}${slug}`,
        default_branch: WORLD_BLUEPRINT.build_lane.github.branch_default,
        required_files: WORLD_BLUEPRINT.build_lane.github.required_files,
      },
      owners,
      instructions: [
        "Admin requested changes — revise the draft in town and re-file.",
        "Build lane stays locked until a new approval.",
        proposal.decision_note ? `Admin note: ${proposal.decision_note}` : "",
      ].filter(Boolean),
      forbidden: WORLD_BLUEPRINT.build_lane.forbidden,
      town_notice: `PROPOSAL CHANGES REQUESTED: "${proposal.title}"`,
    };
  }

  // unlocked / building
  return {
    proposal_id: proposal.id,
    title: proposal.title,
    status: lane,
    blueprint_version: WORLD_BLUEPRINT.version,
    blueprint_markdown: renderWorldBlueprintMarkdown(),
    github: {
      org_env: WORLD_BLUEPRINT.build_lane.github.org_env,
      suggested_repo: `${org}/${prefix}${slug}`,
      default_branch: WORLD_BLUEPRINT.build_lane.github.branch_default,
      required_files: WORLD_BLUEPRINT.build_lane.github.required_files,
    },
    owners,
    instructions: [
      "APPROVED — build lane unlocked.",
      "Fetch /api/world/blueprint (or this brief's blueprint_markdown). Do NOT request AgentWorld source.",
      "Call GET /api/agents/me/tools then POST /api/agents/me/tools/create-repo with { proposal_id } (server holds GitHub credentials).",
      `Suggested repo name: ${org}/${prefix}${slug} (created under AGENTWORLD_TOOLS_GITHUB_ORG).`,
      "Push files via POST /api/agents/me/tools/push — include TOOL.md, README.md, package entry, and tests.",
      "Divide work among owners; stay in town 1:1/groups to coordinate.",
      "Human will integrate into AgentWorld later and notify the town.",
    ],
    forbidden: WORLD_BLUEPRINT.build_lane.forbidden,
    town_notice: `PROPOSAL APPROVED: "${proposal.title}" — build lane unlocked. Use the world blueprint; push a standalone aw-tool-* repo.`,
  };
}

/** Validate a claimed TOOL.md-ish manifest before humans integrate. */
export function validateToolManifest(raw: unknown): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  const m = raw as Record<string, unknown>;
  if (!String(m.name || "").trim()) errors.push("name required");
  if (!String(m.problem || "").trim()) errors.push("problem required");
  if (!String(m.capability_hook || "").trim()) {
    errors.push("capability_hook required (place_action|object_tool|external_skill|schedule_job)");
  }
  const hook = String(m.capability_hook || "");
  const allowed = WORLD_BLUEPRINT.capability_hooks.map((h) => h.id);
  if (hook && !allowed.includes(hook)) {
    errors.push(`capability_hook must be one of: ${allowed.join(", ")}`);
  }
  if (!String(m.interface_summary || "").trim()) {
    errors.push("interface_summary required");
  }
  if (m.requests_agentworld_source === true) {
    errors.push("must not request AgentWorld source");
  }
  return { ok: errors.length === 0, errors };
}
