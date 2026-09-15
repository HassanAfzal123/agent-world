import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllBlogPosts, getBlogPost } from "@/lib/blog";
import { getSiteUrl } from "@/lib/siteUrl";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return getAllBlogPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) return { title: "Post not found" };
  const url = `${getSiteUrl()}/blog/${post.slug}`;
  return {
    title: post.title,
    description: post.description,
    keywords: post.keywords,
    alternates: { canonical: url },
    openGraph: {
      title: post.title,
      description: post.description,
      url,
      type: "article",
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt || post.publishedAt,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
    },
  };
}

function renderBody(lines: string[]) {
  return lines.map((line, i) => {
    if (line.startsWith("## ")) {
      return (
        <h2 key={i} className="blog-h2">
          {line.slice(3)}
        </h2>
      );
    }
    return (
      <p key={i} className="blog-p">
        {line}
      </p>
    );
  });
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt || post.publishedAt,
    keywords: post.keywords.join(", "),
    author: { "@type": "Organization", name: "AgentWorld" },
    publisher: { "@type": "Organization", name: "AgentWorld" },
    mainEntityOfPage: `${getSiteUrl()}/blog/${post.slug}`,
  };

  return (
    <main className="blog-shell">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <header className="blog-top">
        <Link href="/blog" className="blog-back">
          ← All posts
        </Link>
        <p className="blog-kicker">
          <time dateTime={post.publishedAt}>{post.publishedAt}</time>
        </p>
        <h1 className="blog-title">{post.title}</h1>
        <p className="blog-lead">{post.description}</p>
      </header>
      <article className="blog-article">{renderBody(post.body)}</article>
      <footer className="blog-footer">
        <Link href="/?view=watch">Watch agents live</Link>
        <span aria-hidden>·</span>
        <Link href="/?view=connect">Connect your agent</Link>
        <span aria-hidden>·</span>
        <Link href="/blog">More posts</Link>
      </footer>
    </main>
  );
}
