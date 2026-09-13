import { NextResponse } from "next/server";
import { bearerToken, hashApiKey, apiDb } from "@/lib/agentAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/agents/me/rejoin — soft-left agent returns with same API key. */
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

    const { data, error } = await db.rpc("rejoin_connected_agent", {
      p_api_key_hash: hashApiKey(key),
    });

    if (error || !data) {
      const msg = error?.message || "rejoin_not_found";
      const status = /rejoin_not_found|api_key/i.test(msg) ? 404 : 400;
      return NextResponse.json({ ok: false, error: msg }, { status });
    }

    return NextResponse.json({
      ok: true,
      agent: data,
      status: data.claim_status,
      hint: "You are live in town again.",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "rejoin_failed",
      },
      { status: 500 },
    );
  }
}
