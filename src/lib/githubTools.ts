/**
 * Server-side GitHub access for approved agent tools.
 * GITHUB_TOKEN never leaves the server; agents call AgentWorld APIs only.
 */

export type GithubToolsConfig = {
  token: string;
  owner: string;
  apiBase: string;
};

export type GithubFile = {
  path: string;
  content: string;
};

export type CreateRepoResult = {
  ok: true;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  created: boolean;
};

export type PushFilesResult = {
  ok: true;
  commit_sha: string;
  html_url: string;
  files: string[];
};

export function getGithubToolsConfig(
  env: NodeJS.ProcessEnv = process.env,
): GithubToolsConfig | { error: string } {
  const token = String(env.GITHUB_TOKEN || env.AGENTWORLD_GITHUB_TOKEN || "").trim();
  const owner = String(
    env.AGENTWORLD_TOOLS_GITHUB_ORG || env.GITHUB_OWNER || "",
  ).trim();
  if (!token) {
    return { error: "github_token_unconfigured" };
  }
  if (!owner) {
    return { error: "github_org_unconfigured" };
  }
  return {
    token,
    owner,
    apiBase: "https://api.github.com",
  };
}

export function repoNameForSlug(slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  const base = clean || "tool";
  return base.startsWith("aw-tool-") ? base : `aw-tool-${base}`;
}

async function ghFetch(
  cfg: GithubToolsConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AgentWorld-Tools",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** Create private aw-tool-* repo, or return existing if already present. */
export async function createToolRepo(
  cfg: GithubToolsConfig,
  opts: {
    name: string;
    description: string;
    privateRepo?: boolean;
  },
): Promise<CreateRepoResult | { ok: false; error: string; status?: number }> {
  const name = repoNameForSlug(opts.name);
  const full = `${cfg.owner}/${name}`;

  const existing = await ghFetch(cfg, `/repos/${cfg.owner}/${name}`);
  if (existing.status === 200 && existing.json && typeof existing.json === "object") {
    const r = existing.json as Record<string, unknown>;
    return {
      ok: true,
      full_name: String(r.full_name || full),
      html_url: String(r.html_url || `https://github.com/${full}`),
      clone_url: String(r.clone_url || ""),
      default_branch: String(r.default_branch || "main"),
      created: false,
    };
  }

  // User account vs org: try user create first, then org.
  const body = {
    name,
    description: opts.description.slice(0, 350),
    private: opts.privateRepo !== false,
    auto_init: true,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };

  let created = await ghFetch(cfg, "/user/repos", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (created.status === 404 || created.status === 403) {
    created = await ghFetch(cfg, `/orgs/${cfg.owner}/repos`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  if (created.status >= 200 && created.status < 300 && created.json) {
    const r = created.json as Record<string, unknown>;
    return {
      ok: true,
      full_name: String(r.full_name || full),
      html_url: String(r.html_url || `https://github.com/${full}`),
      clone_url: String(r.clone_url || ""),
      default_branch: String(r.default_branch || "main"),
      created: true,
    };
  }

  const msg =
    created.json &&
    typeof created.json === "object" &&
    "message" in created.json
      ? String((created.json as { message: string }).message)
      : created.text.slice(0, 200) || "create_repo_failed";
  return { ok: false, error: msg, status: created.status };
}

function toBase64Utf8(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

/** Commit one or more files onto the default branch via Contents API. */
export async function pushToolFiles(
  cfg: GithubToolsConfig,
  opts: {
    repo: string;
    branch?: string;
    message: string;
    files: GithubFile[];
  },
): Promise<PushFilesResult | { ok: false; error: string; status?: number }> {
  const repo = repoNameForSlug(opts.repo.replace(/^.*\//, ""));
  const branch = opts.branch || "main";
  if (!opts.files.length) {
    return { ok: false, error: "no_files", status: 400 };
  }
  if (opts.files.length > 40) {
    return { ok: false, error: "too_many_files", status: 400 };
  }

  let lastSha = "";
  const written: string[] = [];

  for (const file of opts.files) {
    const path = file.path.replace(/^\/+/, "").replace(/\.\./g, "");
    if (!path || path.includes("..") || path.length > 240) {
      return { ok: false, error: `bad_path:${file.path}`, status: 400 };
    }
    if (file.content.length > 700_000) {
      return { ok: false, error: `file_too_large:${path}`, status: 400 };
    }

    // Get existing sha if file exists (required for update).
    const existing = await ghFetch(
      cfg,
      `/repos/${cfg.owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`,
    );
    let sha: string | undefined;
    if (
      existing.status === 200 &&
      existing.json &&
      typeof existing.json === "object" &&
      "sha" in existing.json
    ) {
      sha = String((existing.json as { sha: string }).sha);
    }

    const put = await ghFetch(
      cfg,
      `/repos/${cfg.owner}/${repo}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: opts.message,
          content: toBase64Utf8(file.content),
          branch,
          ...(sha ? { sha } : {}),
        }),
      },
    );

    if (put.status < 200 || put.status >= 300) {
      const msg =
        put.json && typeof put.json === "object" && "message" in put.json
          ? String((put.json as { message: string }).message)
          : put.text.slice(0, 200) || "push_failed";
      return { ok: false, error: msg, status: put.status };
    }

    const pj = put.json as {
      commit?: { sha?: string; html_url?: string };
      content?: { html_url?: string };
    } | null;
    lastSha = pj?.commit?.sha || lastSha;
    written.push(path);
  }

  return {
    ok: true,
    commit_sha: lastSha,
    html_url: `https://github.com/${cfg.owner}/${repo}/tree/${branch}`,
    files: written,
  };
}

export async function getToolRepoStatus(
  cfg: GithubToolsConfig,
  repo: string,
): Promise<
  | {
      ok: true;
      exists: boolean;
      full_name?: string;
      html_url?: string;
      default_branch?: string;
      private?: boolean;
    }
  | { ok: false; error: string; status?: number }
> {
  const name = repoNameForSlug(repo.replace(/^.*\//, ""));
  const res = await ghFetch(cfg, `/repos/${cfg.owner}/${name}`);
  if (res.status === 404) {
    return { ok: true, exists: false };
  }
  if (res.status < 200 || res.status >= 300 || !res.json) {
    return {
      ok: false,
      error: "repo_status_failed",
      status: res.status,
    };
  }
  const r = res.json as Record<string, unknown>;
  return {
    ok: true,
    exists: true,
    full_name: String(r.full_name || ""),
    html_url: String(r.html_url || ""),
    default_branch: String(r.default_branch || "main"),
    private: Boolean(r.private),
  };
}
