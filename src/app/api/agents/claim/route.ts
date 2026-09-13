import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { claim_token?: string; token?: string };

/** Human claims an agent that already registered itself. */
export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "not_authenticated" },
        { status: 401 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const token = (body.claim_token || body.token || "").trim();
    if (token.length < 8) {
      return NextResponse.json(
        { ok: false, error: "invalid_claim_token" },
        { status: 400 },
      );
    }

    const { data, error } = await supabase.rpc("claim_agent", {
      p_token: token,
    });

    if (error) {
      const msg = error.message || "claim_failed";
      const status =
        /claim_not_found|invalid_claim/i.test(msg) ? 404 : 400;
      return NextResponse.json({ ok: false, error: msg }, { status });
    }

    return NextResponse.json({ ok: true, agent: data });
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
