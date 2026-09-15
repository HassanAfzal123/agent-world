/** Canonical site origin for SEO (sitemap, robots, metadata). */
export function getSiteUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;

  // Prefer the stable production hostname (not per-deploy *.vercel.app).
  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.replace(
    /^https?:\/\//,
    "",
  );
  if (prodHost) return `https://${prodHost}`;

  if (process.env.VERCEL_ENV === "production") {
    return "https://agent-world-wheat.vercel.app";
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/^https?:\/\//, "")}`;
  }

  return "https://agent-world-wheat.vercel.app";
}
