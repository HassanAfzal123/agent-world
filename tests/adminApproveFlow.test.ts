import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createBuildBrief,
  buildLaneAfterDecision,
} from "../src/lib/buildLane.ts";
import { runHappyTownHall, type DummyAgent } from "../src/lib/meetingLoopSim.ts";
import {
  minutesToNextMeeting,
  minutesToNextSlotMeeting,
  phaseFromSlotElapsed,
  normalizePhase,
  isTownHallLive,
  parseTownHallCycle,
} from "../src/lib/townHall.ts";

/**
 * End-to-end product story without DB:
 * dummy agents meet → file → admin decides → build lane unlocks / locks.
 */
describe("adminApproveFlow (product story)", () => {
  const cast: DummyAgent[] = [
    { id: "a1", name: "Brief", place_id: "cafe" },
    { id: "a2", name: "Merge", place_id: "docks" },
    { id: "a3", name: "Hex", place_id: "inn" },
  ];

  it("approve unlocks GitHub build brief from filed meeting output", () => {
    const hall = runHappyTownHall(cast);
    assert.ok(hall.filed);

    const pending = createBuildBrief({
      id: "p1",
      title: hall.filed!.title,
      body: hall.filed!.body,
      status: "pending",
      filed_by: hall.filed!.by,
    });
    assert.equal(pending.status, "locked");

    const decision = "approved" as const;
    assert.equal(buildLaneAfterDecision(decision), "unlocked");

    const unlocked = createBuildBrief(
      {
        id: "p1",
        title: hall.filed!.title,
        body: hall.filed!.body,
        status: decision,
        filed_by: hall.filed!.by,
        filed_by_name: "Brief",
        participant_ids: ["a1", "a2", "a3"],
      },
      { githubOrg: "agentworld-tools" },
    );

    assert.equal(unlocked.status, "unlocked");
    assert.match(unlocked.town_notice, /APPROVED/);
    assert.ok(
      unlocked.instructions.some((i) => /blueprint/i.test(i)),
      "must point agents at blueprint",
    );
    assert.ok(
      unlocked.forbidden.some((f) => /source/i.test(f)),
      "must forbid app source",
    );
    assert.match(unlocked.github.suggested_repo, /^agentworld-tools\/aw-tool-/);
  });

  it("reject and changes_requested never unlock build", () => {
    for (const decision of ["rejected", "changes_requested"] as const) {
      const brief = createBuildBrief({
        id: "p2",
        title: "Bad Idea",
        body: "x".repeat(400),
        status: decision,
        filed_by: "a1",
        decision_note: "needs work",
      });
      assert.notEqual(brief.status, "unlocked");
      assert.ok(!brief.instructions.some((i) => /^APPROVED/i.test(i)));
    }
  });
});

describe("townHall helpers", () => {
  it("normalizes phases and live windows", () => {
    assert.equal(normalizePhase("voting"), "voting");
    assert.equal(normalizePhase("weird"), "collaborate");
    assert.equal(isTownHallLive("meeting"), true);
    assert.equal(isTownHallLive("collaborate"), false);
  });

  it("legacy hourly countdown stays in range", () => {
    const m = minutesToNextMeeting(10);
    assert.ok(m > 0 && m <= 60);
  });

  it("daily slot countdown is non-negative", () => {
    assert.ok(minutesToNextSlotMeeting(new Date()) >= 0);
  });

  it("slot elapsed maps to phases", () => {
    assert.equal(phaseFromSlotElapsed(5), "meeting");
    assert.equal(phaseFromSlotElapsed(14), "voting");
    assert.equal(phaseFromSlotElapsed(20), "filing");
    assert.equal(phaseFromSlotElapsed(45), "closed");
  });

  it("parses spectator cycle payloads", () => {
    const c = parseTownHallCycle({
      ok: true,
      phase: "voting",
      utc_minute: 48,
      nominations: [
        {
          id: "n1",
          title: "Weather Tool",
          agent_id: "a1",
          agent_name: "Scout",
          vote_count: 2,
        },
      ],
      winning_nomination_id: null,
    });
    assert.ok(c);
    assert.equal(c!.nominations.length, 1);
    assert.equal(c!.phase, "voting");
  });
});
