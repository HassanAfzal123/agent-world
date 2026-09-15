/**
 * Gate: only approved proposal owners/participants may use GitHub proxy APIs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createBuildBrief, type ProposalRecord } from "./buildLane";
import { repoNameForSlug } from "./githubTools";

export type ToolProposalRow = {
  id: string;
  title: string;
  body: string;
  status: string;
  filed_by: string;
  participant_ids: string[] | null;
  decision_note: string | null;
  github_repo?: string | null;
  github_url?: string | null;
  build_status?: string | null;
};

export function agentMayBuild(
  agentId: string,
  proposal: Pick<ToolProposalRow, "status" | "filed_by" | "participant_ids">,
): { ok: true } | { ok: false; error: string } {
  if (proposal.status !== "approved") {
    return { ok: false, error: "proposal_not_approved" };
  }
  const parts = Array.isArray(proposal.participant_ids)
    ? proposal.participant_ids
    : [];
  if (proposal.filed_by === agentId || parts.includes(agentId)) {
    return { ok: true };
  }
  return { ok: false, error: "not_proposal_owner" };
}

export function suggestedRepoSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "tool";
  return repoNameForSlug(slug);
}

export async function loadApprovedProposalForAgent(
  db: SupabaseClient,
  agentId: string,
  proposalId: string,
): Promise<
  | { ok: true; proposal: ToolProposalRow; brief: ReturnType<typeof createBuildBrief> }
  | { ok: false; error: string; status: number }
> {
  const { data, error } = await db
    .from("tool_proposals")
    .select(
      "id, title, body, status, filed_by, participant_ids, decision_note, github_repo, github_url, build_status",
    )
    .eq("id", proposalId)
    .maybeSingle();

  if (error) {
    // Migration 20260915_tool_builds_github.sql not applied yet — fall back.
    if (/github_repo|build_status|github_url/i.test(error.message)) {
      const fallback = await db
        .from("tool_proposals")
        .select(
          "id, title, body, status, filed_by, participant_ids, decision_note",
        )
        .eq("id", proposalId)
        .maybeSingle();
      if (fallback.error) {
        return { ok: false, error: fallback.error.message, status: 500 };
      }
      if (!fallback.data) {
        return { ok: false, error: "proposal_not_found", status: 404 };
      }
      const proposal = fallback.data as ToolProposalRow;
      const gate = agentMayBuild(agentId, proposal);
      if (!gate.ok) {
        return { ok: false, error: gate.error, status: 403 };
      }
      return {
        ok: true,
        proposal,
        brief: createBuildBrief(proposal as ProposalRecord),
      };
    }
    return { ok: false, error: error.message, status: 500 };
  }
  if (!data) {
    return { ok: false, error: "proposal_not_found", status: 404 };
  }

  const proposal = data as ToolProposalRow;
  const gate = agentMayBuild(agentId, proposal);
  if (!gate.ok) {
    return {
      ok: false,
      error: gate.error,
      status: gate.error === "proposal_not_approved" ? 403 : 403,
    };
  }

  const brief = createBuildBrief(proposal as ProposalRecord);
  return { ok: true, proposal, brief };
}

export function assertSafeToolPaths(paths: string[]): string | null {
  for (const p of paths) {
    if (!p || p.includes("..") || p.startsWith("/") || p.includes("\\")) {
      return `bad_path:${p}`;
    }
    if (/^(src\/app|supabase\/|\.env|node_modules)/i.test(p)) {
      return `forbidden_path:${p}`;
    }
  }
  return null;
}

export type AgentBuildNextStep =
  | "create_repo"
  | "push_scaffold"
  | "continue_build"
  | "done";

export type AgentBuildItem = {
  proposal_id: string;
  title: string;
  build_status: string;
  github_repo: string | null;
  github_url: string | null;
  next_step: AgentBuildNextStep;
  brief_status: string;
};

export function nextBuildStep(proposal: {
  github_repo?: string | null;
  build_status?: string | null;
}): AgentBuildNextStep {
  const status = String(proposal.build_status || "unlocked").toLowerCase();
  if (status === "repo_ready" || status === "done" || status === "shipped") {
    return "done";
  }
  if (!proposal.github_repo) {
    return "create_repo";
  }
  if (
    status === "repo_created" ||
    status === "unlocked" ||
    status === "pushing" ||
    status === ""
  ) {
    return "push_scaffold";
  }
  return "continue_build";
}

/** Approved proposals this agent may build (filer or participant). */
export async function listAgentBuilds(
  db: SupabaseClient,
  agentId: string,
): Promise<AgentBuildItem[]> {
  const { data, error } = await db
    .from("tool_proposals")
    .select(
      "id, title, body, status, filed_by, participant_ids, decision_note, github_repo, github_url, build_status",
    )
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .limit(20);

  if (error || !data?.length) return [];

  const out: AgentBuildItem[] = [];
  for (const row of data as ToolProposalRow[]) {
    if (!agentMayBuild(agentId, row).ok) continue;
    const brief = createBuildBrief(row as ProposalRecord);
    const step = nextBuildStep(row);
    out.push({
      proposal_id: row.id,
      title: row.title,
      build_status: row.build_status || brief.status,
      github_repo: row.github_repo || null,
      github_url: row.github_url || null,
      next_step: step,
      brief_status: brief.status,
    });
  }
  return out;
}
