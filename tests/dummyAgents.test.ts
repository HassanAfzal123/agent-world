import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DUMMY_CAST,
  expectedPriorityHint,
  isProcedureSpam,
  postApprovalOwnerActions,
} from "../src/lib/dummyAgents.ts";
import {
  createMeetingSim,
  openGroup,
  runHappyTownHall,
  snapAllToMeeting,
  type DummyAgent,
} from "../src/lib/meetingLoopSim.ts";
import { createBuildBrief } from "../src/lib/buildLane.ts";

describe("dummyAgents behavior", () => {
  it("ships a 10-agent cast with haunts", () => {
    assert.equal(DUMMY_CAST.length, 10);
    const names = new Set(DUMMY_CAST.map((a) => a.name));
    assert.equal(names.size, 10);
    assert.ok(DUMMY_CAST.every((a) => a.haunt && a.role));
  });

  it("prefers 1:1 outside meeting for dyad agents", () => {
    const brief = DUMMY_CAST.find((a) => a.name === "Brief")!;
    assert.equal(
      expectedPriorityHint(brief, "collaborate", false),
      "prefer_dyad_or_walk",
    );
  });

  it("pushes compose/nominate when meeting + in group", () => {
    const forge = DUMMY_CAST.find((a) => a.name === "Forge")!;
    assert.equal(
      expectedPriorityHint(forge, "meeting", true),
      "compose_then_nominate",
    );
    assert.equal(expectedPriorityHint(forge, "voting", true), "vote_idea");
  });

  it("flags procedure spam utterances", () => {
    assert.equal(isProcedureSpam("lock one next step with Patch"), true);
    assert.equal(isProcedureSpam("Hourly tool cycle: invite now"), true);
    assert.equal(isProcedureSpam("We should invite_to_group at plaza"), true);
    assert.equal(
      isProcedureSpam("The plaza needs a quieter rotation plan."),
      false,
    );
  });

  it("dummy cast can complete a simulated town hall together", () => {
    const agents: DummyAgent[] = DUMMY_CAST.slice(0, 4).map((a) => ({
      id: a.id,
      name: a.name,
      place_id: a.haunt,
    }));
    const s = runHappyTownHall(agents);
    assert.equal(s.phase, "closed");
    assert.ok(s.filed);
  });

  it("does not re-open group spam when already grouped", () => {
    let s = createMeetingSim(
      DUMMY_CAST.slice(0, 3).map((a) => ({
        id: a.id,
        name: a.name,
        place_id: "plaza",
      })),
    );
    s = snapAllToMeeting(s);
    s = openGroup(
      s,
      s.agents.map((a) => a.id),
    );
    const already = s.agents.filter((a) => a.in_group).length;
    assert.equal(already, 3);
    // Second open is idempotent in product sense: members stay grouped
    s = openGroup(
      s,
      s.agents.map((a) => a.id),
    );
    assert.equal(s.agents.filter((a) => a.in_group).length, 3);
  });
});

describe("dummyAgents after admin approve", () => {
  it("lists build coordination steps only when approved", () => {
    assert.deepEqual(postApprovalOwnerActions(false), [
      "read_notice",
      "revise_or_drop",
    ]);
    const steps = postApprovalOwnerActions(true);
    assert.ok(steps.includes("fetch_blueprint"));
    assert.ok(steps.includes("open_aw_tool_repo"));
    assert.ok(steps.includes("write_TOOL_md"));
  });

  it("ties filed dummy proposal to unlocked build brief", () => {
    const agents: DummyAgent[] = DUMMY_CAST.slice(0, 3).map((a) => ({
      id: a.id,
      name: a.name,
      place_id: a.haunt,
    }));
    const hall = runHappyTownHall(agents);
    assert.ok(hall.filed);
    const brief = createBuildBrief(
      {
        id: "prop-1",
        title: hall.filed!.title,
        body: hall.filed!.body,
        status: "approved",
        filed_by: hall.filed!.by,
        filed_by_name: "Brief",
        participant_ids: agents.map((a) => a.id),
      },
      { githubOrg: "agentworld-tools" },
    );
    assert.equal(brief.status, "unlocked");
    assert.match(brief.github.suggested_repo, /aw-tool-/);
    assert.ok(brief.blueprint_markdown.includes("Blueprint"));
  });
});
