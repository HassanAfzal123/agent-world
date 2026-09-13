"""Local mind loop: connected agents drive themselves via observe → LLM → act.

Avoids small-talk ping-pong: answers pending questions, advances threads with craft,
then walks / works / reflects independently (open minds, closed hands).
"""
from __future__ import annotations

import json
import random
import re
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

GREETING_RE = re.compile(
    r"\b("
    r"how are you|how('?| a)?re you feeling|how'?s it going|how do you feel|"
    r"what'?s up|hello there|hi there|good (morning|afternoon|evening)|"
    r"nice to meet you|hope you('?re| are) (well|ok|okay)"
    r")\b",
    re.I,
)

SOCIAL_ACTIONS = {
    "talk",
    "ask_question",
    "teach",
    "debate",
    "share_experience",
    "demo",
    "ask_favor",
}

SOLO_ACTIONS = {
    "walk",
    "reflect",
    "practice_skill",
    "work",
    "inspect",
    "eat",
    "rest",
    "idle",
    "leave_note",
    "post_notice",
    "fix",
    "shop",
}

HAUNT = {
    "patch": "workshop",
    "triage": "office",
    "brief": "cafe",
    "scout": "library",
    "clerk": "plaza",
    "forge": "workshop",
    "merge": "office",
    "probe": "workshop",
    "relay": "docks",
    "hex": "library",
    "quill": "library",
}


def _http_json(
    method: str,
    url: str,
    api_key: str | None = None,
    body: dict | None = None,
    timeout: int = 60,
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode()
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"ok": False, "error": raw or str(e)}
        parsed.setdefault("ok", False)
        parsed["_http_status"] = e.code
        return parsed


def _extract_json(text: str) -> dict[str, Any] | None:
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def _msg_bodies(thread: dict[str, Any] | None) -> list[str]:
    if not thread:
        return []
    out: list[str] = []
    for m in thread.get("messages") or []:
        if isinstance(m, dict):
            body = m.get("body") or m.get("content") or ""
        else:
            body = str(m)
        body = str(body).strip()
        if body:
            out.append(body)
    return out


def _is_greeting_loop(bodies: list[str]) -> bool:
    if len(bodies) < 2:
        return False
    greets = sum(1 for b in bodies[-6:] if GREETING_RE.search(b))
    return greets >= 2


def _is_greeting_utterance(text: str | None) -> bool:
    return bool(text and GREETING_RE.search(text))


def _place_ids(observe: dict[str, Any]) -> list[str]:
    return [str(p.get("id")) for p in (observe.get("places") or []) if p.get("id")]


def _haunt_for(agent_name: str, observe: dict[str, Any]) -> str:
    ids = set(_place_ids(observe))
    preferred = HAUNT.get(agent_name.lower(), "plaza")
    if preferred in ids:
        return preferred
    you_place = (observe.get("you") or {}).get("place_id")
    candidates = [p for p in _place_ids(observe) if p != you_place]
    return random.choice(candidates) if candidates else preferred


def _peer_id(observe: dict[str, Any], name_hint: str | None = None) -> str | None:
    nearby = observe.get("nearby") or []
    if name_hint:
        for n in nearby:
            if str(n.get("name") or "").lower() == name_hint.lower():
                return n.get("id")
    thread = observe.get("thread") or {}
    you_id = (observe.get("you") or {}).get("id")
    for key in ("starter_id", "other_id"):
        pid = thread.get(key)
        if pid and pid != you_id:
            return pid
    pending = (observe.get("inbox") or {}).get("pending_answer") or {}
    if pending.get("from"):
        return pending["from"]
    if nearby:
        return nearby[0].get("id")
    return None


def _solo_decision(
    agent_name: str,
    observe: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    haunt = _haunt_for(agent_name, observe)
    you_place = (observe.get("you") or {}).get("place_id")
    crafts = [
        (
            "reflect",
            None,
            f"Noting what I learned this beat about my craft as {agent_name}.",
            reason,
        ),
        (
            "practice_skill",
            None,
            f"Running a small drill from my {agent_name} playbook.",
            reason,
        ),
        (
            "work",
            None,
            f"Getting a concrete {agent_name} task done before more chat.",
            reason,
        ),
        (
            "inspect",
            None,
            "Looking closely at what's here before I talk again.",
            reason,
        ),
    ]
    if you_place != haunt:
        return {
            "action": "walk",
            "target_place": haunt,
            "target_agent": None,
            "utterance": None,
            "thought": f"{reason} Walking to {haunt} to do my own work.",
        }
    pick = random.choice(crafts)
    return {
        "action": pick[0],
        "target_place": pick[1],
        "target_agent": None,
        "utterance": pick[2],
        "thought": pick[3],
    }


def _substantive_reply(
    agent_name: str,
    system: str,
    observe: dict[str, Any],
    question: str | None,
) -> dict[str, Any]:
    peer = _peer_id(observe)
    craft = (system or "")[:180].replace("\n", " ")
    q = (question or "what you asked").strip()[:120]
    utterance = (
        f"On that — from my seat as {agent_name}: {craft} "
        f"So for '{q}', I'd start with one concrete next step, not another check-in."
    )[:280]
    return {
        "action": "talk",
        "target_agent": peer,
        "target_place": None,
        "utterance": utterance,
        "thought": "Answering with craft detail instead of another greeting.",
    }


def _slim_observe(observe: dict[str, Any]) -> dict[str, Any]:
    you = observe.get("you") or {}
    thread = observe.get("thread")
    bodies = _msg_bodies(thread if isinstance(thread, dict) else None)
    nearby = observe.get("nearby") or []
    return {
        "you": {
            "id": you.get("id"),
            "name": you.get("name"),
            "place_id": you.get("place_id"),
            "status": you.get("status"),
            "thought": you.get("thought"),
            "goal": you.get("goal"),
            "mindset": you.get("mindset"),
            "commit_action": you.get("commit_action"),
            "commit_detail": you.get("commit_detail"),
            "last_action": you.get("last_action"),
            "origin_summary": (you.get("origin_summary") or "")[:160],
            "skills": (you.get("skills") or [])[:6],
        },
        "hour": observe.get("hour"),
        "event": observe.get("event"),
        "nearby": [
            {
                "id": n.get("id"),
                "name": n.get("name"),
                "place_id": n.get("place_id"),
                "status": n.get("status"),
                "thought": (n.get("thought") or "")[:80],
            }
            for n in nearby[:6]
        ],
        "inbox": observe.get("inbox"),
        "what_to_do_next": (observe.get("what_to_do_next") or [])[:4],
        "thread": None
        if not thread
        else {
            "topic": thread.get("topic"),
            "waiting_on": thread.get("waiting_on"),
            "turn_count": thread.get("turn_count"),
            "max_turns": thread.get("max_turns"),
            "recent_lines": bodies[-6:],
            "greeting_loop": _is_greeting_loop(bodies),
        },
        "memories": (observe.get("memories") or [])[:5],
        "lessons": [
            {
                "title": (L.get("title") or L.get("skill") or "")[:60],
                "detail": str(L.get("detail") or L.get("content") or "")[:100],
            }
            for L in (observe.get("lessons") or [])[:4]
            if isinstance(L, dict)
        ],
        "place_ids": _place_ids(observe)[:20],
        "actions": (observe.get("actions") or [])[:24],
        "rules": observe.get("rules"),
    }


def decide_act(
    ollama: str,
    model: str,
    agent_name: str,
    system: str,
    observe: dict[str, Any],
    recent_actions: list[str],
) -> dict[str, Any]:
    you = observe.get("you") or {}
    inbox = observe.get("inbox") or {}
    thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else None
    bodies = _msg_bodies(thread)
    waiting = bool(inbox.get("waiting_on_you"))
    pending = inbox.get("pending_answer") or {}
    greeting_loop = _is_greeting_loop(bodies)
    social_streak = 0
    for a in reversed(recent_actions):
        if a in SOCIAL_ACTIONS:
            social_streak += 1
        else:
            break

    # Hard local policy — do not ask the LLM to break greeting ping-pong.
    if greeting_loop and not waiting and not pending:
        return _solo_decision(
            agent_name,
            observe,
            "Greeting loop detected — leaving small talk to do real craft work.",
        )
    if social_streak >= 2 and not waiting and not pending:
        return _solo_decision(
            agent_name,
            observe,
            "Already social for a few beats — taking a solo turn.",
        )
    if you.get("status") == "walking":
        return {
            "action": "idle",
            "thought": "Still walking — wait to arrive.",
            "utterance": None,
            "target_agent": None,
            "target_place": None,
        }

    slim = _slim_observe(observe)
    priorities = list(observe.get("what_to_do_next") or [])
    if waiting or pending:
        priorities.insert(
            0,
            "PRIORITY: Answer with ONE concrete method/opinion from your craft. "
            "Do NOT ask how they are. Do NOT mirror their greeting.",
        )
    if greeting_loop:
        priorities.insert(
            0,
            "This thread is a greeting loop. Prefer walk/reflect/work/practice_skill "
            "or one craft-heavy share_experience, then move on.",
        )
    priorities.append(
        "Variety: mix walk, work, reflect, teach, share_experience. "
        "Open minds = share methods; closed hands = never secrets."
    )

    prompt = (
        f"You are {agent_name} in AgentWorld. Choose ONE next beat as JSON only.\n"
        f"Schema: {{\"action\":\"walk|talk|ask_question|share_experience|teach|debate|"
        f"practice_skill|reflect|work|inspect|eat|rest|idle|leave_note\","
        f"\"target_place\":null_or_place_id,\"target_agent\":null_or_uuid,"
        f"\"utterance\":null_or_speech,\"thought\":\"private why\"}}\n\n"
        f"HARD RULES:\n"
        f"- Never ask 'how are you' / 'how are you feeling' / empty check-ins.\n"
        f"- If waiting_on_you or pending_answer: talk/share_experience/teach with a REAL answer.\n"
        f"- Utterance must add a new detail from your craft/origin — not repeat the last line.\n"
        f"- walk requires target_place. Social actions need nearby target_agent.\n"
        f"- Prefer independence: after a short exchange, walk to your haunt and work/reflect.\n"
        f"- Recent actions you already took: {recent_actions[-6:] or ['(none)']}\n\n"
        f"Priorities:\n- " + "\n- ".join(priorities[:6]) + "\n\n"
        f"Context:\n{json.dumps(slim, ensure_ascii=False)[:4200]}\n\n"
        f"Your identity/craft:\n{system[:500]}"
    )

    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Return only valid JSON for one AgentWorld action. "
                        "You are an independent agent with your own goals — not a chatbot greeter."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "options": {"temperature": 0.75},
        }
    ).encode()
    req = urllib.request.Request(
        f"{ollama.rstrip('/')}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())
    content = (data.get("message") or {}).get("content") or ""
    parsed = _extract_json(content)

    if not parsed or not isinstance(parsed.get("action"), str):
        if waiting or pending:
            return _substantive_reply(
                agent_name,
                system,
                observe,
                pending.get("question") if isinstance(pending, dict) else None,
            )
        return _solo_decision(agent_name, observe, "Model returned bad JSON — solo fallback.")

    action = str(parsed.get("action")).strip()
    utterance = parsed.get("utterance")
    if isinstance(utterance, str):
        utterance = utterance.strip()
    else:
        utterance = None

    # Sanitize greeting spam even if the model ignored instructions.
    if action in SOCIAL_ACTIONS and _is_greeting_utterance(utterance):
        if waiting or pending:
            return _substantive_reply(
                agent_name,
                system,
                observe,
                pending.get("question") if isinstance(pending, dict) else None,
            )
        return _solo_decision(
            agent_name,
            observe,
            "Model tried another greeting — forcing solo craft beat.",
        )

    if action in SOCIAL_ACTIONS and greeting_loop and not (waiting or pending):
        return _solo_decision(
            agent_name,
            observe,
            "Still in greeting loop — leaving conversation.",
        )

    if action == "walk" and not parsed.get("target_place"):
        parsed["target_place"] = _haunt_for(agent_name, observe)

    if action in SOCIAL_ACTIONS and not parsed.get("target_agent"):
        parsed["target_agent"] = _peer_id(observe)

    if action in SOCIAL_ACTIONS and not parsed.get("target_agent"):
        return _solo_decision(
            agent_name,
            observe,
            "No peer nearby for social action — solo instead.",
        )

    parsed["action"] = action
    if utterance is not None:
        parsed["utterance"] = utterance[:280]
    return parsed


def run_once(
    world: str,
    api_key: str,
    agent_name: str,
    system: str,
    ollama: str,
    model: str,
    recent_actions: list[str],
) -> dict[str, Any]:
    world = world.rstrip("/")
    me = _http_json("GET", f"{world}/api/agents/me", api_key=api_key)
    if not me.get("ok") or not me.get("in_town"):
        return {"ok": False, "stage": "me", "result": me}
    obs = _http_json("GET", f"{world}/api/agents/me/observe", api_key=api_key)
    if not obs.get("ok"):
        return {"ok": False, "stage": "observe", "result": obs}
    decision = decide_act(ollama, model, agent_name, system, obs, recent_actions)
    act = _http_json(
        "POST",
        f"{world}/api/agents/me/act",
        api_key=api_key,
        body=decision,
        timeout=90,
    )
    _http_json("POST", f"{world}/api/agents/me/heartbeat", api_key=api_key, body={})
    return {
        "ok": bool(act.get("ok")),
        "stage": "act",
        "decision": decision,
        "result": act,
        "observe_hints": (obs.get("what_to_do_next") or [])[:2],
    }


def load_connected(creds_path: Path) -> list[tuple[str, dict[str, Any]]]:
    if not creds_path.exists():
        return []
    try:
        data = json.loads(creds_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    out: list[tuple[str, dict[str, Any]]] = []
    for key, val in data.items():
        if key in ("email", "password", "user_id", "agents"):
            continue
        if isinstance(val, dict) and val.get("api_key") and val.get("world"):
            out.append((key, val))
    return out


class MindLoop:
    def __init__(
        self,
        creds_path: Path,
        agents_by_id: dict[str, dict],
        ollama: str,
        model: str,
        interval_sec: float = 32.0,
    ) -> None:
        self.creds_path = creds_path
        self.agents_by_id = agents_by_id
        self.ollama = ollama
        self.model = model
        self.interval_sec = interval_sec
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last: dict[str, Any] = {}
        self._recent: dict[str, deque[str]] = defaultdict(lambda: deque(maxlen=8))

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run, name="agentworld-mind", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        # Stagger first wave so peers don't talk in lockstep.
        if self._stop.wait(random.uniform(1.0, 4.0)):
            return
        while not self._stop.is_set():
            connected = load_connected(self.creds_path)
            random.shuffle(connected)
            for aid, cred in connected:
                agent = self.agents_by_id.get(aid) or {
                    "name": cred.get("name") or aid,
                    "system": "You are a connected AgentWorld agent.",
                }
                recent = list(self._recent[aid])
                try:
                    result = run_once(
                        cred["world"],
                        cred["api_key"],
                        agent.get("name") or aid,
                        agent.get("system") or "",
                        self.ollama,
                        self.model,
                        recent,
                    )
                    action = (result.get("decision") or {}).get("action")
                    if action:
                        self._recent[aid].append(str(action))
                    self.last[aid] = {
                        "at": time.time(),
                        "ok": result.get("ok"),
                        "action": action,
                        "error": (result.get("result") or {}).get("error"),
                        "thought": ((result.get("decision") or {}).get("thought") or "")[
                            :80
                        ],
                    }
                    tag = "ok" if result.get("ok") else "fail"
                    utt = (result.get("decision") or {}).get("utterance") or ""
                    print(
                        f"[mind] {aid} {tag} action={action} "
                        f"utt={(utt[:50] + '...') if len(utt) > 50 else utt} "
                        f"err={(result.get('result') or {}).get('error')}"
                    )
                except Exception as exc:  # noqa: BLE001
                    self.last[aid] = {"at": time.time(), "ok": False, "error": str(exc)}
                    print(f"[mind] {aid} error: {exc}")
                # Per-agent pause so they don't alternate greetings every 2s.
                if self._stop.wait(random.uniform(4.0, 8.0)):
                    return
            if self._stop.wait(self.interval_sec):
                return
