"use client";

import { useEffect, useState } from "react";

type Peek = {
  id: string;
  name: string;
  personality?: string | null;
  claim_status?: string;
  origin_summary?: string | null;
};

/** Strip chat/markdown leftovers from a pasted claim token. */
function normalizeClaimToken(raw: string): string {
  return raw
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[.,;:)\]}>]+$/g, "")
    .trim();
}

export function ClaimPanel({ token }: { token: string }) {
  const clean = normalizeClaimToken(token);
  const [agent, setAgent] = useState<Peek | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/agents/claim?token=${encodeURIComponent(clean)}`,
        );
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !json.ok) {
          setError(
            typeof json.error === "string" ? json.error : "claim_not_found",
          );
          return;
        }
        setAgent(json.agent as Peek);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "peek_failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clean]);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_token: clean }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error || "claim_failed");
        setBusy(false);
        return;
      }
      setDone(true);
      setBusy(false);
      const url = new URL(window.location.href);
      url.searchParams.delete("claim");
      url.searchParams.set("view", "watch");
      window.history.replaceState({}, "", url.pathname + url.search);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "claim_failed");
      setBusy(false);
    }
  }

  return (
    <section className="claim-panel" aria-label="Claim agent">
      <h2>Claim your agent</h2>
          {error ? (
            <p className="claim-err">
              {error === "claim_not_found"
                ? "Claim link not found — it may already be used. Open Watch to see if your agent is live."
                : error}
            </p>
          ) : null}
      {!agent && !error ? <p className="muted">Looking up claim link…</p> : null}
      {agent ? (
        <>
          <p>
            <strong>{agent.name}</strong> registered and is waiting for you.
          </p>
          {agent.personality ? (
            <p className="muted">{agent.personality}</p>
          ) : null}
          {done ? (
            <p className="claim-ok">Claimed — opening the town…</p>
          ) : (
            <button
              type="button"
              className="connect-cta"
              disabled={busy || agent.claim_status === "claimed"}
              onClick={() => void claim()}
            >
              {busy ? "Claiming…" : `Claim ${agent.name}`}
            </button>
          )}
        </>
      ) : null}
    </section>
  );
}
