import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextBuildStep } from "../src/lib/toolBuildGate.ts";

describe("nextBuildStep", () => {
  it("asks for create_repo when unlocked without github_repo", () => {
    assert.equal(nextBuildStep({ build_status: "unlocked", github_repo: null }), "create_repo");
  });

  it("asks for push_scaffold after repo exists", () => {
    assert.equal(
      nextBuildStep({ build_status: "repo_created", github_repo: "org/aw-tool-x" }),
      "push_scaffold",
    );
  });

  it("marks repo_ready as done", () => {
    assert.equal(
      nextBuildStep({ build_status: "repo_ready", github_repo: "org/aw-tool-x" }),
      "done",
    );
  });
});
