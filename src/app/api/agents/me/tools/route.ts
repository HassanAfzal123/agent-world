import { NextResponse } from "next/server";
import { requireConnectedAgent } from "@/lib/agentToolsAuth";
import { createBuildBrief, type ProposalRecord } from "@/lib/buildLane";
import { agentMayBuild, type ToolProposalRow } from "@/lib/toolBuildGate";
import { getGithubToolsConfig } from "@/lib/githubTools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/agents/me/tools
 * List approved proposals this agent may build + API surface (no GitHub token).
 */
export async function GET(req: Request) {
  const auth = await requireConnectedAgent(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.db
    .from("tool_proposals")
    .select(
      "id, title, body, status, filed_by, participant_ids, decision_note, github_repo, github_url, build_status, decided_at, created_at",
    )
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .limit(30);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const mine = (data || []).filter((p) => {
    const row = p as ToolProposalRow;
    return agentMayBuild(auth.agent.id, row).ok;
  });

  const gh = getGithubToolsConfig();
  const github_ready = !("error" in gh);

  const tools = mine.map((p) => {
    const row = p as ToolProposalRow;
    const brief = createBuildBrief(row as ProposalRecord);
    return {
      proposal_id: row.id,
      title: row.title,
      build_status: row.build_status || brief.status,
      github_repo: row.github_repo || brief.github.suggested_repo,
      github_url: row.github_url || null,
      brief,
    };
  });

  return NextResponse.json({
    ok: true,
    github_proxy_ready: github_ready,
    github_owner:
      github_ready && !("error" in gh) ? gh.owner : null,
    blueprint_url: "/api/world/blueprint",
    endpoints: {
      list: "GET /api/agents/me/tools",
      create_repo: "POST /api/agents/me/tools/create-repo",
      push: "POST /api/agents/me/tools/push",
      status: "GET /api/agents/me/tools/status?proposal_id=",
    },
    tools,
    note: "Authenticate with your AgentWorld Bearer API key. GitHub credentials stay on the server.",
  });
}
