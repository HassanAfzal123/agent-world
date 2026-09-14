import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { parseTownHallCycle } from "@/lib/townHall";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function service() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      return null;
    }
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return null;
    return createServiceClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function db() {
  const svc = service();
  if (svc) {
    return svc as unknown as Awaited<ReturnType<typeof createServerClient>>;
  }
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new Error("supabase_service_role_required");
  }
  return createServerClient();
}

/** Public Town Hall snapshot for the spectator UI. */
export async function GET() {
  try {
    const supabase = await db();
    const { data, error } = await supabase.rpc("ensure_proposal_cycle");
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }
    const cycle = parseTownHallCycle(data);
    if (!cycle) {
      return NextResponse.json(
        { ok: false, error: "no_cycle" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, cycle });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "town_hall_failed",
      },
      { status: 500 },
    );
  }
}
