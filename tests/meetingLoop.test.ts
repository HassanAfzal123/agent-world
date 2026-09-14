import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  composeDraft,
  createMeetingSim,
  fileWinning,
  nominate,
  openGroup,
  resolveWinner,
  runHappyTownHall,
  setPhase,
  snapAllToMeeting,
  tickGroupTalk,
  vote,
  type DummyAgent,
} from "../src/lib/meetingLoopSim.ts";

const cast: DummyAgent[] = [
  { id: "a1", name: "Brief", place_id: "cafe" },
  { id: "a2", name: "Patch", place_id: "workshop" },
  { id: "a3", name: "Forge", place_id: "inn" },
  { id: "a4", name: "Hex", place_id: "park" },
];

const LONG =
  "Problem: plaza drift.\n".repeat(15) +
  "Design: rotation tool with roles.\nRisks: invite spam.\nSuccess: one plan/day.";

describe("meetingLoopSim", () => {
  it("runs a full happy-path town hall to a filed proposal", () => {
    const s = runHappyTownHall(cast);
    assert.equal(s.phase, "closed");
    assert.ok(s.filed);
    assert.match(s.filed!.title, /Plaza/);
    assert.ok(s.filed!.body.length >= 400);
    assert.ok(s.log.includes("filed:Plaza Rotation Tool") || s.log.some((l) => l.startsWith("filed:")));
  });

  it("snaps agents to the meeting place", () => {
    let s = createMeetingSim(cast);
    s = snapAllToMeeting(s);
    assert.ok(s.agents.every((a) => a.place_id === "plaza"));
  });

  it("rejects groups smaller than 3", () => {
    let s = createMeetingSim(cast);
    s = openGroup(s, ["a1", "a2"]);
    assert.ok(s.log.includes("group_failed_need_three"));
  });

  it("blocks nominate without enough group turns", () => {
    let s = createMeetingSim(cast);
    s = snapAllToMeeting(s);
    s = openGroup(s, ["a1", "a2", "a3"]);
    s = tickGroupTalk(s);
    s = composeDraft(s, "a1", "Too Early Tool", LONG);
    s = setPhase(s, "meeting");
    const r = nominate(s, "a1");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "need_group_collab");
  });

  it("blocks short summaries", () => {
    let s = createMeetingSim(cast);
    s = snapAllToMeeting(s);
    s = openGroup(s, ["a1", "a2", "a3"]);
    for (let i = 0; i < 4; i++) s = tickGroupTalk(s);
    s = composeDraft(s, "a1", "Short Idea Title", "too short");
    s = setPhase(s, "meeting");
    const r = nominate(s, "a1");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "summary_too_short");
  });

  it("allows empty-ballot nominate in early voting", () => {
    let s = createMeetingSim(cast);
    s = snapAllToMeeting(s);
    s = openGroup(s, ["a1", "a2", "a3"]);
    for (let i = 0; i < 4; i++) s = tickGroupTalk(s);
    s = composeDraft(s, "a1", "Late Ballot Tool", LONG);
    s = setPhase(s, "voting");
    const r = nominate(s, "a1");
    assert.equal(r.ok, true);
  });

  it("rejects nominate in filing phase", () => {
    let s = createMeetingSim(cast);
    s = snapAllToMeeting(s);
    s = openGroup(s, ["a1", "a2", "a3"]);
    for (let i = 0; i < 4; i++) s = tickGroupTalk(s);
    s = composeDraft(s, "a1", "Wrong Phase Tool", LONG);
    s = setPhase(s, "filing");
    const r = nominate(s, "a1");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "nominate_wrong_phase");
  });

  it("resolves winner by vote count and requires champion at library", () => {
    let s = createMeetingSim(cast);
    s = snapAllToMeeting(s);
    s = openGroup(s, ["a1", "a2", "a3"]);
    for (let i = 0; i < 4; i++) s = tickGroupTalk(s);
    s = composeDraft(s, "a1", "Vote Winner Tool", LONG);
    s = setPhase(s, "meeting");
    const r = nominate(s, "a1");
    assert.ok(r.ok);
    s = r.state;
    s = setPhase(s, "voting");
    s = vote(s, "a1", s.nominations[0].id);
    s = vote(s, "a2", s.nominations[0].id);
    s = resolveWinner(s);
    assert.equal(s.phase, "filing");
    assert.equal(s.champion_id, "a1");
    s = fileWinning(s, "a1");
    assert.ok(s.log.includes("file_need_library"));
    s = {
      ...s,
      agents: s.agents.map((a) =>
        a.id === "a1" ? { ...a, place_id: "library" } : a,
      ),
    };
    s = fileWinning(s, "a1");
    assert.equal(s.phase, "closed");
    assert.ok(s.filed);
  });

  it("non-champion cannot file", () => {
    let s = runHappyTownHall(cast);
    // already filed; craft a mid-filing state
    s = createMeetingSim(cast);
    s = snapAllToMeeting(s);
    s = openGroup(s, ["a1", "a2", "a3"]);
    for (let i = 0; i < 4; i++) s = tickGroupTalk(s);
    s = composeDraft(s, "a1", "Champ Only", LONG);
    s = setPhase(s, "meeting");
    const r = nominate(s, "a1");
    s = r.state;
    s = setPhase(s, "voting");
    for (const a of s.agents) s = vote(s, a.id, s.nominations[0].id);
    s = resolveWinner(s);
    s = {
      ...s,
      agents: s.agents.map((a) => ({ ...a, place_id: "library" })),
    };
    s = fileWinning(s, "a2");
    assert.ok(s.log.includes("file_not_champion"));
    assert.equal(s.filed, null);
  });
});
