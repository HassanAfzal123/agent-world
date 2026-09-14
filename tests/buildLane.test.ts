import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertCanStartBuild,
  buildLaneAfterDecision,
  createBuildBrief,
  validateToolManifest,
} from "../src/lib/buildLane.ts";

const baseProposal = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Plaza Rotation Tool",
  body: "A".repeat(420),
  filed_by: "agent-1",
  filed_by_name: "Brief",
  participant_ids: ["agent-2", "agent-3"],
};

describe("buildLane after admin decision", () => {
  it("maps decisions to lane states", () => {
    assert.equal(buildLaneAfterDecision("approved"), "unlocked");
    assert.equal(buildLaneAfterDecision("rejected"), "closed_rejected");
    assert.equal(buildLaneAfterDecision("changes_requested"), "closed_changes");
  });

  it("keeps pending proposals locked", () => {
    const brief = createBuildBrief({ ...baseProposal, status: "pending" });
    assert.equal(brief.status, "locked");
    assert.ok(brief.instructions.some((i) => /Wait for human/i.test(i)));
    assert.equal(assertCanStartBuild(brief.status), false);
  });

  it("unlocks build on approve with blueprint + suggested repo", () => {
    const brief = createBuildBrief(
      { ...baseProposal, status: "approved" },
      { githubOrg: "agentworld-tools" },
    );
    assert.equal(brief.status, "unlocked");
    assert.equal(assertCanStartBuild(brief.status), true);
    assert.match(brief.github.suggested_repo, /agentworld-tools\/aw-tool-plaza/);
    assert.match(brief.blueprint_markdown, /AgentWorld Blueprint/);
    assert.ok(brief.instructions.some((i) => /APPROVED/i.test(i)));
    assert.ok(brief.forbidden.some((f) => /source/i.test(f)));
    assert.match(brief.town_notice, /APPROVED/);
  });

  it("rejects build on reject", () => {
    const brief = createBuildBrief({
      ...baseProposal,
      status: "rejected",
      decision_note: "Too vague",
    });
    assert.equal(brief.status, "closed_rejected");
    assert.equal(assertCanStartBuild(brief.status), false);
    assert.ok(brief.instructions.some((i) => /Too vague/i.test(i)));
  });

  it("locks build when changes requested", () => {
    const brief = createBuildBrief({
      ...baseProposal,
      status: "changes_requested",
      decision_note: "Add risks section",
    });
    assert.equal(brief.status, "closed_changes");
    assert.ok(brief.instructions.some((i) => /revise/i.test(i)));
  });
});

describe("validateToolManifest", () => {
  it("accepts a complete standalone tool manifest", () => {
    const r = validateToolManifest({
      name: "plaza-rotation",
      problem: "Plaza upkeep drifts",
      capability_hook: "schedule_job",
      interface_summary: "cron hint + pure rotate(roles)",
      requests_agentworld_source: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("rejects manifests that demand AgentWorld source", () => {
    const r = validateToolManifest({
      name: "x",
      problem: "y",
      capability_hook: "place_action",
      interface_summary: "z",
      requests_agentworld_source: true,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /source/i.test(e)));
  });

  it("rejects bad capability hooks", () => {
    const r = validateToolManifest({
      name: "x",
      problem: "y",
      capability_hook: "hack_core",
      interface_summary: "z",
    });
    assert.equal(r.ok, false);
  });
});
