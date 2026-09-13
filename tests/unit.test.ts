import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bearerToken,
  clientIp,
  hashApiKey,
  mintApiKey,
  mintClaimToken,
} from "../src/lib/agentAuth.ts";
import { createAgentLook, resolveAgentLook } from "../src/lib/agentLook.ts";
import { shouldSkipThreadOpen } from "../src/lib/conversationFreshness.ts";
import type { Relationship } from "../src/lib/types.ts";

describe("agentAuth", () => {
  it("hashes api keys stably", () => {
    const a = hashApiKey("aw_test_key");
    const b = hashApiKey("aw_test_key");
    assert.equal(a, b);
    assert.equal(a.length, 64);
  });

  it("mints distinct api keys and claim tokens", () => {
    assert.match(mintApiKey(), /^aw_/);
    assert.match(mintClaimToken(), /^aw_claim_/);
    assert.notEqual(mintApiKey(), mintApiKey());
  });

  it("parses bearer tokens", () => {
    const req = new Request("http://localhost/api/agents/me", {
      headers: { Authorization: "Bearer aw_secret" },
    });
    assert.equal(bearerToken(req), "aw_secret");
    assert.equal(bearerToken(new Request("http://localhost")), null);
  });

  it("reads client ip from x-forwarded-for", () => {
    const req = new Request("http://localhost", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    assert.equal(clientIp(req), "1.2.3.4");
  });
});

describe("agentLook", () => {
  it("never produces undefined titles", () => {
    for (let i = 0; i < 50; i++) {
      const look = createAgentLook({
        name: `Agent${i}`,
        personality: "curious builder",
        seed: 3_000_000_000 + i * 97_331,
      });
      assert.doesNotMatch(look.title, /undefined|null/i);
      assert.ok(look.title.split(" ").length >= 2);
    }
  });

  it("repairs broken persisted titles", () => {
    const fixed = resolveAgentLook({
      id: "00000000-0000-0000-0000-000000000001",
      name: "Merge",
      look: {
        title: "Lantern undefined",
        body: "robe",
        head: "round",
        hat: "visor",
        gear: "none",
        held: "none",
        accent: "#8ecae6",
        trim: "#22223b",
        seed: 1,
      },
    });
    assert.doesNotMatch(fixed.title, /undefined/i);
  });
});

describe("conversationFreshness", () => {
  it("skips generic ask openers", () => {
    const rels: Relationship[] = [];
    const skip = shouldSkipThreadOpen(
      "a1",
      "a2",
      "fresh_topic",
      "What method are you using that I have not tried?",
      rels,
    );
    assert.equal(skip, true);
  });
});
