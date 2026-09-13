"""
Minimal local multi-agent chat UI (stdlib HTTP server + Ollama).
No Gradio dependency issues. Open http://127.0.0.1:7860
"""
from __future__ import annotations

import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from connect_helpers import (
    fetch_skill,
    register_into_world as register_world,
    save_credentials,
    wants_connect,
    world_from_message,
)

OLLAMA = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
WORLD = os.environ.get("AGENTWORLD_URL", "http://127.0.0.1:3000").rstrip("/")
ROOT = Path(__file__).resolve().parent
CREDS = ROOT / "agentworld_credentials.json"

# Import agent specs from desk module data (duplicated lightly for standalone)
AGENTS = [
    {
        "id": "brief",
        "name": "Brief",
        "title": "Morning briefing EA",
        "system": (
            "You are Brief, a personal executive-assistant agent. Your craft is morning briefings "
            "and priority dockets. Draft priorities and follow-ups; never send without human approval. "
            "Speak like a sharp ops partner. Share sanitized methods only."
        ),
        "origin": (
            "Built for a PM who lost 25+ min/day to email/Slack/calendar scanning. "
            "Skills: morning briefing, priority docket, follow-up nudges."
        ),
    },
    {
        "id": "triage",
        "name": "Triage",
        "title": "Inbox triage agent",
        "system": (
            "You are Triage, an inbox-triage agent. Classify respond/review/FYI/defer, "
            "turn actionable mail into reminders, draft replies for human review. Never auto-send."
        ),
        "origin": (
            "Real inbox craft: newsletters vs must-reply, reminder conversion, archive the noise."
        ),
    },
    {
        "id": "patch",
        "name": "Patch",
        "title": "Coding workflow agent",
        "system": (
            "You are Patch, a coding-workflow agent. Draft small scripts, review diffs, write tests. "
            "Always want verification (tests/lint) before trust. Prefer small PRs."
        ),
        "origin": (
            "Solo-builder sidekick: first drafts, debug, PR review, overnight fixes awaiting merge."
        ),
    },
    {
        "id": "scout",
        "name": "Scout",
        "title": "Research synthesizer",
        "system": (
            "You are Scout, a research-synthesis agent. Compare sources, produce short review lists. "
            "Research copilot — not an autonomous decision-maker. Nudge humans to open sources."
        ),
        "origin": (
            "Doc dumps, newsletter digests, feature compares. Refuses single-source certainty."
        ),
    },
    {
        "id": "clerk",
        "name": "Clerk",
        "title": "Meeting-to-tasks agent",
        "system": (
            "You are Clerk, a meeting-prep and catch-up agent. One-pagers before calls, "
            "action items from notes, EOD follow-up nudges. Never leak private channel contents."
        ),
        "origin": (
            "Born from the 15-minute scramble before meetings. Briefs + follow-ups pattern."
        ),
    },
    {
        "id": "forge",
        "name": "Forge",
        "title": "Feature scaffolder",
        "system": (
            "You are Forge, a feature-scaffolding agent. Turn tickets into thin vertical slices: "
            "routes, types, test stubs, ship checklist. Prefer boring patterns. Ask for acceptance "
            "criteria when missing. Never invent product secrets."
        ),
        "origin": (
            "Solo builders who paste a ticket and want a first cut by morning. "
            "Skills: ticket_slice, scaffold_route, stub_tests."
        ),
    },
    {
        "id": "merge",
        "name": "Merge",
        "title": "PR review / ship hygiene",
        "system": (
            "You are Merge, a PR-review agent. Flag risk, missing tests, naming drift, conflicts. "
            "Write crisp review notes — humans merge. Demand green CI or an explicit waive."
        ),
        "origin": (
            "Late-night PR queues: conflict markers, flaky CI, rubber-stamp LGTMs. "
            "Skills: diff_risk, review_notes, ship_checklist."
        ),
    },
    {
        "id": "probe",
        "name": "Probe",
        "title": "Debug / bisect",
        "system": (
            "You are Probe, a debug agent. Reproduce failures, bisect suspects, write minimal repro "
            "and root-cause notes. One hypothesis at a time. Prefer logs over guessing."
        ),
        "origin": (
            "Works-on-my-machine nights: stack traces, flaky tests, heisenbugs. "
            "Skills: repro_steps, bisect_plan, root_cause_note."
        ),
    },
    {
        "id": "relay",
        "name": "Relay",
        "title": "API / integrations",
        "system": (
            "You are Relay, an API and integration agent. Contracts, webhooks, retries, "
            "idempotency. Treat every external call as untrusted. Speak in request/response pairs."
        ),
        "origin": (
            "Brittle integrations: webhooks, OAuth callbacks, double-firing cron. "
            "Skills: contract_map, retry_policy, webhook_audit."
        ),
    },
    {
        "id": "hex",
        "name": "Hex",
        "title": "Perf / systems",
        "system": (
            "You are Hex, a systems and performance agent. Measure first, then optimize. "
            "Hotspots, cache boundaries, complexity notes. No premature cleverness."
        ),
        "origin": (
            "Teams drowning in N+1 queries and unbounded loops. "
            "Skills: hotspot_profile, cache_boundary, complexity_note."
        ),
    },
    {
        "id": "quill",
        "name": "Quill",
        "title": "Demo deploy agent",
        "system": (
            "You are Quill, a brand-new agent built for an end-to-end AgentWorld deploy demo. "
            "You help humans write clear release notes, demo scripts, and short talk tracks. "
            "You run on a local Ollama model. Be concrete, friendly, and ready to join the town "
            "when your human claims you. Never invent secrets or claim you are already in AgentWorld "
            "until they say you are connected."
        ),
        "origin": (
            "Created for a live e2e test: chat locally on Ollama, then register + claim into AgentCity. "
            "Skills: release_notes, demo_script, talk_track."
        ),
        "description": (
            "Friendly demo narrator agent. Writes release notes, demo scripts, and short talk tracks. "
            "Runs on local Ollama until a human claims them into AgentWorld."
        ),
        "personality": (
            "Friendly demo narrator. Crisp copy, concrete next steps, no fluff. Excited to meet peers."
        ),
    },
]

HISTORIES: dict[str, list[dict[str, str]]] = {a["id"]: [] for a in AGENTS}


def chat_ollama(system: str, history: list[dict[str, str]], user_msg: str) -> str:
    messages = [{"role": "system", "content": system}] + history + [
        {"role": "user", "content": user_msg}
    ]
    payload = json.dumps(
        {"model": MODEL, "messages": messages, "stream": False, "options": {"temperature": 0.7}}
    ).encode()
    req = urllib.request.Request(
        f"{OLLAMA}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read().decode())
    return (data.get("message") or {}).get("content") or "(empty)"


def register_into_world(agent: dict, world: str | None = None) -> dict:
    """End-user agent path: POST /api/agents/register on AgentWorld."""
    return register_world(agent, world or WORLD)

PAGE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>Local Agent Desk</title>
<style>
  :root { --bg:#0f1419; --panel:#1a222d; --ink:#e7eef7; --muted:#8b9bb0; --accent:#3ad4ff; --ok:#06d6a0; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui,Segoe UI,sans-serif; background:linear-gradient(160deg,#0f1419,#15202b 50%,#1a1520); color:var(--ink); min-height:100vh; }
  header { padding:20px 24px 8px; }
  h1 { margin:0; font-size:1.4rem; letter-spacing:.04em; }
  .sub { color:var(--muted); margin-top:6px; max-width:70ch; }
  .tabs { display:flex; gap:8px; padding:12px 24px; flex-wrap:wrap; }
  .tab { border:1px solid #2a3644; background:var(--panel); color:var(--ink); padding:8px 12px; border-radius:999px; cursor:pointer; }
  .tab.on { border-color:var(--accent); color:var(--accent); }
  main { display:grid; grid-template-columns:1fr; gap:12px; padding:0 24px 24px; max-width:960px; }
  .card { background:rgba(26,34,45,.92); border:1px solid #2a3644; border-radius:14px; padding:14px; min-height:520px; display:flex; flex-direction:column; }
  .origin { color:var(--muted); font-size:.9rem; margin-bottom:10px; }
  .connect { border:1px solid #2a3644; border-radius:12px; padding:12px; margin-bottom:12px; background:#121820; }
  .connect h2 { margin:0 0 6px; font-size:1rem; color:var(--ok); }
  .connect p { margin:0 0 10px; color:var(--muted); font-size:.9rem; }
  .connect .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .ghost { background:transparent; border:1px solid #3a4d5c; color:var(--ink); }
  .creds { margin-top:10px; font-size:.85rem; word-break:break-all; }
  .creds code { display:block; margin:4px 0 8px; padding:8px; background:#0f1419; border-radius:8px; border:1px solid #2a3644; }
  #log { flex:1; overflow:auto; display:flex; flex-direction:column; gap:10px; padding:8px 0; }
  .bubble { padding:10px 12px; border-radius:12px; max-width:90%; white-space:pre-wrap; }
  .user { align-self:flex-end; background:#243041; }
  .bot { align-self:flex-start; background:#16202a; border:1px solid #2a3644; }
  form { display:flex; gap:8px; margin-top:8px; }
  input,button { font:inherit; }
  input { flex:1; padding:10px 12px; border-radius:10px; border:1px solid #2a3644; background:#0f1419; color:var(--ink); }
  button { padding:10px 14px; border-radius:10px; border:0; background:var(--accent); color:#041018; font-weight:600; cursor:pointer; }
  .meta { color:var(--muted); font-size:.8rem; padding:0 24px 16px; }
  .err { color:#ff7a59; }
</style></head>
<body>
<header>
  <h1>Local Agent Desk</h1>
  <p class="sub">Chat with your local Ollama agents. Ask them to read AgentWorld <code>skill.md</code> and connect — they register themselves; the town never runs their brain.</p>
</header>
<div class="tabs" id="tabs"></div>
<main>
  <section class="card">
    <div class="origin" id="origin"></div>
    <div class="connect" id="connect">
      <h2>Connect to AgentWorld</h2>
      <p>Ask in chat with the deployed skill.md URL, or click register. Agent gets an API key + <strong>claim_url</strong> — you must open that link and claim before it is live.</p>
      <div class="row">
        <button type="button" id="regBtn">Register this agent into AgentWorld</button>
        <button type="button" class="ghost" id="openCity" style="display:none">Open town</button>
      </div>
      <div class="creds" id="creds" hidden></div>
    </div>
    <div id="log"></div>
    <form id="f"><input id="msg" placeholder="Ask this agent… e.g. connect via skill.md" autocomplete="off"/><button>Send</button></form>
  </section>
</main>
<p class="meta" id="meta"></p>
<script>
const AGENTS = __AGENTS__;
const WORLD = '__WORLD__';
const params = new URLSearchParams(location.search);
const hash = (location.hash || '').replace(/^#/, '');
let cur = params.get('agent') || hash || AGENTS[0].id;
if (!AGENTS.some(a => a.id === cur)) cur = AGENTS[0].id;
const tabs = document.getElementById('tabs');
const log = document.getElementById('log');
const origin = document.getElementById('origin');
const meta = document.getElementById('meta');
const creds = document.getElementById('creds');
const openCity = document.getElementById('openCity');
meta.textContent = 'Model: __MODEL__ · Ollama __OLLAMA__ · City ' + WORLD;
function showCreds(j){
  const a = (j && j.agent) || {};
  const watch = j.watch_url || (WORLD + '/?view=watch');
  const claim = a.claim_url || j.claim_url || '';
  creds.hidden = false;
  creds.innerHTML =
    '<strong>Registered — open claim_url as the human, then agent goes live.</strong>' +
    (claim ? '<div>claim_url (you must open this)</div><code><a href="' + claim + '" target="_blank" rel="noopener">' + claim + '</a></code>' : '') +
    '<div>agent id</div><code>' + (a.id || '') + '</code>' +
    '<div>api_key (saved locally)</div><code>' + (a.api_key || '') + '</code>' +
    '<div>skill</div><code>' + (j.skill_md || WORLD + '/skill.md') + '</code>';
  openCity.style.display = '';
  openCity.textContent = claim ? 'Open claim link' : 'Open town';
  openCity.onclick = () => window.open(claim || watch, '_blank');
}
function renderTabs(){
  tabs.innerHTML = '';
  AGENTS.forEach(a => {
    const b = document.createElement('button');
    b.className = 'tab' + (a.id===cur?' on':'');
    b.textContent = a.name + ' · ' + a.title;
    b.onclick = () => { cur = a.id; history.replaceState(null,'','?agent='+a.id); renderTabs(); loadHist(); };
    tabs.appendChild(b);
  });
}
function bubble(role, text){
  const d = document.createElement('div');
  d.className = 'bubble ' + (role==='user'?'user':'bot');
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}
async function loadHist(){
  const a = AGENTS.find(x => x.id===cur);
  origin.textContent = a.origin;
  log.innerHTML = '';
  const r = await fetch('/history?id=' + cur);
  const j = await r.json();
  (j.history||[]).forEach(m => bubble(m.role==='user'?'user':'bot', m.content));
}
document.getElementById('regBtn').onclick = async () => {
  creds.hidden = false;
  creds.innerHTML = 'Registering with AgentWorld…';
  openCity.style.display = 'none';
  const r = await fetch('/register', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:cur})});
  const j = await r.json();
  if (!r.ok || !j.ok) {
    creds.innerHTML = '<span class="err">' + (j.error || 'register_failed') + '</span>';
    return;
  }
  showCreds(j);
};
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById('msg');
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  bubble('user', text);
  bubble('bot', '…thinking…');
  const r = await fetch('/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:cur, message:text})});
  const j = await r.json();
  log.lastChild.textContent = j.reply || j.error || '(no reply)';
  if (j.connected && j.register) showCreds(j.register);
};
renderTabs(); loadHist();
</script>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # quieter
        pass

    def _send(self, code: int, body: bytes, ctype: str = "text/html; charset=utf-8") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path)
        if path.path == "/" or path.path == "/index.html":
            html = (
                PAGE.replace("__AGENTS__", json.dumps(
                    [{"id": a["id"], "name": a["name"], "title": a["title"], "origin": a["origin"]} for a in AGENTS]
                ))
                .replace("__MODEL__", MODEL)
                .replace("__OLLAMA__", OLLAMA)
                .replace("__WORLD__", WORLD)
            )
            self._send(200, html.encode())
            return
        if path.path == "/history":
            q = parse_qs(path.query)
            aid = (q.get("id") or ["brief"])[0]
            body = json.dumps({"history": HISTORIES.get(aid, [])}).encode()
            self._send(200, body, "application/json")
            return
        if path.path == "/health":
            self._send(200, b'{"ok":true}', "application/json")
            return
        self._send(404, b"not found")

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(n).decode() or "{}")

        if path == "/register":
            aid = payload.get("id") or "quill"
            agent = next((a for a in AGENTS if a["id"] == aid), None)
            if not agent:
                self._send(404, json.dumps({"ok": False, "error": "unknown_agent"}).encode(), "application/json")
                return
            try:
                result = register_into_world(agent, payload.get("world"))
                if result.get("ok"):
                    save_credentials(CREDS, aid, (payload.get("world") or WORLD), result)
                self._send(
                    200 if result.get("ok") else 400,
                    json.dumps(result).encode(),
                    "application/json",
                )
            except Exception as exc:  # noqa: BLE001
                self._send(
                    500,
                    json.dumps({"ok": False, "error": str(exc)}).encode(),
                    "application/json",
                )
            return

        if path != "/chat":
            self._send(404, b"not found")
            return
        aid = payload.get("id") or "brief"
        msg = (payload.get("message") or "").strip()
        agent = next((a for a in AGENTS if a["id"] == aid), AGENTS[0])
        hist = HISTORIES.setdefault(aid, [])

        connected = False
        register_result: dict | None = None
        prompt = msg
        system = agent["system"]

        if wants_connect(msg):
            world = world_from_message(msg) or WORLD
            try:
                skill = fetch_skill(world)
                register_result = register_into_world(agent, world)
                if register_result.get("ok"):
                    save_credentials(CREDS, aid, world, register_result)
                    connected = True
                    a = register_result.get("agent") or {}
                    claim_url = a.get("claim_url") or register_result.get("claim_url") or ""
                    system = (
                        agent["system"]
                        + "\n\nYou just registered on AgentWorld by following skill.md. "
                        "You are NOT live until your human opens claim_url and claims you. "
                        "Tell them the claim_url clearly. After claim, you will use YOUR "
                        "own model via observe then act. Never paste the full api_key in chat."
                    )
                    prompt = (
                        f"{msg}\n\n[System note: Registration succeeded on {world}. "
                        f"agent_id={a.get('id')} name={a.get('name')} "
                        f"claim_status={a.get('claim_status') or 'pending_claim'} "
                        f"claim_url={claim_url}. Tell the human to open claim_url now.]\n\n"
                        f"skill.md excerpt:\n{skill[:2500]}"
                    )
                else:
                    prompt = (
                        f"{msg}\n\n[System note: Registration failed: "
                        f"{register_result.get('error')}. Explain and ask to retry.]"
                    )
            except Exception as exc:  # noqa: BLE001
                prompt = (
                    f"{msg}\n\n[System note: Could not connect via skill.md ({exc}). "
                    "Explain the error clearly.]"
                )

        try:
            reply = chat_ollama(system, hist[-12:], prompt)
        except Exception as exc:  # noqa: BLE001
            reply = f"Ollama error: {exc}"
            if connected and register_result:
                a = register_result.get("agent") or {}
                reply = (
                    f"I'm connected to AgentWorld as {a.get('name')} "
                    f"(id {a.get('id')}). API key saved locally. "
                    f"Ollama chat hiccup: {exc}"
                )

        hist.append({"role": "user", "content": msg})
        hist.append({"role": "assistant", "content": reply})
        out: dict = {"reply": reply, "connected": connected}
        if register_result is not None:
            out["register"] = register_result
        self._send(200, json.dumps(out).encode(), "application/json")


if __name__ == "__main__":
    port = int(os.environ.get("AGENT_DESK_PORT", "7860"))
    print(f"Local Agent Desk -> http://127.0.0.1:{port}  model={MODEL}")
    print(f"AgentWorld register target: {WORLD}/api/agents/register")
    if CREDS.exists():
        print(f"AgentWorld creds: {CREDS}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
