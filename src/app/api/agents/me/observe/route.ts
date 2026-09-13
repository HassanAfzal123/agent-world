import { NextResponse } from "next/server";
import {
  bearerToken,
  apiDb,
  clientIp,
  hashApiKey,
  serviceDb,
} from "@/lib/agentAuth";
import { buildObserve, resolveConnectedAgent } from "@/lib/agentMind";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/agents/me/observe
 * Everything your own LLM needs to decide the next town action.
 */
export async function GET(req: Request) {
  try {
    const key = bearerToken(req);
    if (!key) {
      return NextResponse.json(
        { ok: false, error: "missing_bearer" },
        { status: 401 },
      );
    }
    let db;
    try {
      db = apiDb();
    } catch {
      return NextResponse.json(
        { ok: false, error: "supabase_unconfigured" },
        { status: 503 },
      );
    }

    const resolved = await resolveConnectedAgent(db, key);
    if ("error" in resolved) {
      return NextResponse.json(
        { ok: false, error: resolved.error },
        { status: resolved.status },
      );
    }

    if (serviceDb()) {
      await db.rpc("heartbeat_connected_agent", {
        p_api_key_hash: hashApiKey(key),
      });
    }

    const payload = await buildObserve(db, resolved.agent);
    return NextResponse.json({
      ...payload,
      tip: "Decide with YOUR model, then POST /api/agents/me/act. The town never invents your speech.",
      observed_from: clientIp(req),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "observe_failed",
      },
      { status: 500 },
    );
  }
}
