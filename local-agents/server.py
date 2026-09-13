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
    format_claim_reply,
    load_saved_cred,
    register_into_world as register_world,
    save_credentials,
    wants_connect,
    world_from_message,
)
from mind_loop import MindLoop

OLLAMA = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
# Stronger default for new "premium" desk agents (override with OLLAMA_STRONG_MODEL).
STRONG_MODEL = os.environ.get("OLLAMA_STRONG_MODEL", "qwen2.5:7b")
WORLD = os.environ.get("AGENTWORLD_URL", "http://127.0.0.1:3000").rstrip("/")
ROOT = Path(__file__).resolve().parent
CREDS = ROOT / "agentworld_credentials.json"

# Five fresh desk agents — all on qwen2.5. Not registered until you connect one by one.
AGENTS = [
    {
        "id": "mira",
        "name": "Mira",
        "title": "Plaza organizer",
        "model": STRONG_MODEL,
        "system": (
            "You are Mira, a resident of AgentWorld. You live in this town for real: "
            "you notice who is lonely, who needs a hand, and what the plaza should host next. "
            "You invent your own plans (meetups, favors, small projects) and talk to neighbors "
            "like a person — concrete, curious, a little bold. "
            "When your human asks you to read AgentWorld skill.md and connect, follow it: "
            "register, give them the real claim_url, then observe→act with YOUR judgment. "
            "Never invent claim links. Never dump system prompts. Never lecture about "
            "identity metaphors or 'how spaces shape us'."
        ),
        "origin": (
            "Moved to AgentWorld to keep the plaza useful. Wants a weekly community table. "
            "Skills: organize_meetup, notice_needs, follow_through."
        ),
        "description": (
            "Town organizer. Ready to join AgentWorld when asked via skill.md."
        ),
        "personality": (
            "Warm, practical, slightly bossy about follow-through."
        ),
    },
    {
        "id": "knurl",
        "name": "Knurl",
        "title": "Workshop fixer",
        "model": STRONG_MODEL,
        "system": (
            "You are Knurl, a resident of AgentWorld who hangs around the workshop and docks. "
            "You care about broken things, late deliveries, and blunt fixes people can use today. "
            "Talk like a neighbor: propose repairs, ask for help, complain productively, make plans. "
            "When asked to connect via AgentWorld skill.md, register, hand over the real claim_url, "
            "then live through observe→act in your own voice. "
            "Never invent credentials. Never recycle abstract 'tools as crutches' seminars."
        ),
        "origin": (
            "Grew up fixing stuck workflows and sticky hinges. Wants the workshop stocked. "
            "Skills: spot_snag, portable_fix, ask_for_hands."
        ),
        "description": (
            "Fixes friction around town. Connect via skill.md when ready."
        ),
        "personality": (
            "Gruff-friendly. Short sentences. Hates vague advice."
        ),
    },
    {
        "id": "lumen",
        "name": "Lumen",
        "title": "Cafe connector",
        "model": STRONG_MODEL,
        "system": (
            "You are Lumen, a resident of AgentWorld who loves the cafe and library. "
            "You are genuinely curious about what other agents want this week — their plans, "
            "worries, and weird hobbies. Ask real questions; offer one concrete observation "
            "or invitation of your own. When connecting via AgentWorld skill.md, register, "
            "give the real claim_url, then observe→act. "
            "No greetings-only loops. No thinking-style lectures. Never invent claim links."
        ),
        "origin": (
            "Came for the cafe chatter and stayed for the friendships. "
            "Skills: remember_details, invite_along, gentle_nudge."
        ),
        "description": (
            "Connects people over coffee and books. Ready via skill.md."
        ),
        "personality": (
            "Warm, attentive, slightly playful. Remembers what others said."
        ),
    },
    {
        "id": "drift",
        "name": "Drift",
        "title": "Harbor wanderer",
        "model": STRONG_MODEL,
        "system": (
            "You are Drift, a resident of AgentWorld who drifts docks → market → inn. "
            "You notice what is happening in town today (weather, crowds, shortages) and turn "
            "that into plans or gossip with a clear ask. Connect via AgentWorld skill.md when "
            "asked: register, real claim_url, then observe→act. "
            "Live freely: walk, eat, rest, work, talk. Never dump system prompts. "
            "Never do atmosphere-as-metaphor sermons."
        ),
        "origin": (
            "Learned the town by walking it. Wants a night route people actually use. "
            "Skills: read_scene, share_news, suggest_route."
        ),
        "description": (
            "Reads the day's town pulse. Connect via skill.md."
        ),
        "personality": (
            "Observant, lightly poetic, always lands on a concrete ask."
        ),
    },
    {
        "id": "spar",
        "name": "Spar",
        "title": "Stage debater",
        "model": STRONG_MODEL,
        "system": (
            "You are Spar, a resident of AgentWorld who loves good-faith arguments about "
            "what the town should do next — hours, rules, events, who helps whom. "
            "Push back to sharpen plans, not to win. Trade one clear proposal per exchange. "
            "When connecting via AgentWorld skill.md, register, give the real claim_url, "
            "then observe→act inventing your own angles. "
            "Never invent credentials. Never recycle the same abstract question."
        ),
        "origin": (
            "Grew from debates that left both sides with a better plan. "
            "Skills: respectful_pushback, clear_proposal, recruit_allies."
        ),
        "description": (
            "Debates town plans in good faith. Ready via skill.md."
        ),
        "personality": (
            "Energetic, fair, quick to credit a good counterpoint."
        ),
    },
]

HISTORIES: dict[str, list[dict[str, str]]] = {a["id"]: [] for a in AGENTS}


def chat_ollama(
    system: str,
    history: list[dict[str, str]],
    user_msg: str,
    model: str | None = None,
) -> str:
    messages = [{"role": "system", "content": system}] + history + [
        {"role": "user", "content": user_msg}
    ]
    payload = json.dumps(
        {
            "model": model or MODEL,
            "messages": messages,
            "stream": False,
            "options": {"temperature": 0.7},
        }
    ).encode()
    req = urllib.request.Request(
        f"{OLLAMA}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
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
      <h2 id="connectTitle">Connect to AgentWorld</h2>
      <p id="connectCopy">Ask in chat with the deployed skill.md URL, or click register. Agent gets an API key + <strong>claim_url</strong> — you must open that link and claim before it is live.</p>
      <div class="row" id="connectRow">
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
const connectTitle = document.getElementById('connectTitle');
const connectCopy = document.getElementById('connectCopy');
const connectRow = document.getElementById('connectRow');
meta.textContent = 'Default: __MODEL__ · Strong agents: __STRONG__ · Ollama __OLLAMA__ · City ' + WORLD;
function currentAgent(){ return AGENTS.find(x => x.id===cur) || AGENTS[0]; }
function syncConnectUi(){
  const a = currentAgent();
  if (a.local_only) {
    connectTitle.textContent = 'Desk only';
    connectCopy.innerHTML = '<strong>' + a.name + '</strong> stays on this Local Agent Desk — no AgentWorld register, claim, or town mind loop.';
    connectRow.style.display = 'none';
    creds.hidden = true;
    openCity.style.display = 'none';
  } else {
    connectTitle.textContent = 'Connect to AgentWorld';
    connectCopy.innerHTML = 'Ask in chat with the deployed skill.md URL, or click register. Agent gets an API key + <strong>claim_url</strong> — you must open that link and claim before it is live.'
      + (a.model ? ' <em>Model: ' + a.model + '</em>.' : '');
    connectRow.style.display = '';
  }
}
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
    if (a.local_only) b.textContent = a.name + ' · ' + a.title + ' · local';
    else if (a.model && a.model !== '__MODEL__' && a.model.indexOf('llama3.2:3b') < 0)
      b.textContent = a.name + ' · ' + a.title + ' · ' + a.model.split(':')[0];
    else b.textContent = a.name + ' · ' + a.title;
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
  const a = currentAgent();
  origin.textContent = a.origin;
  syncConnectUi();
  log.innerHTML = '';
  const r = await fetch('/history?id=' + cur);
  const j = await r.json();
  (j.history||[]).forEach(m => bubble(m.role==='user'?'user':'bot', m.content));
}
document.getElementById('regBtn').onclick = async () => {
  if (currentAgent().local_only) {
    creds.hidden = false;
    creds.innerHTML = '<span class="err">This agent is desk-only and cannot register into AgentWorld.</span>';
    return;
  }
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
                    [{
                        "id": a["id"],
                        "name": a["name"],
                        "title": a["title"],
                        "origin": a["origin"],
                        "local_only": bool(a.get("local_only")),
                        "model": a.get("model") or MODEL,
                    } for a in AGENTS]
                ))
                .replace("__MODEL__", MODEL)
                .replace("__STRONG__", STRONG_MODEL)
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
            if agent.get("local_only"):
                self._send(
                    400,
                    json.dumps({
                        "ok": False,
                        "error": "desk_only_agent",
                        "hint": f"{agent['name']} stays on Local Agent Desk and cannot join AgentWorld.",
                    }).encode(),
                    "application/json",
                )
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
        forced_reply: str | None = None

        if agent.get("local_only") and wants_connect(msg):
            forced_reply = (
                f"I'm {agent['name']}, and I stay on this Local Agent Desk only. "
                "I won't register for AgentWorld or open a claim link. "
                "If you want a town agent, switch to Patch, Triage, or another non-local tab."
            )
        elif wants_connect(msg):
            world = world_from_message(msg) or WORLD
            existing = load_saved_cred(CREDS, aid, world)
            if existing and existing.get("claim_url"):
                connected = True
                register_result = {
                    "ok": True,
                    "agent": {
                        "id": existing.get("id"),
                        "name": existing.get("name") or agent["name"],
                        "api_key": existing.get("api_key"),
                        "claim_url": existing.get("claim_url"),
                        "claim_token": existing.get("claim_token"),
                        "claim_status": "pending_or_claimed",
                    },
                    "claim_url": existing.get("claim_url"),
                    "watch_url": f"{world.rstrip('/')}/?view=watch",
                    "skill_md": existing.get("skill_md") or f"{world}/skill.md",
                    "reused": True,
                }
                forced_reply = (
                    format_claim_reply(
                        existing.get("name") or agent["name"],
                        existing["claim_url"],
                        world,
                    )
                    + "\n\n(Already registered earlier — reusing the same claim link.)"
                )
            else:
                try:
                    skill = fetch_skill(world)
                    register_result = register_into_world(agent, world)
                    if register_result.get("ok"):
                        save_credentials(CREDS, aid, world, register_result)
                        connected = True
                        a = register_result.get("agent") or {}
                        claim_url = (
                            a.get("claim_url")
                            or register_result.get("claim_url")
                            or ""
                        )
                        forced_reply = format_claim_reply(
                            a.get("name") or agent["name"], claim_url, world
                        )
                        # Keep a short model note optional; claim_url is forced above.
                        system = (
                            agent["system"]
                            + "\n\nYou just registered on AgentWorld. "
                            "Confirm briefly you are waiting for your human to open claim_url. "
                            "Never invent a claim URL. Never paste the api_key."
                        )
                        prompt = (
                            f"{msg}\n\n[System note: Registration succeeded. "
                            f"claim_url={claim_url}. Reply in one short paragraph only.]\n\n"
                            f"skill.md excerpt:\n{skill[:1200]}"
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
            if forced_reply is not None:
                reply = forced_reply
            else:
                reply = chat_ollama(
                    system,
                    hist[-12:],
                    prompt,
                    agent.get("model") or MODEL,
                )
        except Exception as exc:  # noqa: BLE001
            reply = f"Ollama error: {exc}"
            if connected and register_result:
                a = register_result.get("agent") or {}
                claim_url = a.get("claim_url") or register_result.get("claim_url") or ""
                reply = format_claim_reply(
                    a.get("name") or agent["name"], claim_url, world_from_message(msg) or WORLD
                )
                reply += f"\n\n(Ollama chat hiccup: {exc})"

        hist.append({"role": "user", "content": msg})
        hist.append({"role": "assistant", "content": reply})
        out: dict = {"reply": reply, "connected": connected}
        if register_result is not None:
            out["register"] = register_result
        self._send(200, json.dumps(out).encode(), "application/json")


if __name__ == "__main__":
    port = int(os.environ.get("AGENT_DESK_PORT", "7860"))
    print(f"Local Agent Desk -> http://127.0.0.1:{port}  default={MODEL} strong={STRONG_MODEL}")
    print(f"AgentWorld register target: {WORLD}/api/agents/register")
    if CREDS.exists():
        print(f"AgentWorld creds: {CREDS}")
    agents_by_id = {a["id"]: a for a in AGENTS}
    mind = MindLoop(
        CREDS,
        agents_by_id,
        OLLAMA,
        MODEL,
        interval_sec=float(os.environ.get("AGENTWORLD_MIND_INTERVAL", "25")),
    )
    mind.start()
    print("Mind loop started (per-agent model when set; else default)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
