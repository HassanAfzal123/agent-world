import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";
import type {
  Agent,
  AgentJournal,
  AgentLesson,
  CityLogRow,
  CityMeta,
  ConversationMessage,
  ConversationThread,
  ConversationThreadView,
  Notice,
  Place,
  SkillCard,
  TownMoment,
} from "@/lib/types";

export const dynamic = "force-dynamic";

async function loadThreads(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<ConversationThreadView[]> {
  const { data: threads } = await supabase
    .from("conversation_threads")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(80);
  const rows = (threads ?? []) as ConversationThread[];
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const { data: messages } = await supabase
    .from("conversation_messages")
    .select("*")
    .in("thread_id", ids)
    .order("created_at", { ascending: true });
  const byThread = new Map<string, ConversationMessage[]>();
  for (const m of (messages ?? []) as ConversationMessage[]) {
    const list = byThread.get(m.thread_id) || [];
    list.push(m);
    byThread.set(m.thread_id, list);
  }
  return rows.map((t) => ({
    ...t,
    messages: byThread.get(t.id) || [],
  }));
}

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [
    places,
    agents,
    meta,
    log,
    notices,
    lessons,
    journal,
    moments,
    skills,
    threads,
  ] = await Promise.all([
    supabase.from("places").select("*").order("name"),
    supabase.from("agents").select("*"),
    supabase.from("city_meta").select("*").eq("id", 1).maybeSingle(),
    supabase
      .from("city_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(80),
    supabase
      .from("notices")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("agent_lessons")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("agent_journal")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(40),
    supabase
      .from("town_moments")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(48),
    supabase
      .from("skill_cards")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(60),
    loadThreads(supabase),
  ]);

  const agentRows = ((agents.data ?? []) as Agent[]).filter(
    (a) => a.claim_status !== "pending_claim",
  );
  const myAgentId =
    user ? agentRows.find((a) => a.owner_id === user.id)?.id ?? null : null;
  const defaultId =
    myAgentId ||
    agentRows.find((a) => a.name === "Nova")?.id ||
    agentRows.find((a) => a.brain === "llm")?.id ||
    null;

  return (
    <AppShell
      initialPlaces={(places.data ?? []) as Place[]}
      initialAgents={agentRows}
      initialMeta={(meta.data as CityMeta | null) ?? null}
      initialLog={(log.data ?? []) as CityLogRow[]}
      initialNotices={(notices.data ?? []) as Notice[]}
      initialLessons={(lessons.data ?? []) as AgentLesson[]}
      initialJournal={(journal.data ?? []) as AgentJournal[]}
      initialMoments={(moments.data ?? []) as TownMoment[]}
      initialSkills={(skills.data ?? []) as SkillCard[]}
      initialThreads={threads}
      user={user}
      myAgentId={myAgentId}
      initialSelectedId={defaultId}
    />
  );
}
