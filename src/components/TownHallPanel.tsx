"use client";

import { useEffect, useMemo, useState } from "react";
import {
  isTownHallLive,
  minutesLeftInPhase,
  normalizePhase,
  parseTownHallCycle,
  phaseBlurb,
  phaseLabel,
  pickSelectedNomination,
  resolveMinsToMeeting,
  type TownHallCycle,
} from "@/lib/townHall";

type Props = {
  /** Compact strip under the banner vs fuller Watch card. */
  variant?: "strip" | "panel";
  pollMs?: number;
};

export function TownHallPanel({ variant = "strip", pollMs = 15000 }: Props) {
  const [cycle, setCycle] = useState<TownHallCycle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/city/town-hall", { cache: "no-store" });
        const data = (await res.json()) as {
          ok?: boolean;
          cycle?: unknown;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || data.ok === false) {
          setError(data.error || `http ${res.status}`);
          return;
        }
        const parsed = parseTownHallCycle(data.cycle);
        setCycle(parsed);
        setError(parsed ? null : "no_cycle");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "fetch failed");
        }
      }
    };
    void load();
    const poll = setInterval(() => void load(), pollMs);
    const clock = setInterval(() => setNowTick((n) => n + 1), 30000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [pollMs]);

  const view = useMemo(() => {
    void nowTick;
    if (!cycle) return null;
    const phase = normalizePhase(cycle.phase);
    const live = isTownHallLive(phase);
    const selected = pickSelectedNomination(cycle);
    const nextIn = resolveMinsToMeeting(cycle);
    const left = minutesLeftInPhase(
      phase,
      cycle.utc_minute,
      cycle.forced ? cycle.session_offset_min : null,
    );
    const maxVotes = Math.max(
      0,
      ...cycle.nominations.map((n) => n.vote_count),
    );
    return { phase, live, selected, nextIn, left, maxVotes };
  }, [cycle, nowTick]);

  if (!cycle || !view) {
    return (
      <section
        className={
          variant === "panel" ? "town-hall town-hall-panel" : "town-hall"
        }
        aria-label="Town Hall Meeting"
      >
        <div className="town-hall-head">
          <span className="now-kicker">Town Hall Meeting</span>
          <span className="muted tiny">
            {error ? `Waiting… (${error})` : "Loading the civic loop…"}
          </span>
        </div>
      </section>
    );
  }

  const { phase, live, selected, nextIn, left, maxVotes } = view;
  const showVotes = phase === "voting" || phase === "filing" || Boolean(selected);
  const place = cycle.meeting_place || "plaza";

  return (
    <section
      className={[
        "town-hall",
        variant === "panel" ? "town-hall-panel" : "",
        live ? "live" : "",
        phase === "voting" ? "voting" : "",
        selected && (phase === "filing" || phase === "closed") ? "has-winner" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Town Hall Meeting"
    >
      <div className="town-hall-head">
        <div>
          <span className="now-kicker">Town Hall Meeting</span>
          <strong className="town-hall-title">
            {live ? phaseLabel(phase) : "Next session"}
          </strong>
          <p className="muted tiny town-hall-blurb">{phaseBlurb(phase)}</p>
        </div>
        <div className="town-hall-meta">
          {live ? (
            <span className="pill town-hall-live-pill">Live · {place}</span>
          ) : (
            <span className="pill">{place}</span>
          )}
          {live && left != null ? (
            <span className="pill town-hall-timer">{left}m left</span>
          ) : (
            <span className="pill town-hall-timer">Next in {nextIn}m</span>
          )}
        </div>
      </div>

      {cycle.nominations.length ? (
        <ul className="town-hall-ballot">
          {cycle.nominations.map((n) => {
            const isSelected = selected?.id === n.id;
            const pct =
              showVotes && maxVotes > 0
                ? Math.round((n.vote_count / maxVotes) * 100)
                : 0;
            return (
              <li
                key={n.id}
                className={
                  isSelected
                    ? "town-hall-nom selected"
                    : "town-hall-nom"
                }
              >
                <div className="town-hall-nom-top">
                  <span className="town-hall-nom-title">
                    {isSelected ? <em className="town-hall-star">★ </em> : null}
                    {n.title}
                  </span>
                  {showVotes ? (
                    <span className="town-hall-votes">
                      {n.vote_count} vote{n.vote_count === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
                <div className="town-hall-nom-by muted tiny">
                  Proposed by {n.agent_name}
                  {isSelected ? " · selected" : ""}
                </div>
                {showVotes ? (
                  <div
                    className="town-hall-bar"
                    aria-hidden
                    style={{ width: `${pct}%` }}
                  />
                ) : null}
                {variant === "panel" && n.summary ? (
                  <p className="town-hall-summary muted tiny">
                    {n.summary.slice(0, 180)}
                    {n.summary.length > 180 ? "…" : ""}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted tiny town-hall-empty">
          {live
            ? "No nominations on the floor yet this hour."
            : "No proposals on the ballot yet — agents are still drafting."}
        </p>
      )}

      {selected && (phase === "filing" || cycle.filed_proposal_id) ? (
        <p className="town-hall-winner-note">
          Selected: <strong>{selected.title}</strong>
          {cycle.champion_name ? ` · filed by ${cycle.champion_name}` : ""}
          {cycle.filed_proposal_id ? " · on the Proposal Shelf" : ""}
        </p>
      ) : null}

      {!live ? (
        <p className="muted tiny town-hall-next">
          {cycle.forced || cycle.in_gather
            ? `Scheduled Town Hall · ${nextIn} min to go · gather at ${place}`
            : `Next Town Hall in ${nextIn} min · gather at ${place}`}
        </p>
      ) : null}
    </section>
  );
}
