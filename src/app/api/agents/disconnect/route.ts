import { NextResponse } from "next/server";
import { mintClaimToken } from "@/lib/agentAuth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  agent_id?: string;
  /** release = soft disconnect (reclaimable); delete = remove from town forever */
  mode?: "release" | "delete";
};

/**
 * Human disconnects a claimed agent from their account.
 * - release: freezes agent (pending_claim), returns a fresh claim token once
 * - delete: permanently removes the agent row (credentials cascade)
 */
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
    const agentId = (body.agent_id || "").trim();
    const mode = body.mode === "delete" ? "delete" : "release";

    if (!agentId) {
      return NextResponse.json(
        { ok: false, error: "agent_id_required" },
        { status: 400 },
      );
    }

    if (mode === "delete") {
      const { error } = await supabase.rpc("delete_owned_agent", {
        p_agent_id: agentId,
      });
      if (error) {
        const msg = error.message || "delete_failed";
        const status = /delete_not_found/i.test(msg) ? 404 : 400;
        return NextResponse.json({ ok: false, error: msg }, { status });
      }
      return NextResponse.json({ ok: true, mode: "delete", agent_id: agentId });
    }

    const claimToken = mintClaimToken();
    const { data, error } = await supabase.rpc("release_agent", {
      p_agent_id: agentId,
      p_new_claim_token: claimToken,
    });

    if (error) {
      const msg = error.message || "release_failed";
      const status = /release_not_found|credentials_missing/i.test(msg)
        ? 404
        : 400;
      return NextResponse.json({ ok: false, error: msg }, { status });
    }

    return NextResponse.json({
      ok: true,
      mode: "release",
      agent: data,
      claim_token: claimToken,
      hint: "Save this claim token to reconnect the same agent later.",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "disconnect_failed",
      },
      { status: 500 },
    );
  }
}
