import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getGithubToolsConfig,
  repoNameForSlug,
} from "../src/lib/githubTools.ts";
import {
  agentMayBuild,
  assertSafeToolPaths,
  suggestedRepoSlug,
} from "../src/lib/toolBuildGate.ts";

describe("githubTools config", () => {
  it("requires token and owner", () => {
    const a = getGithubToolsConfig({});
    assert.ok("error" in a);

    const b = getGithubToolsConfig({ GITHUB_TOKEN: "ghp_x" } as NodeJS.ProcessEnv);
    assert.ok("error" in b);
    assert.equal(b.error, "github_org_unconfigured");

    const c = getGithubToolsConfig({
      GITHUB_TOKEN: "ghp_x",
      AGENTWORLD_TOOLS_GITHUB_ORG: "my-tools",
    } as NodeJS.ProcessEnv);
    assert.ok(!("error" in c));
    assert.equal(c.owner, "my-tools");
    assert.equal(c.token, "ghp_x");
  });

  it("normalizes aw-tool repo names", () => {
    assert.equal(repoNameForSlug("plaza-rotation"), "aw-tool-plaza-rotation");
    assert.equal(repoNameForSlug("aw-tool-weather"), "aw-tool-weather");
    assert.equal(suggestedRepoSlug("Plaza Rotation Tool"), "aw-tool-plaza-rotation-tool");
  });
});

describe("toolBuildGate", () => {
  it("allows filer and participants only when approved", () => {
    const base = {
      status: "approved",
      filed_by: "a1",
      participant_ids: ["a2", "a3"],
    };
    assert.equal(agentMayBuild("a1", base).ok, true);
    assert.equal(agentMayBuild("a2", base).ok, true);
    assert.equal(agentMayBuild("a9", base).ok, false);

    assert.equal(
      agentMayBuild("a1", { ...base, status: "pending" }).ok,
      false,
    );
  });

  it("blocks path traversal and AgentWorld source trees", () => {
    assert.equal(assertSafeToolPaths(["TOOL.md", "src/index.ts"]), null);
    assert.match(String(assertSafeToolPaths(["../secrets"])), /bad_path/);
    assert.match(String(assertSafeToolPaths(["src/app/page.tsx"])), /forbidden/);
    assert.match(String(assertSafeToolPaths([".env"])), /forbidden/);
  });
});
