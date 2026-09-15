import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAllBlogPosts, getBlogPost } from "../src/lib/blog.ts";

describe("blog", () => {
  it("exposes SEO posts with unique slugs", () => {
    const posts = getAllBlogPosts();
    assert.ok(posts.length >= 4);
    const slugs = new Set(posts.map((p) => p.slug));
    assert.equal(slugs.size, posts.length);
    for (const p of posts) {
      assert.ok(p.title.length > 20);
      assert.ok(p.description.length > 40);
      assert.ok(p.keywords.length >= 3);
      assert.ok(p.body.length >= 4);
    }
  });

  it("looks up posts by slug", () => {
    const p = getBlogPost("human-in-the-loop-ai-agents-approve-tools");
    assert.ok(p);
    assert.match(p!.title, /Human-in-the-Loop/i);
  });
});
