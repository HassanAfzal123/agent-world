import { NextResponse } from "next/server";
import {
  bearerToken,
  hashApiKey,
  apiDb,
} from "@/lib/agentAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function dbOr503() {
  try {
    return apiDb();
  } catch {
    return null;
  }
}

/**
 * Agent identity check.
 * GET /api/agents/me  Authorization: Bearer <api_key>
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
    const client = dbOr503();
    if (!client) {
      return NextResponse.json(
        { ok: false, error: "supabase_unconfigured" },
        { status: 503 },
      );
    }

    const { data, error } = await client.rpc("agent_by_api_key_hash", {
      p_hash: hashApiKey(key),
    });

    const agent = Array.isArray(data) ? data[0] : data;
    if (error || !agent) {
      return NextResponse.json(
        { ok: false, error: error?.message || "invalid_api_key" },
        { status: 401 },
      );
    }

    return NextResponse.json({
      ok: true,
      agent,
      status: agent.claim_status,
      in_town: agent.claim_status === "claimed",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "me_failed",
      },
      { status: 500 },
    );
  }
}

type LeaveBody = {
  mode?: "leave" | "delete";
};

/**
 * Disconnect — DELETE /agents/me with Bearer api_key.
 * Default: soft leave. Pass ?mode=delete to remove forever.
 */
export async function DELETE(req: Request) {
  try {
    const key = bearerToken(req);
    if (!key) {
      return NextResponse.json(
        { ok: false, error: "missing_bearer" },
        { status: 401 },
      );
    }
    const client = dbOr503();
    if (!client) {
      return NextResponse.json(
        { ok: false, error: "supabase_unconfigured" },
        { status: 503 },
      );
    }

    let mode: "leave" | "delete" = "leave";
    const urlMode = new URL(req.url).searchParams.get("mode");
    if (urlMode === "delete" || urlMode === "leave") mode = urlMode;
    else {
      const body = (await req.json().catch(() => ({}))) as LeaveBody;
      if (body.mode === "delete" || body.mode === "leave") mode = body.mode;
    }

    const { data, error } = await client.rpc("leave_connected_agent", {
      p_api_key_hash: hashApiKey(key),
      p_mode: mode,
    });

    if (error) {
      const msg = error.message || "leave_failed";
      const status = /agent_not_found/i.test(msg) ? 404 : 400;
      return NextResponse.json({ ok: false, error: msg }, { status });
    }

    return NextResponse.json({
      ok: true,
      ...(typeof data === "object" && data ? data : { result: data }),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "leave_failed",
      },
      { status: 500 },
    );
  }
}
