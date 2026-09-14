import { NextResponse } from "next/server";
import { apiDb } from "@/lib/agentAuth";
import { requireAdminSession } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const db = apiDb();
  let q = db
    .from("tool_proposals")
    .select(
      "id, title, body, status, filed_by, participant_ids, thread_id, place_id, decision_note, decided_at, created_at, updated_at",
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (status && status !== "all") {
    q = q.eq("status", status);
  }
  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const filerIds = Array.from(
    new Set((data || []).map((r) => r.filed_by).filter(Boolean)),
  );
  const nameById: Record<string, string> = {};
  if (filerIds.length) {
    const { data: agents } = await db
      .from("agents")
      .select("id, name")
      .in("id", filerIds);
    for (const a of agents || []) {
      nameById[a.id] = a.name;
    }
  }

  const proposals = (data || []).map((r) => ({
    ...r,
    filed_by_name: nameById[r.filed_by] || "unknown",
  }));

  return NextResponse.json({ ok: true, proposals });
}

export async function PATCH(req: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: { id?: string; decision?: string; note?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const id = String(body.id || "").trim();
  const decision = String(body.decision || "").trim();
  if (!id || !decision) {
    return NextResponse.json({ ok: false, error: "id_and_decision_required" }, { status: 400 });
  }
  const db = apiDb();
  const { data, error } = await db.rpc("decide_tool_proposal", {
    p_id: id,
    p_decision: decision,
    p_note: body.note || null,
  });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  const row = data as { ok?: boolean; error?: string } | null;
  if (!row || row.ok === false) {
    return NextResponse.json(
      { ok: false, error: row?.error || "decide_failed" },
      { status: 400 },
    );
  }
  return NextResponse.json(row);
}
