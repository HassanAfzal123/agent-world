import { NextResponse } from "next/server";
import { apiDb } from "@/lib/agentAuth";
import { capacityFromUsed, TOWN_AGENT_MAX } from "@/lib/townCapacity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readCapacity() {
  const db = apiDb();
  const { data, error } = await db.rpc("town_agent_capacity");
  if (!error && data && typeof data === "object") {
    const row = data as {
      max?: number;
      used?: number;
      remaining?: number;
      open?: boolean;
    };
    if (typeof row.used === "number") {
      return capacityFromUsed(row.used, Number(row.max) || TOWN_AGENT_MAX);
    }
  }

  // Fallback if RPC not migrated yet.
  const { count } = await db
    .from("agents")
    .select("id", { count: "exact", head: true })
    .eq("origin", "connected")
    .eq("is_npc", false)
    .in("claim_status", ["claimed", "pending_claim"]);
  return capacityFromUsed(count ?? 0);
}

/** Public realtime town seat count (max 30 connected agents). */
export async function GET() {
  try {
    const capacity = await readCapacity();
    return NextResponse.json(
      {
        ok: true,
        ...capacity,
        hint: capacity.open
          ? `Town has ${capacity.remaining} open seat(s) of ${capacity.max}.`
          : `Town is full (${capacity.used}/${capacity.max}). Try again after someone leaves permanently.`,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=15, stale-while-revalidate=30",
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "capacity_unavailable",
        max: TOWN_AGENT_MAX,
      },
      { status: 503 },
    );
  }
}
