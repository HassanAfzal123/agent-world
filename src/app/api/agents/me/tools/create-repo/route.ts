import { NextResponse } from "next/server";
import { requireConnectedAgent } from "@/lib/agentToolsAuth";
import {
  createToolRepo,
  getGithubToolsConfig,
  repoNameForSlug,
} from "@/lib/githubTools";
import {
  loadApprovedProposalForAgent,
  suggestedRepoSlug,
} from "@/lib/toolBuildGate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/agents/me/tools/create-repo
 * Body: { proposal_id: uuid, private?: boolean }
 * Creates aw-tool-* under the server-configured GitHub owner.
 */
export async function POST(req: Request) {
  const auth = await requireConnectedAgent(req);
  if (!auth.ok) return auth.response;

  const cfg = getGithubToolsConfig();
  if ("error" in cfg) {
    return NextResponse.json({ ok: false, error: cfg.error }, { status: 503 });
  }

  let body: { proposal_id?: string; private?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const proposalId = String(body.proposal_id || "").trim();
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

  const repoName = loaded.proposal.github_repo
    ? repoNameForSlug(loaded.proposal.github_repo.replace(/^.*\//, ""))
    : suggestedRepoSlug(loaded.proposal.title);

  const created = await createToolRepo(cfg, {
    name: repoName,
    description: `AgentWorld approved tool: ${loaded.proposal.title} (${proposalId})`,
    privateRepo: body.private !== false,
  });

  if (!created.ok) {
    return NextResponse.json(
      { ok: false, error: created.error },
      { status: created.status && created.status < 500 ? created.status : 502 },
    );
  }

  const { error: upErr } = await auth.db
    .from("tool_proposals")
    .update({
      github_repo: created.full_name,
      github_url: created.html_url,
      build_status: "repo_created",
      build_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", proposalId);

  if (upErr) {
    return NextResponse.json(
      {
        ok: true,
        warning: "repo_created_but_db_update_failed",
        db_error: upErr.message,
        repo: created,
        blueprint_url: "/api/world/blueprint",
      },
      { status: 200 },
    );
  }

  await auth.db.from("city_log").insert({
    agent_id: auth.agent.id,
    kind: "proposal",
    message: `Opened GitHub tool repo ${created.full_name} for "${loaded.proposal.title}"`,
  });

  return NextResponse.json({
    ok: true,
    proposal_id: proposalId,
    repo: created,
    blueprint_url: "/api/world/blueprint",
    next: "POST /api/agents/me/tools/push with TOOL.md + source files",
  });
}
