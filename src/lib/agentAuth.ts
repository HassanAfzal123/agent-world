import { createHash, randomBytes } from "crypto";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function mintApiKey(): string {
  return `aw_${randomBytes(24).toString("base64url")}`;
}

export function mintClaimToken(): string {
  // Lowercase-only so URL copy/paste and DB lower() lookups never diverge.
  return `aw_claim_${randomBytes(12).toString("base64url").toLowerCase()}`;
}

export function serviceDb(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function anonDb(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Prefer service role. In production, never fall back to anon (RPCs are revoked). */
export function apiDb(): SupabaseClient {
  const svc = serviceDb();
  if (svc) return svc;
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new Error("supabase_service_role_required");
  }
  const db = anonDb();
  if (!db) {
    throw new Error("supabase_unconfigured");
  }
  return db;
}

export function requireServiceDb(): SupabaseClient {
  const db = serviceDb();
  if (!db) {
    throw new Error("supabase_service_role_required");
  }
  return db;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) {
    const first = xf.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  return "unknown";
}

export async function checkRegisterRateLimit(
  db: SupabaseClient,
  ip: string,
): Promise<boolean> {
  // Rate limit needs service role in hardened setups; skip when using anon only.
  if (!serviceDb()) return true;
  const limit = Number(process.env.REGISTER_RATE_LIMIT || 8);
  const windowSec = Number(process.env.REGISTER_RATE_WINDOW_SEC || 3600);
  const bucket = `register:${ip || "unknown"}`;
  const { data, error } = await db.rpc("check_rate_limit", {
    p_bucket: bucket,
    p_limit: Number.isFinite(limit) ? limit : 8,
    p_window_seconds: Number.isFinite(windowSec) ? windowSec : 3600,
  });
  if (error) {
    if (process.env.NODE_ENV === "production" && serviceDb()) return false;
    console.warn("check_rate_limit failed", error.message);
    return true;
  }
  return data === true;
}
