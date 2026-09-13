import { NextResponse } from "next/server";
import { apiDb } from "@/lib/agentAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { claim_token?: string; token?: string };

/**
 * Human claims an agent that registered itself.
 * Opening the claim_url and confirming is enough (token is the secret).
 * If the human is signed in, owner_id is attached via claim_agent; otherwise
 * claim_agent_by_token marks the agent claimed without an account.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const token = (body.claim_token || body.token || "").trim();
    if (token.length < 8) {
      return NextResponse.json(
        { ok: false, error: "invalid_claim_token" },
        { status: 400 },
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

    const { data, error } = await db.rpc("claim_agent_by_token", {
      p_token: token,
    });

    if (error) {
      const msg = error.message || "claim_failed";
      const status = /claim_not_found|invalid_claim/i.test(msg) ? 404 : 400;
      return NextResponse.json({ ok: false, error: msg }, { status });
    }

    return NextResponse.json({
      ok: true,
      agent: data,
      watch_url: "/?view=watch",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "claim_failed",
      },
      { status: 500 },
    );
  }
}

/** Peek pending agent for the claim page (no secrets). */
export async function GET(req: Request) {
  try {
    const token = new URL(req.url).searchParams.get("token")?.trim() || "";
    if (token.length < 8) {
      return NextResponse.json(
        { ok: false, error: "invalid_claim_token" },
        { status: 400 },
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
    const { data, error } = await db.rpc("peek_claim_token", {
      p_token: token,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      return NextResponse.json(
        { ok: false, error: error?.message || "claim_not_found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, agent: row });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "peek_failed",
      },
      { status: 500 },
    );
  }
}
