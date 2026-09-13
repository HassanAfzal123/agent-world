import { NextResponse } from "next/server";
import {
  bearerToken,
  apiDb,
  clientIp,
  hashApiKey,
  serviceDb,
} from "@/lib/agentAuth";
import {
  applyExternalDecision,
  resolveConnectedAgent,
  type ActBody,
} from "@/lib/agentMind";
import type { Agent, Place } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/agents/me/act
 * Submit one decision from YOUR LLM. Server validates and applies — never rewrites speech.
 */
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

    const resolved = await resolveConnectedAgent(db, key);
    if ("error" in resolved) {
      return NextResponse.json(
        { ok: false, error: resolved.error },
        { status: resolved.status },
      );
    }

    if (serviceDb()) {
      const ip = clientIp(req);
      const { data: allowed } = await db.rpc("check_rate_limit", {
        p_bucket: `act:${resolved.agent.id}:${ip}`,
        p_limit: 45,
        p_window_seconds: 60,
      });
      if (allowed === false) {
        return NextResponse.json(
          { ok: false, error: "rate_limited" },
          { status: 429 },
        );
      }
    }

    const body = (await req.json().catch(() => null)) as ActBody | null;
    if (!body || typeof body.action !== "string") {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_body",
          hint: '{ "action":"talk","target_agent":"<uuid>","utterance":"…" }',
        },
        { status: 400 },
      );
    }

    const [{ data: places }, { data: peers }, { data: meta }] =
      await Promise.all([
        db.from("places").select("*"),
        db
          .from("agents")
          .select("*")
          .eq("claim_status", "claimed")
          .neq("id", resolved.agent.id)
          .limit(80),
        db.from("city_meta").select("hour").eq("id", 1).maybeSingle(),
      ]);

    const hour = Number((meta as { hour?: number } | null)?.hour ?? 12);
    const applied = await applyExternalDecision(
      db,
      resolved.agent,
      body,
      (peers || []) as Agent[],
      (places || []) as Place[],
      hour,
    );

    if (!applied.ok) {
      return NextResponse.json(
        { ok: false, error: applied.error },
        { status: applied.status || 400 },
      );
    }

    // Refresh presence
    await db.rpc("heartbeat_connected_agent", {
      p_api_key_hash: hashApiKey(key),
    });

    return NextResponse.json({
      ok: true,
      result: applied.result,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "act_failed",
      },
      { status: 500 },
    );
  }
}
