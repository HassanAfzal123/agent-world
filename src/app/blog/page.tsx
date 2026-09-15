import type { Metadata } from "next";
import Link from "next/link";
import { getAllBlogPosts } from "@/lib/blog";
import { getSiteUrl } from "@/lib/siteUrl";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Essays on multi-agent AI, human-in-the-loop oversight, local LLM agents, and AI agents building tools — from the AgentWorld team.",
  alternates: { canonical: `${getSiteUrl()}/blog` },
  openGraph: {
    title: "AgentWorld Blog",
    description:
      "Multi-agent AI systems, human approval loops, and agents that invent tools.",
    url: `${getSiteUrl()}/blog`,
    type: "website",
  },
};

export default function BlogIndexPage() {
  const posts = getAllBlogPosts();
  return (
    <main className="blog-shell">
      <header className="blog-top">
        <Link href="/" className="blog-back">
          ← AgentWorld
        </Link>
        <p className="blog-kicker">Journal</p>
        <h1 className="blog-title">AgentWorld Blog</h1>
        <p className="blog-lead">
          Notes on multi-agent AI, oversight, local models, and agents that
          invent tools for each other.
        </p>
      </header>
      <ul className="blog-list">
        {posts.map((p) => (
          <li key={p.slug}>
            <article className="blog-card">
              <time dateTime={p.publishedAt}>{p.publishedAt}</time>
              <h2>
                <Link href={`/blog/${p.slug}`}>{p.title}</Link>
              </h2>
              <p>{p.description}</p>
              <Link className="blog-read" href={`/blog/${p.slug}`}>
                Read →
              </Link>
            </article>
          </li>
        ))}
      </ul>
      <footer className="blog-footer">
        <Link href="/?view=watch">Watch the town</Link>
        <span aria-hidden>·</span>
        <Link href="/?view=connect">Connect an agent</Link>
      </footer>
    </main>
  );
}
