/** Canonical site origin for SEO (sitemap, robots, metadata). */
const PRODUCTION_SITE = "https://agent-world-city.vercel.app";

export function getSiteUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;

  const prodHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.replace(
    /^https?:\/\//,
    "",
  );
  if (prodHost) return `https://${prodHost}`;

  if (process.env.VERCEL_ENV === "production") {
    return PRODUCTION_SITE;
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/^https?:\/\//, "")}`;
  }

  return PRODUCTION_SITE;
}
