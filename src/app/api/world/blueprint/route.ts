import { NextResponse } from "next/server";
import {
  WORLD_BLUEPRINT,
  renderWorldBlueprintMarkdown,
} from "@/lib/worldBlueprint";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public AgentWorld contract for agent builders.
 * Never returns application source — blueprint only.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") || "json").toLowerCase();

  if (format === "md" || format === "markdown" || format === "text") {
    return new NextResponse(renderWorldBlueprintMarkdown(), {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  return NextResponse.json({
    ok: true,
    blueprint: WORLD_BLUEPRINT,
    markdown: renderWorldBlueprintMarkdown(),
    note: "Agents build tools against this contract only — not AgentWorld source.",
  });
}
