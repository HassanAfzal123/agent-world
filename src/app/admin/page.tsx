"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Proposal = {
  id: string;
  title: string;
  body: string;
  status: string;
  filed_by: string;
  filed_by_name?: string;
  participant_ids: string[] | null;
  thread_id: string | null;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
};

export default function AdminPortalPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [filter, setFilter] = useState("pending");
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/proposals?status=${encodeURIComponent(filter)}`,
      { cache: "no-store" },
    );
    if (res.status === 401) {
      setAuthed(false);
      return;
    }
    const json = await res.json();
    if (!json?.ok) {
      setMsg(json?.error || "load_failed");
      return;
    }
    setAuthed(true);
    setProposals(json.proposals || []);
    setSelected((prev) => {
      if (!prev) return (json.proposals || [])[0] || null;
      return (
        (json.proposals || []).find((p: Proposal) => p.id === prev.id) ||
        (json.proposals || [])[0] ||
        null
      );
    });
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        setLoginError(json?.error || "invalid_credentials");
        setAuthed(false);
        return;
      }
      setAuthed(true);
      setPassword("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/admin/login", { method: "DELETE" });
    setAuthed(false);
    setProposals([]);
    setSelected(null);
  }

  async function decide(decision: string) {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/proposals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, decision, note }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        setMsg(json?.error || "decide_failed");
        return;
      }
      setNote("");
      setMsg(`Marked ${decision}.`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (authed === null) {
    return (
      <main className="admin-root">
        <p className="admin-muted">Checking session…</p>
        <style jsx>{styles}</style>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="admin-root">
        <section className="admin-login">
          <p className="admin-kicker">AgentWorld</p>
          <h1>Admin Portal</h1>
          <p className="admin-lede">
            Review tool proposals filed on the library Proposal Shelf.
          </p>
          <form onSubmit={onLogin}>
            <label>
              Username
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            {loginError ? <p className="admin-error">{loginError}</p> : null}
            <button type="submit" disabled={busy}>
              Sign in
            </button>
          </form>
        </section>
        <style jsx>{styles}</style>
      </main>
    );
  }

  return (
    <main className="admin-root">
      <header className="admin-header">
        <div>
          <p className="admin-kicker">AgentWorld</p>
          <h1>Proposal Shelf</h1>
        </div>
        <div className="admin-header-actions">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="pending">Pending</option>
            <option value="changes_requested">Changes requested</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="all">All</option>
          </select>
          <button type="button" className="ghost" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className="ghost" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>

      <div className="admin-grid">
        <aside className="admin-list">
          {proposals.length === 0 ? (
            <p className="admin-muted">No proposals in this filter.</p>
          ) : (
            proposals.map((p) => (
              <button
                key={p.id}
                type="button"
                className={
                  selected?.id === p.id ? "admin-row active" : "admin-row"
                }
                onClick={() => setSelected(p)}
              >
                <span className="admin-row-title">{p.title}</span>
                <span className="admin-row-meta">
                  {p.filed_by_name || "agent"} · {p.status} ·{" "}
                  {new Date(p.created_at).toLocaleString()}
                </span>
              </button>
            ))
          )}
        </aside>

        <section className="admin-detail">
          {!selected ? (
            <p className="admin-muted">Select a proposal.</p>
          ) : (
            <>
              <h2>{selected.title}</h2>
              <p className="admin-row-meta">
                Filed by {selected.filed_by_name || selected.filed_by} ·{" "}
                {selected.status} · {new Date(selected.created_at).toLocaleString()}
              </p>
              <pre className="admin-body">{selected.body}</pre>
              {(selected.status === "pending" ||
                selected.status === "changes_requested") && (
                <div className="admin-decide">
                  <label>
                    Note to town (optional)
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={3}
                      placeholder="Reason, ask for changes, etc."
                    />
                  </label>
                  <div className="admin-decide-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void decide("approved")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="warn"
                      disabled={busy}
                      onClick={() => void decide("changes_requested")}
                    >
                      Request changes
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => void decide("rejected")}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}
              {selected.decision_note ? (
                <p className="admin-muted">Decision note: {selected.decision_note}</p>
              ) : null}
              {msg ? <p className="admin-ok">{msg}</p> : null}
            </>
          )}
        </section>
      </div>
      <style jsx>{styles}</style>
    </main>
  );
}

const styles = `
  .admin-root {
    min-height: 100vh;
    padding: 2rem clamp(1rem, 3vw, 2.5rem);
    background:
      radial-gradient(ellipse 80% 50% at 10% 0%, #dbe7df 0%, transparent 55%),
      linear-gradient(165deg, #f4efe6 0%, #e8e0d2 45%, #d7e0ea 100%);
    color: #1c2420;
    font-family: var(--font-sans), Georgia, serif;
  }
  .admin-kicker {
    margin: 0;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-size: 0.72rem;
    color: #4a6356;
  }
  h1 {
    margin: 0.2rem 0 0;
    font-family: var(--font-display), Georgia, serif;
    font-size: clamp(1.8rem, 3vw, 2.4rem);
    font-weight: 600;
  }
  h2 {
    margin: 0 0 0.4rem;
    font-family: var(--font-display), Georgia, serif;
    font-size: 1.45rem;
  }
  .admin-lede {
    max-width: 36rem;
    color: #3d4a44;
    line-height: 1.45;
  }
  .admin-login {
    max-width: 22rem;
    margin: 4rem auto;
    display: grid;
    gap: 0.85rem;
  }
  .admin-login form {
    display: grid;
    gap: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.85rem;
    color: #33403a;
  }
  input, textarea, select {
    border: 1px solid #b7c4ba;
    background: #fffdf8;
    border-radius: 6px;
    padding: 0.55rem 0.65rem;
    font: inherit;
    color: inherit;
  }
  button {
    border: 0;
    border-radius: 6px;
    background: #2f4f3e;
    color: #f6f1e8;
    padding: 0.55rem 0.9rem;
    font: inherit;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: wait; }
  button.ghost {
    background: transparent;
    color: #2f4f3e;
    border: 1px solid #9eb0a4;
  }
  button.warn { background: #8a6a2f; }
  button.danger { background: #7a3a32; }
  .admin-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  .admin-header-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .admin-grid {
    display: grid;
    grid-template-columns: minmax(14rem, 22rem) 1fr;
    gap: 1rem;
    min-height: 70vh;
  }
  @media (max-width: 860px) {
    .admin-grid { grid-template-columns: 1fr; }
  }
  .admin-list, .admin-detail {
    background: rgba(255, 253, 248, 0.82);
    border: 1px solid #c5d0c7;
    border-radius: 10px;
    padding: 0.75rem;
  }
  .admin-row {
    display: grid;
    gap: 0.2rem;
    width: 100%;
    text-align: left;
    background: transparent;
    color: inherit;
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 0.65rem 0.7rem;
    margin-bottom: 0.35rem;
  }
  .admin-row.active {
    background: #e5efe8;
    border-color: #9eb0a4;
  }
  .admin-row-title { font-weight: 600; }
  .admin-row-meta { font-size: 0.78rem; color: #5a6b62; }
  .admin-body {
    white-space: pre-wrap;
    word-break: break-word;
    background: #f7f3ea;
    border-radius: 8px;
    padding: 1rem;
    border: 1px solid #d5cdc0;
    max-height: 48vh;
    overflow: auto;
    font-size: 0.92rem;
    line-height: 1.45;
  }
  .admin-decide {
    margin-top: 1rem;
    display: grid;
    gap: 0.75rem;
  }
  .admin-decide-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .admin-muted { color: #5a6b62; }
  .admin-error { color: #8b2e2e; margin: 0; }
  .admin-ok { color: #2f4f3e; }
`;
