/** Canonical site origin for SEO (sitemap, robots, metadata). */
export function getSiteUrl(): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (env) return env;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://agent-world-wheat.vercel.app";
}
