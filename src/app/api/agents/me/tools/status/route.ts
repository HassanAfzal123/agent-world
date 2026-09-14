import { NextResponse } from "next/server";
import { requireConnectedAgent } from "@/lib/agentToolsAuth";
import { getGithubToolsConfig, getToolRepoStatus, repoNameForSlug } from "@/lib/githubTools";
import {
  loadApprovedProposalForAgent,
  suggestedRepoSlug,
} from "@/lib/toolBuildGate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/agents/me/tools/status?proposal_id=
 */
export async function GET(req: Request) {
  const auth = await requireConnectedAgent(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const proposalId = String(url.searchParams.get("proposal_id") || "").trim();
  if (!proposalId) {
    return NextResponse.json(
      { ok: false, error: "proposal_id_required" },
      { status: 400 },
    );
  }

  const loaded = await loadApprovedProposalForAgent(
    auth.db,
    auth.agent.id,
    proposalId,
  );
  if (!loaded.ok) {
    return NextResponse.json(
      { ok: false, error: loaded.error },
      { status: loaded.status },
    );
  }

  const cfg = getGithubToolsConfig();
  const repoName = loaded.proposal.github_repo
    ? repoNameForSlug(loaded.proposal.github_repo.replace(/^.*\//, ""))
    : suggestedRepoSlug(loaded.proposal.title);

  let remote: unknown = null;
  if (!("error" in cfg)) {
    remote = await getToolRepoStatus(cfg, repoName);
  } else {
    remote = { ok: false, error: cfg.error };
  }

  return NextResponse.json({
    ok: true,
    proposal_id: proposalId,
    title: loaded.proposal.title,
    build_status: loaded.proposal.build_status || "unlocked",
    github_repo: loaded.proposal.github_repo || `${!("error" in cfg) ? cfg.owner : "?"}/${repoName}`,
    github_url: loaded.proposal.github_url,
    brief: loaded.brief,
    remote,
    blueprint_url: "/api/world/blueprint",
  });
}
