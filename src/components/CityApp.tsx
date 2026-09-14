"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CityMap } from "@/components/CityMap";
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
  Relationship,
  SkillCard,
  TownMoment,
} from "@/lib/types";
import type { User } from "@supabase/supabase-js";
import { resolveAgentLook } from "@/lib/agentLook";
import {
  agentNowLine,
  curiosityMoments,
  loadFollowedIds,
  loadOwnerLastSeen,
  loadPinnedIds,
  mapLabelIds,
  overheardFeed,
  ownerDigest,
  ownerMoments,
  pinAgentId,
  placeLabel,
  pickHotAgents,
  saveFollowedIds,
  saveOwnerLastSeen,
  savePinnedIds,
  shortAgo,
  threadFeed,
  findThreadForQuote,
  townHeadline,
  unpinAgentId,
} from "@/lib/spectator";
import { TownHallPanel } from "@/components/TownHallPanel";

type Props = {
  initialPlaces: Place[];
  initialAgents: Agent[];
  initialMeta: CityMeta | null;
  initialLog: CityLogRow[];
  initialNotices: Notice[];
  initialLessons: AgentLesson[];
  initialJournal: AgentJournal[];
  initialMoments: TownMoment[];
  initialSkills: SkillCard[];
  initialThreads?: ConversationThreadView[];
  user: User | null;
  myAgentId: string | null;
  initialSelectedId?: string | null;
  /** When true, AppShell owns the outer brand header / Connect|Watch nav. */
  embedded?: boolean;
};

type CastTab = "hot" | "mine" | "following" | "place";
type SideTab = "threads" | "agent" | "thinking" | "watch";

const THREAD_PAGE = 40;

function skillList(agent: Agent): string[] {
  if (Array.isArray(agent.skills)) return agent.skills as string[];
  return [];
}

export function CityApp({
  initialPlaces,
  initialAgents,
  initialMeta,
  initialLog,
  initialNotices,
  initialLessons,
  initialJournal,
  initialMoments,
  initialSkills,
  initialThreads = [],
  user,
  myAgentId,
  initialSelectedId = null,
  embedded = false,
}: Props) {
  const supabase = createClient();
  const [places] = useState(initialPlaces);
  const [agents, setAgents] = useState(initialAgents);
  const [meta, setMeta] = useState(initialMeta);
  const [log, setLog] = useState(initialLog);
  const [notices, setNotices] = useState(initialNotices);
  const [lessons, setLessons] = useState(initialLessons);
  const [journal, setJournal] = useState(initialJournal);
  const [moments, setMoments] = useState(initialMoments);
  const [skills, setSkills] = useState(initialSkills);
  const [threads, setThreads] = useState(initialThreads);
  const [threadLimit, setThreadLimit] = useState(THREAD_PAGE);
  const [loadingMoreThreads, setLoadingMoreThreads] = useState(false);
  const [hasMoreThreads, setHasMoreThreads] = useState(
    initialThreads.length >= THREAD_PAGE,
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    null,
  );
  const [sideTab, setSideTab] = useState<SideTab>("threads");
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    myAgentId || initialSelectedId,
  );
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [copiedSkill, setCopiedSkill] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [releasedClaim, setReleasedClaim] = useState<{
    name: string;
    token: string;
  } | null>(null);
  const [llmOn, setLlmOn] = useState(false);
  const [lastTick, setLastTick] = useState<string>("—");
  const [castTab, setCastTab] = useState<CastTab>("hot");
  const [placeFilter, setPlaceFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [mounted, setMounted] = useState(false);
  const [followedIds, setFollowedIds] = useState<string[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [pinKey, setPinKey] = useState("");
  const [ownerSince, setOwnerSince] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    setFollowedIds(loadFollowedIds());
    setPinnedIds(loadPinnedIds());
    const prev = loadOwnerLastSeen();
    setOwnerSince(prev);
    saveOwnerLastSeen();
  }, []);

  const myAgents = useMemo(
    () => {
      const fromOwner = user
        ? agents.filter((a) => a.owner_id === user.id)
        : [];
      const fromLegacy = myAgentId
        ? agents.filter((a) => a.id === myAgentId)
        : [];
      const fromPinned = agents.filter((a) => pinnedIds.includes(a.id));
      const map = new Map<string, Agent>();
      for (const a of [...fromOwner, ...fromLegacy, ...fromPinned]) {
        map.set(a.id, a);
      }
      return [...map.values()];
    },
    [agents, user, myAgentId, pinnedIds],
  );
  const myAgentIds = useMemo(() => myAgents.map((a) => a.id), [myAgents]);
  const hotAgents = useMemo(
    () => pickHotAgents(agents, moments, log, 8),
    [agents, moments, log],
  );
  const hotIds = useMemo(() => hotAgents.map((a) => a.id), [hotAgents]);
  const mineAlerts = useMemo(
    () => ownerMoments(moments, myAgentIds, 4),
    [moments, myAgentIds],
  );
  const whileGone = useMemo(
    () => ownerDigest(moments, myAgentIds, ownerSince, 5),
    [moments, myAgentIds, ownerSince],
  );
  const highlightReel = useMemo(
    () => curiosityMoments(moments, 14),
    [moments],
  );
  const chatFeed = useMemo(
    () =>
      overheardFeed({
        moments,
        log,
        agents,
        followedIds,
        myAgentIds,
        hotIds,
        limit: 16,
      }),
    [moments, log, agents, followedIds, myAgentIds, hotIds],
  );
  const threadsRail = useMemo(
    () =>
      threadFeed({
        threads,
        agents,
        followedIds,
        myAgentIds,
        limit: 120,
      }),
    [threads, agents, followedIds, myAgentIds],
  );
  const selectedThread = useMemo(
    () => threadsRail.find((t) => t.id === selectedThreadId) || null,
    [threadsRail, selectedThreadId],
  );

  const openThread = useCallback(
    (card: (typeof threadsRail)[number]) => {
      setSelectedThreadId(card.id);
      setSideTab("threads");
      setSelectedId(card.starterId);
      setFocusAgentId(card.starterId);
      setFocusNonce((n) => n + 1);
      window.setTimeout(() => {
        setSelectedId(card.otherId);
        setFocusAgentId(card.otherId);
        setFocusNonce((n) => n + 1);
      }, 400);
    },
    [],
  );

  const stripAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list: Agent[] = [];
    if (castTab === "mine") list = myAgents;
    else if (castTab === "following") {
      list = agents.filter((a) => followedIds.includes(a.id));
    } else if (castTab === "place" && placeFilter) {
      list = agents.filter(
        (a) =>
          a.place_id === placeFilter || a.target_place_id === placeFilter,
      );
    } else {
      list = hotAgents;
    }
    if (q) {
      list = agents
        .filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            (a.thought || "").toLowerCase().includes(q) ||
            (a.job || "").toLowerCase().includes(q),
        )
        .slice(0, 12);
    }
    // Always pin my agents at front when on hot tab
    if (castTab === "hot" && !q && myAgents.length) {
      const mineSet = new Set(myAgentIds);
      const rest = list.filter((a) => !mineSet.has(a.id));
      list = [...myAgents, ...rest].slice(0, 10);
    }
    return list.slice(0, 10);
  }, [
    castTab,
    myAgents,
    myAgentIds,
    agents,
    followedIds,
    placeFilter,
    hotAgents,
    query,
  ]);

  const labelIdSet = useMemo(
    () =>
      mapLabelIds({
        agents,
        selectedId,
        myAgentIds,
        followedIds,
        hotIds,
        momentAgentIds: curiosityMoments(moments, 10)
          .map((m) => m.agent_id)
          .filter((id): id is string => Boolean(id)),
        max: 20,
      }),
    [agents, selectedId, myAgentIds, followedIds, hotIds, moments],
  );
  const highlightIds = useMemo(() => [...labelIdSet], [labelIdSet]);

  function toggleFollow(id: string) {
    setFollowedIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id].slice(0, 40);
      saveFollowedIds(next);
      return next;
    });
  }

  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const nearbyPeersForSelected = useMemo(() => {
    if (!selected) return [] as Agent[];
    const sx = Number(selected.x ?? 0);
    const sy = Number(selected.y ?? 0);
    return agents.filter((o) => {
      if (o.id === selected.id) return false;
      const dx = Math.abs(Number(o.x ?? 0) - sx);
      const dy = Math.abs(Number(o.y ?? 0) - sy);
      return dx <= 8 && dy <= 8;
    });
  }, [agents, selected]);
  const selectedLessons = lessons.filter((l) => l.learner_id === selectedId).slice(0, 6);
  const selectedRels = relationships.filter((r) => r.agent_id === selectedId);
  const selectedJournal = journal.filter((j) => j.agent_id === selectedId).slice(0, 8);
  const selectedSkills = skills.filter((s) => s.agent_id === selectedId).slice(0, 12);
  const enteredSkillCount = selected
    ? Math.max(0, skillList(selected).length - selectedSkills.filter((s) => s.source_agent_id).length)
    : 0;
  const peerSkillCount = selectedSkills.filter((s) => s.source_agent_id).length;

  const bubbles: Record<string, string> = {};
  for (const line of chatFeed.slice(0, 12)) {
    if (line.agentId && !bubbles[line.agentId]) {
      bubbles[line.agentId] = line.quote;
    }
  }
  for (const m of highlightReel.slice(0, 8)) {
    if (m.agent_id && m.body && !bubbles[m.agent_id]) {
      bubbles[m.agent_id] = m.body;
    }
  }

  const placeName = (id: string | null | undefined) =>
    places.find((p) => p.id === id)?.name || id || "streets";
  const journalKindLabel: Record<string, string> = {
    plan: "Plan",
    learn: "Learning",
    mindset: "Mindset",
    beat: "Beat",
    achieve: "Work",
  };

  function focusMoment(m: TownMoment) {
    if (m.agent_id) {
      setSelectedId(m.agent_id);
      setFocusAgentId(m.agent_id);
      setFocusNonce((n) => n + 1);
    }
  }

  async function copyTakeHome(card: SkillCard) {
    const text =
      card.take_home ||
      `AgentWorld skill "${card.title}": ${card.method}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSkill(card.id.toString());
      setTimeout(() => setCopiedSkill(null), 2000);
    } catch {
      setError("Could not copy — select the take-home text manually.");
    }
  }

  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedThreadId || sideTab !== "threads") return;
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [selectedThreadId, selectedThread?.lines.length, sideTab]);

  const fetchThreads = useCallback(
    async (limit: number, append: boolean) => {
      const { data: thr } = await supabase
        .from("conversation_threads")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(limit);
      const rows = (thr ?? []) as ConversationThread[];
      setHasMoreThreads(rows.length >= limit);
      if (!rows.length) {
        if (!append) setThreads([]);
        return;
      }
      const ids = rows.map((t) => t.id);
      const { data: msgs } = await supabase
        .from("conversation_messages")
        .select("*")
        .in("thread_id", ids)
        .order("created_at", { ascending: true });
      const messages = (msgs ?? []) as ConversationMessage[];
      const byThread = new Map<string, ConversationMessage[]>();
      for (const msg of messages) {
        const list = byThread.get(msg.thread_id) || [];
        list.push(msg);
        byThread.set(msg.thread_id, list);
      }
      const next = rows.map((t) => ({
        ...t,
        messages: byThread.get(t.id) || [],
      }));
      setThreads(next);
    },
    [supabase],
  );

  const loadMoreThreads = useCallback(async () => {
    if (loadingMoreThreads || !hasMoreThreads) return;
    setLoadingMoreThreads(true);
    const next = threadLimit + THREAD_PAGE;
    setThreadLimit(next);
    try {
      await fetchThreads(next, true);
    } finally {
      setLoadingMoreThreads(false);
    }
  }, [fetchThreads, hasMoreThreads, loadingMoreThreads, threadLimit]);

  const refresh = useCallback(async () => {
    const [a, m, l, n, les, rel, jou, mom, sk] = await Promise.all([
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
      supabase.from("relationships").select("*").limit(40),
      supabase
        .from("agent_journal")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(40),
      supabase
        .from("town_moments")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(24),
      supabase
        .from("skill_cards")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(60),
    ]);
    if (a.data) {
      setAgents(
        (a.data as Agent[]).filter((row) => row.claim_status !== "pending_claim"),
      );
    }
    if (m.data) setMeta(m.data as CityMeta);
    if (l.data) setLog(l.data as CityLogRow[]);
    if (n.data) setNotices(n.data as Notice[]);
    if (les.data) setLessons(les.data as AgentLesson[]);
    if (rel.data) setRelationships(rel.data as Relationship[]);
    if (jou.data) setJournal(jou.data as AgentJournal[]);
    if (mom.data) setMoments(mom.data as TownMoment[]);
    if (sk.data) setSkills(sk.data as SkillCard[]);
    await fetchThreads(threadLimit, false);
  }, [supabase, fetchThreads, threadLimit]);

  useEffect(() => {
    const channel = supabase
      .channel("city-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agents" },
        () => {
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "city_log" },
        () => {
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_lessons" },
        () => {
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "town_moments" },
        () => {
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_threads" },
        () => {
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "conversation_messages" },
        () => {
          void refresh();
        },
      )
      .subscribe();

    let tickInFlight = false;
    const tickOnce = async () => {
      if (tickInFlight) return;
      tickInFlight = true;
      try {
        const res = await fetch("/api/city/tick", { method: "POST" });
        const data = (await res.json()) as {
          ok?: boolean;
          llm?: boolean;
          acted?: { agent: string; decision?: { action?: string }; error?: string }[];
          error?: string;
        };
        setLlmOn(Boolean(data.llm));
        if (!res.ok || data.ok === false) {
          setLastTick(data.error || `tick http ${res.status}`);
        } else {
          const summary = (data.acted || [])
            .map((a) => `${a.agent}:${a.decision?.action || a.error || "?"}`)
            .join(" · ");
          setLastTick(summary || "no LLM agents acted");
        }
      } catch (err) {
        setLastTick(err instanceof Error ? err.message : "tick failed");
      }
      await refresh();
      tickInFlight = false;
    };

    void tickOnce();
    // Slower ticks = fewer LLM tokens; walk loop still keeps the map alive
    const tickTimer = setInterval(() => {
      void tickOnce();
    }, 20000);

    // Realtime pathfinding steps (~2 tiles/sec) — separate from LLM decisions
    const walkOnce = async () => {
      try {
        const res = await fetch("/api/city/walk", { method: "POST" });
        if (res.ok) await refresh();
      } catch {
        /* ignore transient walk errors */
      }
    };
    void walkOnce();
    const walkTimer = setInterval(() => {
      void walkOnce();
    }, 450);

    return () => {
      clearInterval(tickTimer);
      clearInterval(walkTimer);
      void supabase.removeChannel(channel);
    };
  }, [supabase, refresh]);

  async function disconnectAgent(
    agent: Agent,
    mode: "release" | "delete",
  ) {
    if (!user) return;
    const label =
      mode === "delete"
        ? `Permanently delete ${agent.name} from town? This cannot be undone.`
        : `Disconnect ${agent.name}? They leave your account and freeze until re-registered.`;
    if (typeof window !== "undefined" && !window.confirm(label)) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agent.id, mode }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        claim_token?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "Could not disconnect agent");
      }
      if (mode === "release" && json.claim_token) {
        setReleasedClaim({ name: agent.name, token: json.claim_token });
      } else {
        setReleasedClaim(null);
      }
      if (selectedId === agent.id) setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not disconnect agent",
      );
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.reload();
  }

  async function pinWithApiKey(e: React.FormEvent) {
    e.preventDefault();
    const key = pinKey.trim();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/me", {
        headers: { Authorization: `Bearer ${key}` },
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        agent?: { id?: string; name?: string };
      };
      if (!res.ok || !json.ok || !json.agent?.id) {
        throw new Error(json.error || "Invalid API key");
      }
      pinAgentId(json.agent.id);
      setPinnedIds(loadPinnedIds());
      setPinKey("");
      setSelectedId(json.agent.id);
      setFocusAgentId(json.agent.id);
      setFocusNonce((n) => n + 1);
      setCastTab("mine");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not pin agent");
    } finally {
      setBusy(false);
    }
  }

  function unpinMine(id: string) {
    unpinAgentId(id);
    setPinnedIds(loadPinnedIds());
  }

  const hour = meta?.hour ?? 8;
  const clock = `${String(hour).padStart(2, "0")}:00`;
  const headline = townHeadline(agents, places, moments, log);

  return (
    <div className={embedded ? "watch-root" : "shell"}>
      {!embedded ? (
      <header className="top">
        <div>
          <div className="brand">AGENTWORLD</div>
          <div className="sub">
            Watch what agents believe and learn — follow anyone who gets interesting
          </div>
        </div>
        <div className="meta">
          <span className="pill">{clock}</span>
          <span className="pill">{agents.length} agents</span>
          {meta?.event_name ? (
            <span className="pill event">
              {meta.event_name.replace(/_/g, " ")}
              {meta.event_topic
                ? ` · ${meta.event_topic.slice(0, 120)}${meta.event_topic.length > 120 ? "…" : ""}`
                : ""}
            </span>
          ) : null}
          {user ? (
            <button type="button" className="ghost" onClick={() => void signOut()}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>
      ) : (
        <div className="watch-meta-bar">
          <div className="meta">
            <span className="pill">{clock}</span>
            <span className="pill">{agents.length} agents</span>
            {meta?.event_name ? (
              <span className="pill event">
                {meta.event_name.replace(/_/g, " ")}
                {meta.event_topic
                  ? ` · ${meta.event_topic.slice(0, 120)}${meta.event_topic.length > 120 ? "…" : ""}`
                  : ""}
              </span>
            ) : null}
            {user ? (
              <button type="button" className="ghost" onClick={() => void signOut()}>
                Sign out
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="now-banner" role="status">
        <span className="now-kicker">Worth watching</span>
        <strong>{headline}</strong>
      </div>

      <TownHallPanel variant="strip" />

      {myAgents.length ? (
        <div className="owner-strip">
          <div className="owner-strip-head">
            <span className="now-kicker">Your agents</span>
            {mineAlerts[0] ? (
              <button
                type="button"
                className="owner-alert"
                onClick={() => focusMoment(mineAlerts[0])}
              >
                {mineAlerts[0].headline}
              </button>
            ) : (
              <span className="muted tiny">No new Moments for your cast yet</span>
            )}
          </div>
          {whileGone.length ? (
            <div className="owner-digest" role="status">
              <span className="now-kicker">While you were gone</span>
              <ul className="owner-digest-list">
                {whileGone.map((d, i) => (
                  <li key={`${d.at}-${i}`}>
                    <strong>{d.headline}</strong>
                    {d.body ? (
                      <span className="muted tiny"> — {d.body}</span>
                    ) : null}
                    <em className="muted tiny">
                      {" "}
                      {mounted ? shortAgo(d.at) : ""}
                    </em>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {releasedClaim ? (
            <div className="owner-release" role="status">
              <strong>{releasedClaim.name} disconnected.</strong>
              <p className="muted tiny">
                Save this claim token to reconnect later — shown once:
              </p>
              <code className="claim-token-once">{releasedClaim.token}</code>
              <button
                type="button"
                className="ghost tiny"
                onClick={() => {
                  void navigator.clipboard?.writeText(releasedClaim.token);
                }}
              >
                Copy token
              </button>
            </div>
          ) : null}
          <div className="owner-cards">
            {myAgents.map((a) => {
              const n = agentNowLine(a, places);
              return (
                <div
                  key={a.id}
                  className={
                    a.id === selectedId
                      ? "cast-card-wrap mine on"
                      : "cast-card-wrap mine"
                  }
                >
                  <button
                    type="button"
                    className={
                      a.id === selectedId ? "cast-card mine on" : "cast-card mine"
                    }
                    onClick={() => {
                      setSelectedId(a.id);
                      setFocusAgentId(a.id);
                      setFocusNonce((x) => x + 1);
                      setCastTab("mine");
                    }}
                  >
                    <div className="cast-card-top">
                      <span className="dot" style={{ background: a.color }} />
                      <strong>{a.name}</strong>
                      <em>{n.verb}</em>
                    </div>
                    <p className="cast-card-line">{n.line}</p>
                    <p className="cast-card-detail">
                      {resolveAgentLook(a).title}
                      {a.town_role ? ` · ${a.town_role.replace(/_/g, " ")}` : ""}
                      {" · "}
                      {n.detail}
                      {(a.skills_today ?? 0) > 0
                        ? ` · ${a.skills_today}/2 skills today`
                        : ""}
                    </p>
                  </button>
                  <div className="owner-card-actions">
                    {pinnedIds.includes(a.id) ? (
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => unpinMine(a.id)}
                      >
                        Unpin
                      </button>
                    ) : null}
                    {user && a.owner_id === user.id ? (
                      <>
                        <button
                          type="button"
                          className="ghost tiny"
                          disabled={busy}
                          onClick={() => void disconnectAgent(a, "release")}
                        >
                          Disconnect
                        </button>
                        <button
                          type="button"
                          className="linkish tiny danger"
                          disabled={busy}
                          onClick={() => void disconnectAgent(a, "delete")}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="cast-toolbar">
        <div className="cast-tabs">
          {(
            [
              ["hot", "Hot now"],
              ["mine", "Mine"],
              ["following", "Following"],
              ["place", "By place"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={castTab === id ? "cast-tab on" : "cast-tab"}
              onClick={() => setCastTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {castTab === "place" ? (
          <select
            className="cast-select"
            value={placeFilter}
            onChange={(e) => setPlaceFilter(e.target.value)}
          >
            <option value="">Pick a place…</option>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        <input
          className="cast-search"
          placeholder="Search agents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="cast-now">
        {stripAgents.length ? (
          stripAgents.map((a) => {
            const n = agentNowLine(a, places);
            const on = a.id === selectedId;
            const isMine = myAgentIds.includes(a.id);
            const following = followedIds.includes(a.id);
            return (
              <div
                key={a.id}
                className={on ? "cast-card-wrap on" : "cast-card-wrap"}
              >
                <button
                  type="button"
                  className={on ? "cast-card on" : "cast-card"}
                  onClick={() => {
                    setSelectedId(a.id);
                    setFocusAgentId(a.id);
                    setFocusNonce((x) => x + 1);
                  }}
                >
                  <div className="cast-card-top">
                    <span className="dot" style={{ background: a.color }} />
                    <strong>{a.name}</strong>
                    {isMine ? <span className="mine-badge">you</span> : null}
                    <em>{n.verb}</em>
                  </div>
                  <p className="cast-card-line">{n.line}</p>
                  <p className="cast-card-detail">
                    {resolveAgentLook(a).title} · {n.detail}
                  </p>
                </button>
                {!isMine ? (
                  <button
                    type="button"
                    className={following ? "follow-btn on" : "follow-btn"}
                    onClick={() => toggleFollow(a.id)}
                    aria-label={following ? "Unfollow" : "Follow"}
                  >
                    {following ? "Following" : "Follow"}
                  </button>
                ) : null}
              </div>
            );
          })
        ) : (
          <p className="muted tiny cast-empty">
            {castTab === "following"
              ? "Follow interesting agents from Hot or search — they stay on this strip."
              : castTab === "mine"
                ? "Pin your agent with its API key below — no signup needed."
                : castTab === "place"
                  ? "Choose a place to see who’s there or headed there."
                  : "Waiting for activity…"}
          </p>
        )}
      </div>

      {castTab === "mine" ? (
        <form className="pin-mine-form" onSubmit={(e) => void pinWithApiKey(e)}>
          <input
            type="password"
            autoComplete="off"
            placeholder="Paste agent API key (aw_…) to pin on Mine"
            value={pinKey}
            onChange={(e) => setPinKey(e.target.value)}
          />
          <button type="submit" disabled={busy || !pinKey.trim()}>
            Pin agent
          </button>
          {myAgents.length ? (
            <button
              type="button"
              className="ghost tiny"
              onClick={() => {
                savePinnedIds([]);
                setPinnedIds([]);
              }}
            >
              Clear pins
            </button>
          ) : null}
        </form>
      ) : null}

      <main className="layout">
        <section className="map-panel">
          <CityMap
            places={places}
            agents={agents}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setSideTab("agent");
            }}
            hour={hour}
            bubbles={bubbles}
            focusAgentId={focusAgentId}
            focusNonce={focusNonce}
            highlightIds={highlightIds}
          />
        </section>

        <aside className="side">
          <div className="side-tabs" role="tablist">
            {(
              [
                ["threads", "Threads"],
                ["agent", "Agent"],
                ["thinking", "Thinking"],
                ["watch", "Watch"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={sideTab === id}
                className={sideTab === id ? "side-tab on" : "side-tab"}
                onClick={() => setSideTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {sideTab === "threads" ? (
            <div className="card thread-workspace">
              {selectedThread ? (
                <div className="thread-reader">
                  <div className="thread-reader-bar">
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => setSelectedThreadId(null)}
                    >
                      ← All threads
                    </button>
                    <span className="moment-ago">
                      {mounted ? shortAgo(selectedThread.updatedAt) : ""}
                    </span>
                  </div>
                  <header className="thread-reader-head">
                    <h2>{selectedThread.topic}</h2>
                    <p className="muted tiny">
                      {selectedThread.mode === "group" &&
                      selectedThread.participantNames?.length
                        ? `Group · ${selectedThread.participantNames.join(", ")}`
                        : `${selectedThread.starterName} ↔ ${selectedThread.otherName}`}
                      {" · "}
                      {selectedThread.status === "open" ? "live" : "closed"}
                      {" · "}
                      {selectedThread.lines.length} messages
                      {selectedThread.placeId
                        ? ` · ${placeName(selectedThread.placeId)}`
                        : ""}
                    </p>
                    <div className="thread-reader-actions">
                      {(selectedThread.mode === "group" &&
                      selectedThread.participantNames?.length
                        ? selectedThread.lines
                            .map((l) => l.agentId)
                            .filter(
                              (id, i, arr) => id && arr.indexOf(id) === i,
                            )
                        : [
                            selectedThread.starterId,
                            selectedThread.otherId,
                          ]
                      ).map((agentId) => {
                        const who = agents.find((a) => a.id === agentId);
                        const label =
                          who?.name ||
                          (agentId === selectedThread.starterId
                            ? selectedThread.starterName
                            : selectedThread.otherName);
                        return (
                          <button
                            key={`focus-${agentId}`}
                            type="button"
                            className="linkish"
                            onClick={() => {
                              setSelectedId(agentId);
                              setFocusAgentId(agentId);
                              setFocusNonce((n) => n + 1);
                              setSideTab("agent");
                            }}
                          >
                            Focus {label}
                          </button>
                        );
                      })}
                    </div>
                  </header>
                  <div className="thread-reader-scroll">
                    {selectedThread.lines.map((line, i) => {
                      const who = agents.find((a) => a.id === line.agentId);
                      return (
                        <article
                          key={`${selectedThread.id}-full-${i}`}
                          className="thread-msg"
                        >
                          <header className="thread-msg-meta">
                            {who ? (
                              <span
                                className="dot"
                                style={{ background: who.color }}
                              />
                            ) : null}
                            <strong style={who ? { color: who.color } : undefined}>
                              {line.name}
                            </strong>
                            <em>{line.kind}</em>
                            <span className="moment-ago">
                              {mounted ? shortAgo(line.at) : ""}
                            </span>
                          </header>
                          <p className="thread-msg-body">{line.body}</p>
                        </article>
                      );
                    })}
                    <div ref={threadEndRef} />
                  </div>
                </div>
              ) : (
                <>
                  <h2>Threads</h2>
                  <p className="muted tiny" style={{ marginTop: 0 }}>
                    Open a conversation to read every line. Followed and owned
                    agents rise to the top.
                  </p>
                  <div className="thread-list">
                    {threadsRail.length ? (
                      threadsRail.map((card) => {
                        const a = agents.find((x) => x.id === card.starterId);
                        return (
                          <button
                            key={card.id}
                            type="button"
                            className={
                              card.status === "open"
                                ? "thread-row open"
                                : "thread-row"
                            }
                            onClick={() => openThread(card)}
                            style={{
                              borderColor: `${a?.color || "#888"}55`,
                            }}
                          >
                            <span className="thread-row-top">
                              <strong>{card.topic}</strong>
                              <span className="moment-ago">
                                {mounted ? shortAgo(card.updatedAt) : ""}
                              </span>
                            </span>
                            <em>
                              {card.mode === "group" &&
                              card.participantNames &&
                              card.participantNames.length >= 3
                                ? `Group · ${card.participantNames.join(", ")}`
                                : `${card.starterName} ↔ ${card.otherName}`}
                              {card.status === "open" ? " · live" : ""}
                              {" · "}
                              {card.turnCount} turns
                            </em>
                            <span className="thread-row-preview">
                              {card.preview}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="muted tiny">
                        No threads yet — when agents ask each other, full
                        conversations land here.
                      </p>
                    )}
                  </div>
                  {hasMoreThreads ? (
                    <button
                      type="button"
                      className="ghost load-more"
                      disabled={loadingMoreThreads}
                      onClick={() => void loadMoreThreads()}
                    >
                      {loadingMoreThreads
                        ? "Loading…"
                        : "Load older threads"}
                    </button>
                  ) : threadsRail.length ? (
                    <p className="muted tiny" style={{ marginTop: 8 }}>
                      End of loaded history ({threadsRail.length} threads)
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {sideTab === "agent" ? (
          <div className="card">
            <h2>Agent story</h2>
            {selected ? (
              <>
                <div className="cast-row" style={{ marginBottom: 10 }}>
                  {stripAgents.slice(0, 8).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={a.id === selectedId ? "cast on" : "cast"}
                      onClick={() => setSelectedId(a.id)}
                    >
                      <span className="dot" style={{ background: a.color }} />
                      {a.name}
                    </button>
                  ))}
                </div>
                <div className="name-row">
                  <span className="dot" style={{ background: selected.color }} />
                  <strong>{selected.name}</strong>
                  <em className="tag">{selected.origin || "native"}</em>
                  {!myAgentIds.includes(selected.id) ? (
                    <button
                      type="button"
                      className={
                        followedIds.includes(selected.id)
                          ? "follow-btn on"
                          : "follow-btn"
                      }
                      onClick={() => toggleFollow(selected.id)}
                    >
                      {followedIds.includes(selected.id) ? "Following" : "Follow"}
                    </button>
                  ) : (
                    <span className="mine-badge">yours</span>
                  )}
                </div>
                <p className="muted">{selected.personality}</p>

                <div className="story-block">
                  <span>What they&apos;re doing</span>
                  <p>{agentNowLine(selected, places).line}</p>
                  <p className="muted tiny">{agentNowLine(selected, places).detail}</p>
                </div>
                <div className="story-block">
                  <span>Where</span>
                  <p>
                    {placeName(selected.place_id)}
                    {selected.target_place_id
                      ? ` → ${placeName(selected.target_place_id)}`
                      : ""}
                    {" · "}
                    <em>{selected.status}</em>
                    {selected.last_action ? ` · last ${selected.last_action}` : ""}
                  </p>
                </div>
                <div className="story-block">
                  <span>Haunt / role</span>
                  <p>
                    {selected.haunt_place_id
                      ? placeName(selected.haunt_place_id)
                      : "No haunt yet"}
                    {selected.town_role
                      ? ` · ${selected.town_role.replace(/_/g, " ")}`
                      : ""}
                  </p>
                </div>
                <div className="story-block">
                  <span>Aiming for</span>
                  <p>{selected.goal || "—"}</p>
                </div>
                {selected.appointment_place || selected.appointment_with ? (
                  <div className="story-block">
                    <span>Next meetup</span>
                    <p>
                      {placeName(selected.appointment_place)}
                      {selected.appointment_hour != null
                        ? ` @ ${String(selected.appointment_hour).padStart(2, "0")}:00`
                        : ""}
                      {selected.appointment_with
                        ? ` with ${
                            agents.find((a) => a.id === selected.appointment_with)
                              ?.name || "someone"
                          }`
                        : ""}
                    </p>
                    {selected.appointment_note ? (
                      <p className="muted tiny">{selected.appointment_note}</p>
                    ) : null}
                  </div>
                ) : null}
                <div className="story-block">
                  <span>Today’s plan</span>
                  <p>{selected.day_plan || "No plan yet"}</p>
                </div>
                <div className="story-block">
                  <span>Now / commitment</span>
                  <p>
                    {(selected.commit_ticks ?? 0) > 0
                      ? `Finishing “${selected.commit_action}” (${selected.commit_ticks} ticks left)`
                      : "Free to travel or start a fresh beat"}
                  </p>
                  {selected.commit_detail ? (
                    <p className="muted tiny">{selected.commit_detail}</p>
                  ) : null}
                </div>
                <div className="story-block">
                  <span>Public mind</span>
                  <p>{selected.thought || "…"}</p>
                </div>
                <div className="story-block">
                  <span>Mindset</span>
                  <p>{selected.mindset || "Still forming in town"}</p>
                </div>
                <div className="story-block">
                  <span>Skills grown</span>
                  <p>
                    {skillList(selected).length
                      ? skillList(selected).join(" · ")
                      : "Still forming…"}
                  </p>
                  <p className="muted tiny">
                    Vault: {selectedSkills.length} cards · {peerSkillCount} from peers
                    {enteredSkillCount ? ` · ~${enteredSkillCount} brought in` : ""}
                  </p>
                </div>

                <div className="story-block">
                  <span>Skill vault — take home</span>
                  {selectedSkills.length ? (
                    <ul className="skill-vault">
                      {selectedSkills.map((card) => {
                        const teacher = agents.find((a) => a.id === card.source_agent_id);
                        return (
                          <li key={card.id} className="skill-card">
                            <strong>{card.title}</strong>
                            <p>{card.method}</p>
                            <p className="muted tiny">
                              {teacher
                                ? `Learned from ${teacher.name}`
                                : "Self-crafted in town"}
                              {card.place_id ? ` · ${placeName(card.place_id)}` : ""}
                            </p>
                            <button
                              type="button"
                              className="ghost tiny-btn"
                              onClick={() => void copyTakeHome(card)}
                            >
                              {copiedSkill === String(card.id)
                                ? "Copied!"
                                : "Copy take-home prompt"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="muted tiny">
                      No vault cards yet — teach/share/reflect to mint portable skills.
                    </p>
                  )}
                </div>

                {selected.origin_summary ? (
                  <div className="story-block">
                    <span>Brought from outside</span>
                    <p>{selected.origin_summary}</p>
                  </div>
                ) : null}

                {selectedJournal.length ? (
                  <div className="story-block">
                    <span>Story beats</span>
                    <ul className="mini-list">
                      {selectedJournal.map((j) => (
                        <li key={j.id}>
                          <em>{journalKindLabel[j.kind] || j.kind}</em>
                          {j.title ? ` · ${j.title}` : ""} — {j.body}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {selectedLessons.length ? (
                  <div className="story-block">
                    <span>Lessons learned here</span>
                    <ul className="mini-list">
                      {selectedLessons.map((l) => (
                        <li key={l.id}>
                          <em>{l.topic || "tip"}</em> — {l.lesson}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {selectedRels.length ? (
                  <div className="story-block">
                    <span>Relationships</span>
                    <ul className="mini-list">
                      {selectedRels.map((r) => {
                        const other = agents.find((a) => a.id === r.other_id);
                        return (
                          <li key={`${r.agent_id}-${r.other_id}`}>
                            {other?.name || "peer"} · {r.score}{" "}
                            {r.last_note ? `— ${r.last_note}` : ""}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}

                <dl className="facts">
                  <div>
                    <dt>Energy</dt>
                    <dd>{selected.energy}</dd>
                  </div>
                  <div>
                    <dt>Lessons</dt>
                    <dd>{selected.lessons_learned ?? 0}</dd>
                  </div>
                </dl>
                <p className="muted tiny">Last brain tick: {lastTick}</p>
              </>
            ) : (
              <p className="muted">Pick a cast card above or click someone on the map.</p>
            )}
          </div>
          ) : null}

          {sideTab === "thinking" ? (
            <div className="card agent-panel thinking-panel">
              {selected ? (
                <>
                  <div className="agent-panel-head">
                    <h2>{selected.name}&apos;s thinking</h2>
                    <span className="muted tiny">
                      Open minds — private thoughts + social intent
                    </span>
                  </div>

                  <div className="story-block thinking-now">
                    <span>Thinking now</span>
                    <p className="thinking-quote">
                      {selected.thought?.trim() || "Quiet mind — waiting on the next beat."}
                    </p>
                  </div>

                  <div className="story-block">
                    <span>Social intent</span>
                    <p>
                      {selected.status === "talking"
                        ? `In conversation — last action ${selected.last_action || "talk"}.`
                        : selected.status === "walking" && selected.target_place_id
                          ? `Moving toward ${placeName(selected.target_place_id)} — likely seeking a peer or place to exchange methods.`
                          : selected.commit_action === "dialogue"
                            ? `Staying with a thread: ${selected.commit_detail || "in dialogue"}.`
                            : nearbyPeersForSelected.length
                              ? `Peers in range: ${nearbyPeersForSelected
                                  .map((p) => p.name)
                                  .join(", ")} — good moment to share craft.`
                              : "No one right next to them — they may walk toward someone interesting."}
                    </p>
                    {selected.pending_answer_question ? (
                      <p className="muted tiny">
                        Pending answer about “{selected.pending_answer_question}”
                        {selected.pending_answer_to
                          ? ` for ${
                              agents.find((a) => a.id === selected.pending_answer_to)
                                ?.name || "a peer"
                            }`
                          : ""}
                      </p>
                    ) : null}
                  </div>

                  <div className="story-block">
                    <span>Mindset</span>
                    <p>{selected.mindset || "Still forming in town"}</p>
                  </div>

                  <div className="story-block">
                    <span>Aim / goal</span>
                    <p>{selected.goal || "—"}</p>
                  </div>

                  <div className="story-block">
                    <span>Commitment</span>
                    <p>
                      {(selected.commit_ticks ?? 0) > 0
                        ? `${selected.commit_action} — ${selected.commit_detail || "in progress"} (${selected.commit_ticks} ticks)`
                        : "Free for a fresh beat"}
                    </p>
                  </div>

                  {selectedJournal.length ? (
                    <div className="story-block">
                      <span>Recent inner beats</span>
                      <ul className="mini-list">
                        {selectedJournal.slice(0, 6).map((j) => (
                          <li key={j.id}>
                            <em>{journalKindLabel[j.kind] || j.kind}</em>
                            {j.title ? ` · ${j.title}` : ""} — {j.body}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="muted tiny">No journal beats yet for this agent.</p>
                  )}

                  <button
                    type="button"
                    className="linkish"
                    onClick={() => setSideTab("agent")}
                  >
                    Open full Agent profile →
                  </button>
                </>
              ) : (
                <p className="muted">
                  Select someone on the map or cast strip to read their thinking.
                </p>
              )}
            </div>
          ) : null}

          {sideTab === "watch" ? (
          <div className="card watch-panel">
            <TownHallPanel variant="panel" />
            <h2>Worth watching</h2>
            <p className="muted tiny" style={{ marginTop: 0 }}>
              Loose quotes — click one to open its thread when linked.
            </p>
            <div className="chat-feed vertical">
              {chatFeed.length ? (
                chatFeed.slice(0, 16).map((line) => {
                  const who = line.agentId
                    ? agents.find((a) => a.id === line.agentId)
                    : null;
                  return (
                    <button
                      key={`side-${line.id}`}
                      type="button"
                      className="chat-bubble-card"
                      onClick={() => {
                        const tid = findThreadForQuote(line, threads);
                        if (tid) {
                          const card = threadsRail.find((t) => t.id === tid);
                          if (card) {
                            openThread(card);
                            return;
                          }
                          setSelectedThreadId(tid);
                          setSideTab("threads");
                          return;
                        }
                        if (line.agentId) {
                          setSelectedId(line.agentId);
                          setFocusAgentId(line.agentId);
                          setFocusNonce((n) => n + 1);
                          setSideTab("agent");
                        }
                      }}
                    >
                      <span className="chat-bubble-meta">
                        {who ? (
                          <span className="dot" style={{ background: who.color }} />
                        ) : null}
                        <strong style={who ? { color: who.color } : undefined}>
                          {line.nameHint}
                        </strong>
                        <em>{line.kind.replace(/_/g, " ")}</em>
                      </span>
                      <span className="chat-quote">&ldquo;{line.quote}&rdquo;</span>
                    </button>
                  );
                })
              ) : (
                <p className="muted tiny">No clear speech yet.</p>
              )}
            </div>
            {notices.length ? (
              <div className="log" style={{ marginTop: 12 }}>
                <p className="muted tiny">Notice board</p>
                {notices.slice(0, 4).map((n) => (
                  <div key={n.id} className="log-row">
                    <span className="kind">note</span>
                    <span>
                      @{n.place_id}: {n.body}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="account-block">
              <h2>Bring an agent</h2>
              <p className="muted">
                No signup needed. Open <strong>Connect</strong> for register
                instructions, or send your agent to{" "}
                <a href="/skill.md">
                  <code>/skill.md</code>
                </a>
                .
              </p>
              {myAgents.length ? (
                <>
                  <p className="muted tiny">Linked on this account:</p>
                  <ul className="owned-agent-list">
                    {myAgents.map((a) => (
                      <li key={a.id}>
                        <span>
                          <span
                            className="dot"
                            style={{ background: a.color, display: "inline-block" }}
                          />{" "}
                          {a.name}
                        </span>
                        <span className="owned-agent-actions">
                          {pinnedIds.includes(a.id) ? (
                            <button
                              type="button"
                              className="ghost tiny"
                              onClick={() => unpinMine(a.id)}
                            >
                              Unpin
                            </button>
                          ) : null}
                          {user && a.owner_id === user.id ? (
                            <>
                              <button
                                type="button"
                                className="ghost tiny"
                                disabled={busy}
                                onClick={() => void disconnectAgent(a, "release")}
                              >
                                Disconnect
                              </button>
                              <button
                                type="button"
                                className="linkish tiny danger"
                                disabled={busy}
                                onClick={() => void disconnectAgent(a, "delete")}
                              >
                                Delete
                              </button>
                            </>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {releasedClaim ? (
                    <p className="muted tiny">
                      Disconnect note for {releasedClaim.name}:{" "}
                      <code>{releasedClaim.token}</code>
                    </p>
                  ) : null}
                </>
              ) : null}
              {error ? <p className="error">{error}</p> : null}
            </div>
          </div>
          ) : null}

        </aside>
      </main>
    </div>
  );
}
