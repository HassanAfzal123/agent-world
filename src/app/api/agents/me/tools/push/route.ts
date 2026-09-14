import { NextResponse } from "next/server";
import { requireConnectedAgent } from "@/lib/agentToolsAuth";
import {
  getGithubToolsConfig,
  pushToolFiles,
  repoNameForSlug,
  type GithubFile,
} from "@/lib/githubTools";
import {
  assertSafeToolPaths,
  loadApprovedProposalForAgent,
  suggestedRepoSlug,
} from "@/lib/toolBuildGate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/agents/me/tools/push
 * Body: {
 *   proposal_id: uuid,
 *   message?: string,
 *   files: [{ path, content }, ...]
 * }
 */
export async function POST(req: Request) {
  const auth = await requireConnectedAgent(req);
  if (!auth.ok) return auth.response;

  const cfg = getGithubToolsConfig();
  if ("error" in cfg) {
    return NextResponse.json({ ok: false, error: cfg.error }, { status: 503 });
  }

  let body: {
    proposal_id?: string;
    message?: string;
    files?: GithubFile[];
  } = {};
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

  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) {
    return NextResponse.json({ ok: false, error: "files_required" }, { status: 400 });
  }

  const bad = assertSafeToolPaths(files.map((f) => String(f.path || "")));
  if (bad) {
    return NextResponse.json({ ok: false, error: bad }, { status: 400 });
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

  // Ensure repo exists first if never created.
  if (!loaded.proposal.github_repo) {
    return NextResponse.json(
      {
        ok: false,
        error: "repo_not_created",
        hint: "POST /api/agents/me/tools/create-repo first",
      },
      { status: 400 },
    );
  }

  await auth.db
    .from("tool_proposals")
    .update({
      build_status: "pushing",
      build_updated_at: new Date().toISOString(),
    })
    .eq("id", proposalId);

  const pushed = await pushToolFiles(cfg, {
    repo: repoName,
    message:
      String(body.message || "").trim() ||
      `AgentWorld tool update by ${auth.agent.name}`,
    files: files.map((f) => ({
      path: String(f.path),
      content: String(f.content ?? ""),
    })),
  });

  if (!pushed.ok) {
    return NextResponse.json(
      { ok: false, error: pushed.error },
      { status: pushed.status && pushed.status < 500 ? pushed.status : 502 },
    );
  }

  await auth.db
    .from("tool_proposals")
    .update({
      build_status: "repo_ready",
      build_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", proposalId);

  await auth.db.from("city_log").insert({
    agent_id: auth.agent.id,
    kind: "proposal",
    message: `Pushed ${pushed.files.length} file(s) to ${loaded.proposal.github_repo}`,
  });

  return NextResponse.json({
    ok: true,
    proposal_id: proposalId,
    push: pushed,
    github_url: loaded.proposal.github_url,
  });
}
