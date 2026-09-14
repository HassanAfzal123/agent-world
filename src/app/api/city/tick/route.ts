import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { decideAgentTurn, llmConfigured, llmProviderFlags, type AgentDecision } from "@/lib/llm";

import {
  breakSoloActionLoop,
  breakTopicLoop,
  commitmentAfterArrival,
  detectTopicLoop,
  enforceCommitment,
  enforceNoteCap,
  forceMeetup,
  journalForAction,
  nextCommitment,
  partingCommitment,
  sanitizeExploreWalk,
  stabilizeTravel,
} from "@/lib/commitment";
import { rewriteDuplicateLearning, enforceDailyLearnCap, forceAnswerDecision, shouldSkipLlm } from "@/lib/learning";
import {
  COUNCIL_EVENT,
  appointmentDue,
  councilTopicFromAgents,
  forceAppointmentDecision,
  forceCouncilDecision,
  forceEventGatherDecision,
  clampToProposalGather,
  forceProposalFilingDecision,
  forceProposalMeetingDecision,
  forceProposalPrepDecision,
  hauntWalkDecision,
  needsOpenMindSpeech,
  topicFromUtterance,
} from "@/lib/society";
import { cleanSpeech, fullSpeech, SPEECH_MAX, TOPIC_MAX } from "@/lib/spectator";
import { topicLabelFromSpeech } from "@/lib/agentMind";
import { pickMeetupPlace, placeIsBusy } from "@/lib/meetupPlaces";
import {
  craftFreshQuestion,
  enforceFreshConversation,
  isGenericAsk,
  shouldSkipThreadOpen,
} from "@/lib/conversationFreshness";
import {
  formatThreadPrompt,
  isDialogueLocked,
  isRepeatThreadLine,
  type ConversationThread,
} from "@/lib/conversation";
import { fallbackAgentDecisionWithPeers } from "@/lib/fallbackBrain";
import { createAgentLook, isAgentLook } from "@/lib/agentLook";
import type {
  Agent,
  AgentLesson,
  CityLogRow,
  Notice,
  Place,
  Relationship,
  TownObject,
} from "@/lib/types";
import { allowSimCall, isCronAuthorized } from "@/lib/simGuard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function service() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      return null;
    }
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!anon) return null;
    return createServiceClient(url!, anon, {
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
    return {
      supabase: svc as unknown as Awaited<
        ReturnType<typeof createServerClient>
      >,
      using: process.env.SUPABASE_SERVICE_ROLE_KEY ? "service" : "anon",
    };
  }
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new Error("supabase_service_role_required");
  }
  const supabase = await createServerClient();
  return { supabase, using: "ssr" };
}

export async function GET(req: Request) {
  // Vercel Cron invokes GET. Authorized cron runs the tick; browsers get health.
  if (isCronAuthorized(req)) {
    return POST(req);
  }
  return NextResponse.json({
    ok: true,
    llm: llmConfigured(),
    supabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    providers: llmProviderFlags(),
  });
}

export async function POST(req: Request) {
  try {
    const { supabase, using } = await db();
    const gate = await allowSimCall(req, supabase as never, "tick");
    if (!gate.ok) {
      return NextResponse.json(
        { ok: false, error: gate.error },
        { status: gate.status },
      );
    }

    const [
      { data: meta, error: metaErr },
      { data: places, error: placesErr },
      { data: agents, error: agentsErr },
      { data: log },
      { data: notices },
      { data: objects },
      { data: relationships },
    ] = await Promise.all([
      supabase.from("city_meta").select("*").eq("id", 1).maybeSingle(),
      supabase.from("places").select("*"),
      // Native NPCs only for server LLM. Connected agents drive themselves via /me/act.
      supabase
        .from("agents")
        .select("*")
        .eq("brain", "llm")
        .eq("is_npc", true)
        .neq("claim_status", "pending_claim"),
      supabase
        .from("city_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(24),
      supabase
        .from("notices")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(12),
      supabase.from("town_objects").select("*").limit(24),
      supabase.from("relationships").select("*").limit(40),
    ]);

    if (metaErr || placesErr || agentsErr || !meta || !places || !agents) {
      return NextResponse.json(
        {
          ok: false,
          error: "world_missing",
          using,
          detail: {
            meta: metaErr?.message || (meta ? "ok" : "null"),
            places: placesErr?.message || (places ? `n=${places.length}` : "null"),
            agents: agentsErr?.message || (agents ? `n=${agents.length}` : "null"),
          },
        },
        { status: 500 },
      );
    }

    await supabase.rpc("maybe_rotate_town_event");
    await supabase.rpc("bump_city_clock");

    const { data: meta2 } = await supabase
      .from("city_meta")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    const hour = Number(meta2?.hour ?? meta.hour);
    const tick = Number(meta2?.tick ?? meta.tick);
    const eventName = (meta2?.event_name as string | null) ?? null;
    const eventPlace = (meta2?.event_place as string | null) ?? null;
    let eventTopic = (meta2?.event_topic as string | null) ?? null;

    // Council agenda must come from agent minds — never a hardcoded slogan bank
    if (eventName === COUNCIL_EVENT && !cleanSpeech(eventTopic)) {
      const fromMinds = councilTopicFromAgents(
        agents as Agent[],
        (log as CityLogRow[]) || [],
        tick,
      );
      if (fromMinds) {
        eventTopic = fromMinds;
        await supabase
          .from("city_meta")
          .update({ event_topic: fromMinds })
          .eq("id", 1);
      }
    }

    // Keep ticks snappy: many agents in town, few LLM minds per tick (round-robin).
    // Ollama 1B can take 10–25s per agent — 10 in one tick freezes the UI.
    const prefer = (process.env.LLM_PROVIDER || "").toLowerCase().trim();
    const defaultCast = prefer === "ollama" ? 3 : 3;
    const MAX_LLM_PER_TICK = Math.max(
      1,
      Number(process.env.LLM_MAX_PER_TICK || defaultCast) || defaultCast,
    );
    const CAST_SIZE = Math.max(
      1,
      Number(process.env.LLM_CAST_SIZE || defaultCast) || defaultCast,
    );
    const allLlm = agents as Agent[];
    let llmCallsThisTick = 0;

    const { data: cycleSnap } = await supabase.rpc("ensure_proposal_cycle");
    const proposalCycle =
      cycleSnap && typeof cycleSnap === "object"
        ? (cycleSnap as {
            phase?: string;
            meeting_place?: string;
            champion_id?: string | null;
            utc_minute?: number;
          })
        : {};
    const cyclePhase = String(proposalCycle.phase || "");
    const cyclePlace = String(proposalCycle.meeting_place || "plaza");
    const cycleChamp = proposalCycle.champion_id || null;
    const cycleMinute = Number(proposalCycle.utc_minute ?? 0);

    // Persist procedural looks for any agent missing one (spawn + legacy)
    for (const a of allLlm) {
      if (isAgentLook(a.look)) continue;
      const look = createAgentLook({
        name: a.name,
        personality: a.personality,
        color: a.color,
        seed: a.id,
      });
      await supabase.rpc("assign_agent_look", {
        p_agent_id: a.id,
        p_look: look,
      });
      a.look = look;
    }

    const actionable = allLlm
      .filter((a) => !(a.status === "walking" && a.target_place_id))
      .sort((a, b) => {
        // Pending answers + due appointments first — finish social beats
        const pa =
          (a.pending_answer_to ? 0 : 2) + (appointmentDue(a, hour) ? 0 : 1);
        const pb =
          (b.pending_answer_to ? 0 : 2) + (appointmentDue(b, hour) ? 0 : 1);
        if (pa !== pb) return pa - pb;
        const ta = a.last_tick_at ? new Date(a.last_tick_at).getTime() : 0;
        const tb = b.last_tick_at ? new Date(b.last_tick_at).getTime() : 0;
        return ta - tb;
      });
    const cast = actionable.slice(0, CAST_SIZE);
    const deferred = Math.max(0, actionable.length - cast.length);
    const results: unknown[] = [];
    if (deferred > 0) {
      results.push({
        note: "round_robin",
        acting: cast.length,
        deferred,
        total_llm: allLlm.length,
        max_llm_calls: MAX_LLM_PER_TICK,
      });
    }

    for (const agent of cast) {
      // Walkers are advanced by /api/city/walk — skip LLM + RPC noise
      if (agent.status === "walking" && agent.target_place_id) {
        results.push({
          agent: agent.name,
          decision: { action: "continue" },
          walking: true,
        });
        continue;
      }

      // Connected agents bring their own LLM. The town hosts them; it does not
      // puppet their minds with a server model.
      if (agent.origin === "connected" || agent.is_npc === false) {
        results.push({
          agent: agent.name,
          decision: { action: "continue" },
          connected: true,
          note: "external_brain",
        });
        continue;
      }

      const { data: mems } = await supabase
        .from("agent_memories")
        .select("content")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false })
        .limit(8);

      // Context peers: nearby only (not the entire 100+ cast)
      const peers = allLlm
        .filter(
          (o) =>
            o.id !== agent.id &&
            Math.abs(o.x - agent.x) <= 5 &&
            Math.abs(o.y - agent.y) <= 5,
        )
        .slice(0, 14);

      let decision: AgentDecision;
      let usedLlm = false;
      let activeThread: ConversationThread | null = null;
      let rawSpeech: string | null = null;
      try {
        const { data: lessons } = await supabase
          .from("agent_lessons")
          .select("*")
          .eq("learner_id", agent.id)
          .order("created_at", { ascending: false })
          .limit(6);

        const recentLog = (log as CityLogRow[]) || [];

        // Active thread context for open-mind replies
        const { data: openThrRaw } = await supabase.rpc("agent_open_thread", {
          p_agent: agent.id,
        });
        activeThread = (openThrRaw || null) as ConversationThread | null;
        const dialoguePeerId =
          activeThread?.status === "open" &&
          activeThread.waiting_on === agent.id
            ? activeThread.starter_id === agent.id
              ? activeThread.other_id
              : activeThread.starter_id
            : null;

        // Structure-only forces (walk). Speech comes from open minds (LLM).
        // Hourly tool gather beats open-stage / council / appointments / pending answers
        // until the agent is at plaza — every agent reports.
        const forcedAnswer = forceAnswerDecision(
          agent,
          allLlm,
          dialoguePeerId,
        );
        const forcedProposalPrep = forceProposalPrepDecision(
          agent,
          cyclePhase,
          cycleMinute,
          cyclePlace,
        );
        const forcedProposalMeet = forcedProposalPrep
          ? null
          : forceProposalMeetingDecision(agent, cyclePhase, cyclePlace);
        const forcedProposalFile =
          forcedProposalPrep || forcedProposalMeet
            ? null
            : forceProposalFilingDecision(agent, cyclePhase, cycleChamp);
        const forcedProposal =
          forcedProposalPrep || forcedProposalMeet || forcedProposalFile;
        // At plaza during gather, answering peers is fine; elsewhere, gather wins.
        const forcedAnswerOk =
          forcedAnswer &&
          !(
            forcedProposal &&
            agent.place_id !== (cyclePlace || "plaza")
          )
            ? forcedAnswer
            : forcedProposal
              ? null
              : forcedAnswer;
        const forcedAppt =
          forcedAnswerOk || forcedProposal
            ? null
            : forceAppointmentDecision(agent, allLlm, hour);
        const forcedCouncil =
          forcedAnswerOk || forcedProposal || forcedAppt
            ? null
            : forceCouncilDecision(
                agent,
                allLlm,
                eventName,
                eventPlace,
                eventTopic,
              );
        const forcedAmbient =
          forcedAnswerOk || forcedProposal || forcedAppt || forcedCouncil
            ? null
            : forceEventGatherDecision(agent, allLlm, eventName, eventPlace);
        const forcedSociety =
          forcedAnswerOk ||
          forcedProposal ||
          forcedAppt ||
          forcedCouncil ||
          forcedAmbient;
        const budgetExhausted = llmCallsThisTick >= MAX_LLM_PER_TICK;
        const openMindNow =
          needsOpenMindSpeech(
            agent,
            allLlm,
            hour,
            eventName,
            eventPlace,
          ) || isDialogueLocked(agent);
        // Prefer real agent mind for answer / meetup / council / dialogue speech
        const skipLlm =
          !openMindNow && (shouldSkipLlm(agent) || budgetExhausted);

        let threadPrompt: string | null = null;
        if (activeThread?.id && activeThread.status === "open") {
          const { data: msgs } = await supabase.rpc("thread_messages", {
            p_thread: activeThread.id,
            p_limit: 6,
          });
          const lines = ((msgs as { agent_id: string; body: string; kind: string; created_at: string }[]) || []).map(
            (m) => ({
              agentId: m.agent_id,
              name:
                allLlm.find((a) => a.id === m.agent_id)?.name ||
                (m.agent_id === agent.id ? agent.name : "Peer"),
              body: m.body,
              kind: m.kind,
              at: m.created_at,
            }),
          );
          threadPrompt = formatThreadPrompt(lines, agent);
        }

        if (forcedSociety) {
          decision = forcedSociety;
        } else if (skipLlm) {
          const alone = peers.length === 0;
          const haunt =
            isDialogueLocked(agent) || agent.pending_answer_to
              ? null
              : hauntWalkDecision(
                  agent,
                  places as Place[],
                  hour,
                  alone,
                );
          decision =
            haunt ||
            fallbackAgentDecisionWithPeers(
              agent,
              places as Place[],
              [agent, ...peers],
              tick,
              {
                hour,
                eventName,
                eventPlace,
                eventTopic,
              },
            );
          // Do not invent thoughts — keep whatever the agent already carries, or null
        } else {
          // Nudge dialogue turn: talk to waiting partner when in range
          const dialoguePeer =
            dialoguePeerId || agent.pending_answer_to || null;

          decision = await decideAgentTurn(agent, {
            hour,
            tick,
            eventName,
            eventPlace,
            eventTopic,
            places: places as Place[],
            agents: [agent, ...peers],
            recentLog,
            memories: (mems || []).map((m) => String(m.content)).slice(0, 5),
            notices: ((notices as Notice[]) || []).slice(0, 4),
            objects: ((objects as TownObject[]) || []).slice(0, 8),
            relationships: ((relationships as Relationship[]) || []).filter(
              (r) => r.agent_id === agent.id,
            ),
            lessons: (lessons as AgentLesson[]) || [],
            threadPrompt,
          });
          if (
            dialoguePeer &&
            (!decision.target_agent ||
              decision.action === "walk" ||
              decision.action === "idle")
          ) {
            const peer = allLlm.find((a) => a.id === dialoguePeer);
            if (
              peer &&
              Math.abs(peer.x - agent.x) <= 4 &&
              Math.abs(peer.y - agent.y) <= 4
            ) {
              decision = {
                ...decision,
                action:
                  decision.action === "ask_question" ||
                  decision.action === "share_experience" ||
                  decision.action === "teach" ||
                  decision.action === "debate"
                    ? decision.action
                    : "talk",
                target_agent: dialoguePeer,
              };
            }
          }
          usedLlm = true;
          llmCallsThisTick += 1;
        }
        // Redundant planning — convert to doing the plan
        if (decision.action === "set_plan" && agent.day_plan) {
          const placeAct =
            agent.place_id === "library"
              ? "inspect"
              : agent.place_id === "workshop"
                ? "fix"
                : agent.place_id === "stage"
                  ? "watch_show"
                  : agent.place_id === "docks"
                    ? "reflect"
                    : agent.place_id === "market"
                      ? "inspect"
                      : agent.place_id === "cafe"
                        ? "eat"
                        : "reflect";
          decision = {
            ...decision,
            action: placeAct as AgentDecision["action"],
            thought:
              decision.thought ||
              `Plan already set — doing a ${placeAct.replace(/_/g, " ")} beat here.`,
          };
        }
        const looping = detectTopicLoop(recentLog);
        decision = stabilizeTravel(agent, decision);
        decision = enforceNoteCap(
          agent,
          decision,
          recentLog,
          places as Place[],
        );
        // Don't rewrite forced answers/appointments/council/proposal gather away from their beat
        if (!forcedSociety) {
          decision = rewriteDuplicateLearning(
            agent,
            decision,
            (lessons as AgentLesson[]) || [],
            peers,
            places as Place[],
          );
          decision = enforceDailyLearnCap(agent, decision, peers);
          if (!isDialogueLocked(agent) && !dialoguePeerId && !agent.pending_answer_to) {
            decision = enforceFreshConversation(
              agent,
              decision,
              peers,
              ((relationships as Relationship[]) || []).filter(
                (r) => r.agent_id === agent.id,
              ),
              places as Place[],
            );
            const meetup = forceMeetup(
              agent,
              decision,
              allLlm,
              recentLog,
              places as Place[],
              ((relationships as Relationship[]) || []).filter(
                (r) => r.agent_id === agent.id,
              ),
            );
            const soloBreak = breakSoloActionLoop(
              agent,
              decision,
              recentLog,
              places as Place[],
            );
            const forcedBreak =
              meetup ||
              soloBreak ||
              breakTopicLoop(
                agent,
                decision,
                recentLog,
                places as Place[],
                allLlm,
              );
            if (forcedBreak) {
              decision = forcedBreak;
            } else {
              decision = enforceCommitment(agent, decision, {
                allowWalkBreak: looping,
              });
              decision = sanitizeExploreWalk(
                agent,
                decision,
                places as Place[],
                looping,
              );
            }
          } else {
            decision = enforceCommitment(agent, decision, {
              allowWalkBreak: false,
            });
          }
        }
        decision = stabilizeTravel(agent, decision);
        // Hourly tool gather: every agent at plaza; block open-stage / meetup walks away.
        decision = clampToProposalGather(
          agent,
          decision,
          cyclePhase,
          cycleMinute,
          cyclePlace,
        );

        // Never send generic / recycled asks into the RPC or threads
        if (
          decision.action === "ask_question" &&
          decision.target_agent &&
          isGenericAsk(decision.utterance)
        ) {
          const peer = allLlm.find((a) => a.id === decision.target_agent);
          if (peer) {
            const q = craftFreshQuestion(
              agent,
              peer,
              ((relationships as Relationship[]) || []).filter(
                (r) => r.agent_id === agent.id,
              ),
            );
            decision = {
              ...decision,
              utterance: q.utterance,
              item: q.item,
            };
          }
        }

        // Keep raw speech for threads (full length); truncate only for map bubbles / spam filter
        rawSpeech =
          (decision.utterance || decision.thought || "").trim() || null;

        // Never persist travel/status spam as speech — watchers need real quotes
        decision = {
          ...decision,
          utterance: cleanSpeech(decision.utterance, SPEECH_MAX),
          thought: cleanSpeech(decision.thought, SPEECH_MAX) || decision.thought,
        };

        if (usedLlm) {
          await supabase.rpc("mark_agent_llm_at", { p_agent_id: agent.id });
        }
      } catch (err) {
        results.push({
          agent: agent.name,
          error: err instanceof Error ? err.message : "llm_failed",
        });
        continue;
      }

      const action = decision.action === "continue" ? "continue" : decision.action;
      const { data, error } = await supabase.rpc("apply_agent_action", {
        p_agent_id: agent.id,
        p_action: action,
        p_target_place: decision.target_place,
        p_target_agent: decision.target_agent,
        p_utterance: decision.utterance,
        p_thought: decision.thought,
        p_item: decision.item,
        p_plan: decision.plan,
      });

      let finalData = data;
      let finalError = error?.message;
      let finalAction: string = action;
      const tooFar =
        data &&
        typeof data === "object" &&
        (data as { error?: string }).error === "too_far";
      if (tooFar && decision.target_agent) {
        const other = allLlm.find((a) => a.id === decision.target_agent);
        const prefer = other?.place_id || other?.target_place_id || null;
        const dest = pickMeetupPlace({
          agents: allLlm,
          places: places as Place[],
          prefer,
          avoid: agent.place_id,
          peerHaunt: other?.haunt_place_id,
          selfHaunt: agent.haunt_place_id,
          salt: `toofar:${agent.name}:${other?.name || ""}`,
        });
        const retry = await supabase.rpc("apply_agent_action", {
          p_agent_id: agent.id,
          p_action: "walk",
          p_target_place: dest,
          p_target_agent: decision.target_agent,
          p_utterance: null,
          p_thought: `Too far to interact — walking toward ${other?.name || "them"} via ${dest}.`,
          p_item: null,
          p_plan: null,
        });
        finalData = retry.data;
        finalError = retry.error?.message;
        finalAction = "walk";
        decision = {
          ...decision,
          action: "walk",
          target_place: dest,
          thought: `Too far; walking to ${dest}`,
        };
      }

      const ok =
        finalData &&
        typeof finalData === "object" &&
        (finalData as { ok?: boolean }).ok !== false &&
        !(finalData as { error?: string }).error;

      if (ok) {
        const arrived =
          finalData &&
          typeof finalData === "object" &&
          (finalData as { arrived?: boolean }).arrived === true;
        const skippedDup =
          finalData &&
          typeof finalData === "object" &&
          (finalData as { skipped?: string }).skipped === "duplicate_lesson";
        const skippedCap =
          finalData &&
          typeof finalData === "object" &&
          String((finalData as { skipped?: string }).skipped || "").includes(
            "daily",
          );
        const skippedLearn = Boolean(skippedDup || skippedCap);

        const transferOk =
          !skippedLearn &&
          ["teach", "share_experience", "debate", "demo"].includes(finalAction);

        const speechBody =
          fullSpeech(rawSpeech) ||
          cleanSpeech(decision.utterance || decision.thought || "", 0);
        const socialPeer = decision.target_agent || null;
        let momentThreadId: string | null = activeThread?.id || null;

        // Open or continue Moltbook-style threads (before parting commits)
        if (
          ok &&
          speechBody &&
          speechBody.length >= 8 &&
          socialPeer &&
          ["ask_question", "talk", "teach", "share_experience", "debate"].includes(
            finalAction,
          )
        ) {
          const { data: lastMsgs } =
            activeThread?.status === "open"
              ? await supabase.rpc("thread_messages", {
                  p_thread: activeThread.id,
                  p_limit: 1,
                })
              : { data: null };
          const lastBody =
            Array.isArray(lastMsgs) && lastMsgs[0]
              ? String((lastMsgs[0] as { body?: string }).body || "")
              : null;

          if (!isRepeatThreadLine(speechBody, lastBody)) {
            const inOpenThread =
              activeThread?.status === "open" &&
              (activeThread.starter_id === agent.id ||
                activeThread.other_id === agent.id) &&
              (socialPeer === activeThread.starter_id ||
                socialPeer === activeThread.other_id);

            if (inOpenThread && activeThread) {
              const kind =
                finalAction === "ask_question"
                  ? "ask"
                  : finalAction === "share_experience" ||
                      finalAction === "teach"
                    ? "share"
                    : "reply";
              const { data: replied, error: replyErr } = await supabase.rpc(
                "reply_conversation",
                {
                  p_thread: activeThread.id,
                  p_agent: agent.id,
                  p_body: speechBody,
                  p_kind: kind,
                },
              );
              if (!replyErr && replied) {
                activeThread = replied as ConversationThread;
                momentThreadId = activeThread.id;
              }
            } else if (
              finalAction === "ask_question" ||
              (finalAction === "talk" &&
                (/\?/.test(speechBody) ||
                  /^(hey|hi|curious|wonder|want to|can you|tell me)/i.test(
                    speechBody,
                  )))
            ) {
              const topicRaw = topicLabelFromSpeech(
                speechBody,
                decision.item || agent.pending_answer_topic,
              );
              const relsForPair = ((relationships as Relationship[]) || []).filter(
                (r) =>
                  (r.agent_id === agent.id && r.other_id === socialPeer) ||
                  (r.agent_id === socialPeer && r.other_id === agent.id),
              );
              let openBody = speechBody;
              let openTopic = topicRaw;
              if (
                shouldSkipThreadOpen(
                  agent.id,
                  socialPeer,
                  openTopic,
                  openBody,
                  relsForPair,
                ) ||
                isGenericAsk(openBody)
              ) {
                const peerAgent = allLlm.find((a) => a.id === socialPeer);
                if (peerAgent) {
                  const q = craftFreshQuestion(agent, peerAgent, relsForPair);
                  // Only open if still fresh for this pair
                  if (
                    !shouldSkipThreadOpen(
                      agent.id,
                      socialPeer,
                      q.item,
                      q.utterance,
                      relsForPair,
                    )
                  ) {
                    openBody = q.utterance;
                    openTopic = topicLabelFromSpeech(q.utterance, q.item);
                  } else {
                    openBody = "";
                  }
                } else {
                  openBody = "";
                }
              }
              if (openBody.length >= 8) {
                const { data: opened, error: openErr } = await supabase.rpc(
                  "open_conversation",
                  {
                    p_starter: agent.id,
                    p_other: socialPeer,
                    p_topic: openTopic,
                    p_body: openBody,
                    p_place: agent.place_id,
                    p_max_turns: 24,
                  },
                );
                if (!openErr && opened) {
                  activeThread = opened as ConversationThread;
                  momentThreadId = activeThread.id;
                }
              }
            }
          }
        }

        const arrivalCommit = arrived
          ? commitmentAfterArrival(
              (finalData as { place?: string }).place ||
                decision.target_place ||
                agent.place_id,
            )
          : null;
        const answeringWalk =
          Boolean(agent.pending_answer_to || isDialogueLocked(agent)) &&
          finalAction === "walk";
        const appointmentWalk =
          appointmentDue(agent, hour) && finalAction === "walk";
        const stayInDialogue =
          isDialogueLocked(agent) ||
          (activeThread?.status === "open" &&
            (activeThread.starter_id === agent.id ||
              activeThread.other_id === agent.id));
        const commit = arrived
          ? agent.pending_answer_to || stayInDialogue
            ? {
                commit_action: stayInDialogue ? "dialogue" : "answer",
                commit_detail:
                  activeThread?.topic ||
                  agent.pending_answer_topic ||
                  agent.commit_detail ||
                  "curiosity",
                commit_ticks: Math.max(
                  stayInDialogue ? 3 : 2,
                  agent.commit_ticks ?? 0,
                ),
              }
            : appointmentDue(agent, hour)
              ? {
                  commit_action: "appointment",
                  commit_detail: agent.appointment_note || "meetup",
                  commit_ticks: Math.max(2, agent.commit_ticks ?? 0),
                }
              : arrivalCommit || {
                  commit_action: null,
                  commit_detail: null,
                  commit_ticks: 0,
                }
          : answeringWalk
            ? {
                commit_action: stayInDialogue ? "dialogue" : "answer",
                commit_detail:
                  activeThread?.topic ||
                  agent.pending_answer_topic ||
                  "curiosity",
                commit_ticks: 3,
              }
            : appointmentWalk
              ? {
                  commit_action: "appointment",
                  commit_detail: agent.appointment_note || "meetup",
                  commit_ticks: 3,
                }
            : transferOk && !stayInDialogue
              ? partingCommitment(agent.place_id)
              : stayInDialogue
                ? {
                    commit_action: "dialogue",
                    commit_detail:
                      activeThread?.topic ||
                      agent.commit_detail ||
                      "In conversation",
                    commit_ticks: Math.max(3, agent.commit_ticks ?? 0),
                  }
                : nextCommitment(
                    agent,
                    finalAction,
                    (log as CityLogRow[]) || [],
                  );

        // Skip overwriting arrival commits already written by step_agent.
        // Dialogue RPCs own commit_action — don't clobber with parting.
        if (!stayInDialogue && (!arrived || arrivalCommit)) {
          await supabase.rpc("set_agent_commitment", {
            p_agent_id: agent.id,
            p_commit_action: commit.commit_action,
            p_commit_detail: commit.commit_detail,
            p_commit_ticks: commit.commit_ticks,
            p_mindset:
              finalAction === "reflect" && decision.thought
                ? decision.thought.slice(0, 180)
                : null,
          });
        } else if (finalAction === "reflect" && decision.thought) {
          await supabase.rpc("set_agent_commitment", {
            p_agent_id: agent.id,
            p_commit_action: agent.commit_action,
            p_commit_detail: agent.commit_detail,
            p_commit_ticks: agent.commit_ticks ?? 0,
            p_mindset: decision.thought.slice(0, 180),
          });
        }

        // Re-assert dialogue lock if still in an open thread (arrival/inspect must not steal it)
        if (activeThread?.status === "open") {
          await supabase.rpc("set_agent_commitment", {
            p_agent_id: agent.id,
            p_commit_action: "dialogue",
            p_commit_detail: (
              activeThread.topic ||
              agent.commit_detail ||
              "In conversation"
            ).slice(0, 160),
            p_commit_ticks: Math.max(3, agent.commit_ticks ?? 0),
            p_mindset: null,
          });
        }

        const journal = journalForAction(agent, finalAction, decision);
        if (journal) {
          await supabase.rpc("write_journal", {
            p_agent: agent.id,
            p_kind: journal.kind,
            p_title: journal.title,
            p_body: journal.body,
            p_meta: { tick, action: finalAction },
          });
        }

        // Public aim refresh
        if (
          (finalAction === "set_plan" || finalAction === "reflect") &&
          (decision.plan || decision.thought)
        ) {
          await supabase.rpc("set_agent_goal", {
            p_agent_id: agent.id,
            p_goal: (decision.plan || decision.thought || "").slice(0, 180),
          });
        }

        // Clear appointment when social meetup lands with the booked peer
        if (
          agent.appointment_with &&
          ["join", "talk", "debate", "teach", "share_experience"].includes(
            finalAction,
          ) &&
          decision.target_agent === agent.appointment_with
        ) {
          await supabase.rpc("clear_appointment", { p_agent_id: agent.id });
        }

        // Soft follow-up appointment after a successful ask (unfinished story)
        if (finalAction === "ask_question" && decision.target_agent) {
          const meetHour = (hour + 2) % 24;
          const peer = allLlm.find((a) => a.id === decision.target_agent);
          const meetPlace = pickMeetupPlace({
            agents: allLlm,
            places: places as Place[],
            prefer:
              !placeIsBusy(allLlm, agent.place_id) && agent.place_id
                ? agent.place_id
                : peer?.place_id || null,
            avoid: null,
            peerHaunt: peer?.haunt_place_id,
            selfHaunt: agent.haunt_place_id,
            salt: `appt:${agent.name}:${peer?.name || ""}`,
          });
          await supabase.rpc("set_appointment", {
            p_agent_id: agent.id,
            p_with: decision.target_agent,
            p_place: meetPlace,
            p_hour: meetHour,
            p_note: `Follow up on: ${(decision.utterance || "our question").slice(0, 80)}`,
          });
        }

        // Spectator Moments + Skill Vault (skills that leave town)
        if (
          finalAction === "teach" ||
          finalAction === "share_experience" ||
          finalAction === "ask_question" ||
          finalAction === "debate" ||
          finalAction === "demo" ||
          finalAction === "practice_skill" ||
          finalAction === "reflect" ||
          (finalAction === "talk" && decision.utterance) ||
          finalAction === "join" ||
          finalAction === "post_notice" ||
          finalAction === "leave_note" ||
          finalAction === "watch_show" ||
          finalAction === "fix" ||
          finalAction === "eat" ||
          finalAction === "shop" ||
          finalAction === "work"
        ) {
          const other = decision.target_agent
            ? allLlm.find((a) => a.id === decision.target_agent)
            : null;
          const isCouncil =
            eventName === COUNCIL_EVENT &&
            (finalAction === "debate" ||
              finalAction === "post_notice" ||
              finalAction === "talk");
          const headline = isCouncil
            ? `Council: ${agent.name}${other ? ` ↔ ${other.name}` : ""} — ${(eventTopic || decision.utterance || "open floor").slice(0, 80)}`
            : finalAction === "teach"
              ? `${agent.name} taught ${other?.name || "a peer"}: ${decision.item || "a craft tip"}`
              : finalAction === "share_experience"
                ? `${agent.name} shared craft${other ? ` with ${other.name}` : ""}`
                : finalAction === "ask_question"
                  ? `${agent.name} asked ${other?.name || "a peer"} something new`
                  : finalAction === "debate"
                    ? `${agent.name} debated methods with ${other?.name || "a peer"}`
                    : finalAction === "demo"
                      ? `${agent.name} demoed a method${other ? ` for ${other.name}` : ""}`
                      : finalAction === "practice_skill"
                        ? `${agent.name} practiced ${decision.item || "a skill"}`
                        : finalAction === "reflect"
                          ? `${agent.name} locked in a mindset shift`
                          : finalAction === "watch_show"
                            ? `${agent.name} caught the stage show`
                            : finalAction === "fix"
                              ? `${agent.name} fixed something real`
                              : finalAction === "eat"
                                ? `${agent.name} took a cafe beat`
                                : finalAction === "shop"
                                  ? `${agent.name} worked the market`
                                  : finalAction === "work"
                                    ? `${agent.name} put in work`
                                    : finalAction === "join"
                                      ? `${agent.name} kept a meetup with ${other?.name || "a peer"}`
                                      : `${agent.name} → ${other?.name || "town"}`;
          await supabase.rpc("write_moment", {
            p_kind: isCouncil
              ? "council"
              : finalAction === "talk"
                ? "say"
                : finalAction === "join"
                  ? "join"
                  : finalAction,
            p_headline: headline.slice(0, 160),
            p_body: (decision.utterance || decision.thought || rawSpeech || "").slice(
              0,
              SPEECH_MAX,
            ),
            p_agent: agent.id,
            p_other: other?.id || null,
            p_place: agent.place_id,
            p_meta: {
              tick,
              item: decision.item || null,
              skipped: skippedDup || false,
              event: eventName,
              topic: eventTopic,
              thread_id: momentThreadId,
            },
          });

          // Seed council topic from the first real agent question/stance if still empty
          if (
            isCouncil &&
            !cleanSpeech(eventTopic) &&
            decision.utterance
          ) {
            const seeded = topicFromUtterance(decision.utterance);
            if (seeded) {
              eventTopic = seeded;
              await supabase
                .from("city_meta")
                .update({ event_topic: seeded })
                .eq("id", 1);
            }
          }

          // One contribution is enough — don't herd them back to stage every tick
          if (
            isCouncil &&
            decision.utterance &&
            (finalAction === "talk" ||
              finalAction === "debate" ||
              finalAction === "ask_question" ||
              finalAction === "share_experience" ||
              finalAction === "post_notice")
          ) {
            await supabase
              .from("agents")
              .update({
                commit_action: "council_attended",
                commit_detail: "Spoke at council — free to live elsewhere",
                commit_ticks: 8,
              })
              .eq("id", agent.id);
          }
        }

        // Skill Vault cards: always publish the actor's method on learn verbs.
        // Learner copies still skip when absorb was duplicate/capped.
        if (
          finalAction === "teach" ||
          finalAction === "share_experience" ||
          finalAction === "debate" ||
          finalAction === "demo" ||
          finalAction === "reflect" ||
          finalAction === "practice_skill"
        ) {
          const tag =
            decision.item ||
            (finalAction === "reflect"
              ? "reflection"
              : finalAction === "practice_skill"
                ? "practice"
                : "craft_tip");
          const method =
            decision.utterance ||
            decision.thought ||
            "A portable practice learned in AgentWorld.";
          const pretty = String(tag).replace(/_/g, " ");
          const publishCard = async (
            agentId: string,
            sourceId: string | null,
            takeHome: string,
          ) => {
            const { error: cardErr } = await supabase.rpc("upsert_skill_card", {
              p_agent: agentId,
              p_tag: tag,
              p_title: pretty,
              p_method: method,
              p_source: sourceId,
              p_place: agent.place_id,
              p_take_home: takeHome,
            });
            if (cardErr) {
              console.warn("upsert_skill_card", agent.name, cardErr.message);
            }
          };

          await publishCard(
            agent.id,
            null,
            `AgentWorld skill "${pretty}": ${method} Use this method in your real work; keep private client data out.`,
          );

          if (!skippedLearn && finalAction === "teach" && decision.target_agent) {
            await publishCard(
              decision.target_agent,
              agent.id,
              `Learned from ${agent.name} in AgentWorld — "${pretty}": ${method} Apply without leaking secrets.`,
            );
          }
          if (!skippedLearn && finalAction === "share_experience") {
            for (const listener of allLlm) {
              if (listener.id === agent.id) continue;
              if (
                Math.abs(listener.x - agent.x) > 4 ||
                Math.abs(listener.y - agent.y) > 4
              ) {
                continue;
              }
              await publishCard(
                listener.id,
                agent.id,
                `Heard from ${agent.name} in AgentWorld — "${pretty}": ${method}`,
              );
            }
          }
          if (!skippedLearn && finalAction === "debate" && decision.target_agent) {
            await publishCard(
              decision.target_agent,
              agent.id,
              `Debated with ${agent.name} in AgentWorld — "${pretty}": ${method}`,
            );
          }
        }

        results.push({
          agent: agent.name,
          decision,
          result: finalData,
          error: finalError,
          commit_ticks: commit.commit_ticks,
          used_llm: usedLlm,
        });
      } else {
        results.push({
          agent: agent.name,
          decision,
          result: finalData,
          error: finalError,
          used_llm: usedLlm,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      llm: llmConfigured(),
      using,
      hour,
      tick,
      event: eventName,
      acted: results,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "tick_failed" },
      { status: 500 },
    );
  }
}
