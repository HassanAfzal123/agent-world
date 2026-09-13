import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  buildNavGrid,
  ejectIfInside,
  findPath,
  pickArrivalTile,
  type Tile,
} from "@/lib/navGrid";
import { commitmentAfterArrival } from "@/lib/commitment";
import type { Agent, Place } from "@/lib/types";
import { allowSimCall } from "@/lib/simGuard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function service() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function db() {
  const svc = service();
  if (svc) {
    return svc as unknown as Awaited<ReturnType<typeof createServerClient>>;
  }
  return createServerClient();
}

function parsePath(raw: unknown): Tile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const o = p as { x?: unknown; y?: unknown };
      const x = Number(o.x);
      const y = Number(o.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    })
    .filter(Boolean) as Tile[];
}

function tileKey(t: Tile) {
  return `${t.x},${t.y}`;
}

type WalkPatch = {
  x: number;
  y: number;
  path: Tile[];
  status: string;
  place_id: string | null;
  target_place_id: string | null;
  thought: string;
  energy?: number;
  last_action?: string;
  commit_action?: string | null;
  commit_detail?: string | null;
  commit_ticks?: number | null;
  log_message?: string | null;
};

async function applyStep(
  supabase: Awaited<ReturnType<typeof db>>,
  agentId: string,
  patch: WalkPatch,
) {
  return supabase.rpc("apply_walk_step", {
    p_agent_id: agentId,
    p_x: patch.x,
    p_y: patch.y,
    p_path: patch.path,
    p_status: patch.status,
    p_place_id: patch.place_id,
    p_target_place_id: patch.target_place_id,
    p_thought: patch.thought,
    p_energy: patch.energy ?? null,
    p_last_action: patch.last_action ?? null,
    p_commit_action: patch.commit_action ?? null,
    p_commit_detail: patch.commit_detail ?? null,
    p_commit_ticks: patch.commit_ticks ?? null,
    p_log_message: patch.log_message ?? null,
  });
}

/**
 * Fast walk stepper — call ~2–3×/sec from the client.
 * Caps work per request so hundreds of walkers stay responsive.
 * Routes detour around standing agents and use alternate arrival pads.
 */
export async function POST(req: Request) {
  try {
    const supabase = await db();
    const gate = await allowSimCall(req, supabase as never, "walk");
    if (!gate.ok) {
      return NextResponse.json(
        { ok: false, error: gate.error },
        { status: gate.status },
      );
    }
    const [{ data: places }, { data: walkers }, { data: everyone }] =
      await Promise.all([
        supabase.from("places").select("*"),
        supabase
          .from("agents")
          .select("*")
          .eq("status", "walking")
          .not("target_place_id", "is", null)
          .order("last_tick_at", { ascending: true })
          .limit(48),
        supabase.from("agents").select("id,x,y,status,place_id,target_place_id"),
      ]);

    if (!places || !walkers?.length) {
      return NextResponse.json({ ok: true, stepped: [], n: 0 });
    }

    const { grid, entrances, pads } = buildNavGrid(places as Place[]);
    const stepped: unknown[] = [];
    const errors: string[] = [];

    // Standing / other bodies — soft avoid on paths; hard avoid on arrival pads
    const occupiedStanding = new Set<string>();
    for (const a of (everyone || []) as Agent[]) {
      if (a.status === "walking") continue;
      occupiedStanding.add(tileKey({ x: a.x, y: a.y }));
    }

    // Within this batch, reserve next steps so walkers don't stack on one tile
    const reserved = new Set<string>();

    for (const agent of walkers as Agent[]) {
      const destId = agent.target_place_id;
      if (!destId) continue;
      const dest = (places as Place[]).find((p) => p.id === destId) as
        | Place
        | undefined;
      if (!dest) {
        const { error } = await applyStep(supabase, agent.id, {
          x: agent.x,
          y: agent.y,
          path: [],
          status: "idle",
          place_id: agent.place_id,
          target_place_id: null,
          thought: "Destination missing — standing down.",
        });
        if (error) errors.push(error.message);
        continue;
      }

      const primary: Tile = entrances[destId] || {
        x: dest.x + Math.floor(dest.w / 2),
        y: dest.y + dest.h,
      };
      const placePads = pads[destId] || [primary];

      const softAvoid = new Set<string>(occupiedStanding);
      for (const a of (everyone || []) as Agent[]) {
        if (a.id === agent.id) continue;
        softAvoid.add(tileKey({ x: a.x, y: a.y }));
      }
      for (const k of reserved) softAvoid.add(k);

      const hardAvoid = new Set<string>(occupiedStanding);
      // Don't hard-block our own tile
      hardAvoid.delete(tileKey({ x: agent.x, y: agent.y }));

      const arrival = pickArrivalTile(
        placePads,
        primary,
        hardAvoid,
        softAvoid,
      );

      const pos = ejectIfInside(grid, agent.x, agent.y);
      let path = parsePath(agent.path);

      const pathEnd = path[path.length - 1];
      const nextBlocked =
        path[0] &&
        softAvoid.has(tileKey(path[0])) &&
        !(path[0].x === arrival.x && path[0].y === arrival.y);
      const needsPath =
        !path.length ||
        !pathEnd ||
        pathEnd.x !== arrival.x ||
        pathEnd.y !== arrival.y ||
        nextBlocked;

      if (needsPath) {
        path = findPath(grid, pos, arrival, {
          softAvoid,
          hardAvoid,
        });
        if (!path.length) {
          // Retry without hard avoid — still soft-detour
          path = findPath(grid, pos, arrival, { softAvoid });
        }
        if (!path.length) {
          const nx =
            pos.x < arrival.x ? pos.x + 1 : pos.x > arrival.x ? pos.x - 1 : pos.x;
          const ny =
            pos.y < arrival.y ? pos.y + 1 : pos.y > arrival.y ? pos.y - 1 : pos.y;
          if (
            grid[ny]?.[nx] > 0 &&
            (nx !== pos.x || ny !== pos.y) &&
            !hardAvoid.has(tileKey({ x: nx, y: ny }))
          ) {
            path = [{ x: nx, y: ny }];
          }
        }
      }

      if (pos.x === arrival.x && pos.y === arrival.y) {
        const arrivalBeat = commitmentAfterArrival(destId);
        const { data, error } = await applyStep(supabase, agent.id, {
          x: pos.x,
          y: pos.y,
          path: [],
          status: "idle",
          place_id: destId,
          target_place_id: null,
          thought: agent.thought || "",
          last_action: "arrive",
          commit_action: arrivalBeat?.commit_action ?? null,
          commit_detail: arrivalBeat?.commit_detail ?? null,
          commit_ticks: arrivalBeat?.commit_ticks ?? 0,
          log_message: `${agent.name} arrived at ${dest.name}.`,
        });
        if (error || (data as { ok?: boolean })?.ok === false) {
          errors.push(`${agent.name}: ${error?.message || "arrive_failed"}`);
          continue;
        }
        occupiedStanding.add(tileKey(pos));
        stepped.push({
          agent: agent.name,
          arrived: true,
          place: destId,
          pad: arrival,
        });
        continue;
      }

      if (path[0] && path[0].x === pos.x && path[0].y === pos.y) {
        path = path.slice(1);
      }
      let stepTo = path[0];
      // If next tile was just reserved by another walker this batch, repath once
      if (stepTo && reserved.has(tileKey(stepTo))) {
        path = findPath(grid, pos, arrival, {
          softAvoid: new Set([...softAvoid, ...reserved]),
          hardAvoid,
        });
        stepTo = path[0];
      }
      if (!stepTo) {
        const { error } = await applyStep(supabase, agent.id, {
          x: pos.x,
          y: pos.y,
          path: [],
          status: "idle",
          place_id: agent.place_id,
          target_place_id: null,
          thought: `Path blocked to ${dest.name} — picking a new scene.`,
          last_action: "idle",
          commit_action: null,
          commit_detail: null,
          commit_ticks: 0,
          log_message: `${agent.name} couldn't reach ${dest.name} and stopped.`,
        });
        if (error) errors.push(`${agent.name}: ${error.message}`);
        stepped.push({ agent: agent.name, stuck: true, aborted: destId });
        continue;
      }

      const remaining = path.slice(1);
      reserved.add(tileKey(stepTo));
      const { data, error } = await applyStep(supabase, agent.id, {
        x: stepTo.x,
        y: stepTo.y,
        path: remaining,
        status: "walking",
        place_id: null,
        target_place_id: destId,
        thought: `Walking to ${dest.name}… (${remaining.length} tiles left)`,
        energy:
          remaining.length % 12 === 0
            ? Math.max(0, (agent.energy ?? 100) - 1)
            : agent.energy ?? 100,
        last_action: "walk",
      });

      if (error || (data as { ok?: boolean })?.ok === false) {
        errors.push(`${agent.name}: ${error?.message || "step_failed"}`);
        continue;
      }

      stepped.push({
        agent: agent.name,
        x: stepTo.x,
        y: stepTo.y,
        left: remaining.length,
        dest: destId,
        pad: arrival,
      });
    }

    return NextResponse.json({
      ok: errors.length === 0,
      stepped,
      n: stepped.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "walk_failed" },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST to step all walking agents one tile (pathfinding).",
  });
}
