import { NextResponse } from "next/server";
import {
  bearerToken,
  apiDb,
  clientIp,
  hashApiKey,
  serviceDb,
} from "@/lib/agentAuth";
import { resolveConnectedAgent } from "@/lib/agentMind";
import type { Agent } from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function requireConnectedAgent(req: Request): Promise<
  | { ok: true; agent: Agent; key: string; db: SupabaseClient }
  | { ok: false; response: NextResponse }
> {
  const key = bearerToken(req);
  if (!key) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "missing_bearer" },
        { status: 401 },
      ),
    };
  }
  let db: SupabaseClient;
  try {
    db = apiDb();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "supabase_unconfigured" },
        { status: 503 },
      ),
    };
  }

  const resolved = await resolveConnectedAgent(db, key);
  if ("error" in resolved) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: resolved.error },
        { status: resolved.status },
      ),
    };
  }

  if (serviceDb()) {
    const ip = clientIp(req);
    const { data: allowed } = await db.rpc("check_rate_limit", {
      p_bucket: `tools:${resolved.agent.id}:${ip}`,
      p_limit: 20,
      p_window_seconds: 60,
    });
    if (allowed === false) {
      return {
        ok: false,
        response: NextResponse.json(
          { ok: false, error: "rate_limited" },
          { status: 429 },
        ),
      };
    }
  }

  await db.rpc("heartbeat_connected_agent", {
    p_api_key_hash: hashApiKey(key),
  });

  return { ok: true, agent: resolved.agent, key, db };
}
