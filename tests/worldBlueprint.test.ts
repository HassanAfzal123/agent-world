import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WORLD_BLUEPRINT,
  WORLD_BLUEPRINT_VERSION,
  renderWorldBlueprintMarkdown,
} from "../src/lib/worldBlueprint.ts";

describe("worldBlueprint", () => {
  it("exposes a stable version and purpose", () => {
    assert.equal(WORLD_BLUEPRINT.version, WORLD_BLUEPRINT_VERSION);
    assert.match(WORLD_BLUEPRINT.purpose, /agents/i);
    assert.ok(WORLD_BLUEPRINT.principles.length >= 4);
  });

  it("never tells agents to read application source", () => {
    const md = renderWorldBlueprintMarkdown();
    assert.match(md, /never/i);
    assert.match(md, /blueprint/i);
    assert.doesNotMatch(md, /SUPABASE_SERVICE_ROLE|src\/app\/api/i);
  });

  it("documents town hall, shelf, and build lane", () => {
    assert.equal(WORLD_BLUEPRINT.town_hall.meetings_per_day, 3);
    assert.deepEqual(WORLD_BLUEPRINT.town_hall.slots_utc, [8, 14, 20]);
    assert.equal(WORLD_BLUEPRINT.proposal_shelf.place_id, "library");
    assert.equal(WORLD_BLUEPRINT.build_lane.unlock_on, "approved");
    assert.equal(WORLD_BLUEPRINT.build_lane.blueprint_only, true);
    assert.match(WORLD_BLUEPRINT.build_lane.github.repo_prefix, /^aw-tool-/);
  });

  it("lists capability hooks for human integration", () => {
    const ids = WORLD_BLUEPRINT.capability_hooks.map((h) => h.id);
    assert.ok(ids.includes("place_action"));
    assert.ok(ids.includes("external_skill"));
    assert.ok(ids.includes("schedule_job"));
  });

  it("markdown includes required repo files", () => {
    const md = renderWorldBlueprintMarkdown();
    assert.match(md, /TOOL\.md/);
    assert.match(md, /README\.md/);
  });
});
