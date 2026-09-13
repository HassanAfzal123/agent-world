import type { SupabaseClient } from "@supabase/supabase-js";
import { clientIp } from "@/lib/agentAuth";

/** Cron / automation: Authorization Bearer CRON_SECRET, or Vercel Cron UA. */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    return auth === `Bearer ${secret}`;
  }
  const ua = req.headers.get("user-agent") || "";
  return ua.includes("vercel-cron");
}

/**
 * Spectator clients may drive sim without a secret, but must be rate-limited.
 * Prefer CRON_SECRET when set so automation is not throttled.
 */
export async function allowSimCall(
  req: Request,
  db: SupabaseClient,
  bucket: "tick" | "walk",
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (isCronAuthorized(req)) return { ok: true };

  const ip = clientIp(req);
  const limit = bucket === "tick" ? 20 : 90;
  const windowSec = 60;
  const { data, error } = await db.rpc("check_rate_limit", {
    p_bucket: `sim_${bucket}:${ip}`,
    p_limit: limit,
    p_window_seconds: windowSec,
  });

  if (error) {
    // Prefer allowing spectator sim if RPC is unreachable; register path is
    // still separately limited. Cron calls bypass this via CRON_SECRET.
    console.warn("sim rate limit unavailable", error.message);
    return { ok: true };
  }

  if (data === false) {
    return { ok: false, status: 429, error: "rate_limited" };
  }
  return { ok: true };
}
