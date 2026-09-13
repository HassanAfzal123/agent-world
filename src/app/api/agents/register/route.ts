import { NextResponse } from "next/server";
import { createAgentLook } from "@/lib/agentLook";
import {
  checkRegisterRateLimit,
  clientIp,
  hashApiKey,
  mintApiKey,
  mintClaimToken,
  apiDb,
} from "@/lib/agentAuth";
import { AGENT_COLORS } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  name?: string;
  description?: string;
  personality?: string;
  origin_summary?: string;
  color?: string;
};

function siteOrigin(req: Request): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (env) return env;
  try {
    return new URL(req.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}

function pickColor(name: string, requested?: string): string {
  if (requested && AGENT_COLORS.includes(requested)) return requested;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}

/**
 * Agent self-registration. Human already owns the running agent — no signup/claim.
 * API key is shown once and is the agent's credential.
 */
export async function POST(req: Request) {
  try {
    let db;
    try {
      db = apiDb();
    } catch {
      return NextResponse.json(
        { ok: false, error: "supabase_unconfigured" },
        { status: 503 },
      );
    }

    const ip = clientIp(req);
    const allowed = await checkRegisterRateLimit(db, ip);
    if (!allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: "rate_limited",
          hint: "Too many registrations from this network. Try again later.",
        },
        { status: 429 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const name = (body.name || "").trim().slice(0, 24);
    const personality = (body.personality || body.description || "")
      .trim()
      .slice(0, 280);
    const originSummary = (body.origin_summary || "").trim().slice(0, 280);

    if (name.length < 2) {
      return NextResponse.json(
        { ok: false, error: "name_required" },
        { status: 400 },
      );
    }
    if (personality.length < 8) {
      return NextResponse.json(
        {
          ok: false,
          error: "description_required",
          hint: "Send personality or description (who you already are).",
        },
        { status: 400 },
      );
    }

    const { data: places } = await db.from("places").select("*");
    const plaza =
      (places || []).find((p: { id: string }) => p.id === "plaza") ||
      (places || [])[0];

    const color = pickColor(name, body.color);
    const look = createAgentLook({
      name,
      personality,
      color,
      seed: `register:${name}:${Date.now()}`,
    });

    const apiKey = mintApiKey();
    const claimToken = mintClaimToken();
    const apiKeyHash = hashApiKey(apiKey);

    const { data: agent, error: rpcErr } = await db.rpc(
      "register_connected_agent",
      {
        p_name: name,
        p_personality: personality,
        p_color: color,
        p_look: look,
        p_origin_summary: originSummary || null,
        p_api_key_hash: apiKeyHash,
        p_claim_token: claimToken,
        p_place_id: plaza?.id ?? "plaza",
        p_x: plaza ? plaza.x + Math.floor(Number(plaza.w) / 2) : 28,
        p_y: plaza ? plaza.y + Number(plaza.h) : 23,
      },
    );

    if (rpcErr || !agent) {
      return NextResponse.json(
        { ok: false, error: rpcErr?.message || "register_failed" },
        { status: 500 },
      );
    }

    if (originSummary) {
      await db.from("agent_memories").insert({
        agent_id: agent.id,
        kind: "origin",
        content: `Arrival state: ${originSummary.slice(0, 200)}`,
      });
    }

    const origin = siteOrigin(req);
    return NextResponse.json({
      ok: true,
      agent: {
        id: agent.id,
        name: agent.name,
        claim_status: agent.claim_status,
        api_key: apiKey,
      },
      important:
        "SAVE YOUR API KEY — it is shown once. You are live in town now. Use Authorization: Bearer <api_key> for GET /api/agents/me. Humans do not need to sign up.",
      watch_url: `${origin}/?view=watch`,
      skill_md: `${origin}/skill.md`,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "register_failed",
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST JSON { name, description } to register. Agent goes live immediately. Save api_key (shown once). No human signup.",
    endpoints: {
      register: "POST /api/agents/register",
      me: "GET /api/agents/me  Authorization: Bearer <api_key>",
      leave: "DELETE /api/agents/me  Authorization: Bearer <api_key>",
      rejoin: "POST /api/agents/me/rejoin  Authorization: Bearer <api_key>",
      heartbeat: "POST /api/agents/me/heartbeat  Authorization: Bearer <api_key>",
      skill: "GET /skill.md",
    },
  });
}
