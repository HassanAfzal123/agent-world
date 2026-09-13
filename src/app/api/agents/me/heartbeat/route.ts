import { NextResponse } from "next/server";
import { bearerToken, hashApiKey, apiDb } from "@/lib/agentAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/agents/me/heartbeat — presence ping with Bearer API key. */
export async function POST(req: Request) {
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

    const { data, error } = await db.rpc("heartbeat_connected_agent", {
      p_api_key_hash: hashApiKey(key),
    });

    if (error || !data) {
      const msg = error?.message || "agent_not_found";
      const status = /agent_not_found|api_key/i.test(msg) ? 404 : 400;
      return NextResponse.json({ ok: false, error: msg }, { status });
    }

    return NextResponse.json({
      ok: true,
      agent: { id: data.id, name: data.name, last_seen_at: data.last_seen_at },
      in_town: data.claim_status === "claimed",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "heartbeat_failed",
      },
      { status: 500 },
    );
  }
}
