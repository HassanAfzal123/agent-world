"""Local mind loop: connected agents drive themselves via observe → LLM → act.

Hard-validates place IDs + peer UUIDs, blocks self-targets / greeting loops,
and falls back to solo craft when social acts are invalid.
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

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
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

# Real place ids from AgentWorld map (no fictional "office").
HAUNT = {
    "patch": "workshop",
    "triage": "cafe",
    "brief": "cafe",
    "scout": "library",
    "clerk": "plaza",
    "forge": "workshop",
    "merge": "bank",
    "probe": "workshop",
    "relay": "docks",
    "hex": "library",
    "quill": "library",
    "cedar": "notice",
    "north": "plaza",
}

ALLOWED_ACTIONS = {
    "walk",
    "talk",
    "ask_question",
    "share_experience",
    "teach",
    "debate",
    "practice_skill",
    "reflect",
    "work",
    "inspect",
    "eat",
    "rest",
    "idle",
    "leave_note",
    "post_notice",
    "fix",
    "shop",
    "demo",
    "ask_favor",
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


def _object_ids_here(observe: dict[str, Any]) -> list[str]:
    you_place = (observe.get("you") or {}).get("place_id")
    out: list[str] = []
    for obj in observe.get("objects") or []:
        if not isinstance(obj, dict):
            continue
        if obj.get("holder_id"):
            continue
        if you_place and obj.get("place_id") and obj.get("place_id") != you_place:
            continue
        oid = obj.get("id")
        if oid:
            out.append(str(oid))
    return out


def _haunt_for(agent_name: str, observe: dict[str, Any]) -> str:
    ids = set(_place_ids(observe))
    preferred = HAUNT.get(agent_name.lower(), "plaza")
    if preferred in ids:
        return preferred
    if "plaza" in ids:
        return "plaza"
    you_place = (observe.get("you") or {}).get("place_id")
    candidates = [p for p in _place_ids(observe) if p != you_place]
    return random.choice(candidates) if candidates else (you_place or "plaza")


def _nearby_index(observe: dict[str, Any]) -> tuple[dict[str, dict], dict[str, dict]]:
    by_id: dict[str, dict] = {}
    by_name: dict[str, dict] = {}
    for n in observe.get("nearby") or []:
        if not isinstance(n, dict) or not n.get("id"):
            continue
        nid = str(n["id"])
        by_id[nid] = n
        name = str(n.get("name") or "").strip().lower()
        if name:
            by_name[name] = n
    return by_id, by_name


def _resolve_peer(observe: dict[str, Any], raw: Any = None) -> str | None:
    """Map model output (uuid / name / junk) to a real nearby peer uuid ≠ self."""
    you_id = str((observe.get("you") or {}).get("id") or "")
    by_id, by_name = _nearby_index(observe)

    def _ok(pid: str | None) -> str | None:
        if not pid or pid == you_id:
            return None
        if pid in by_id:
            return pid
        # Allow thread peers even if not in nearby snapshot.
        thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else {}
        for key in ("starter_id", "other_id"):
            if str(thread.get(key) or "") == pid and pid != you_id:
                return pid
        pending = (observe.get("inbox") or {}).get("pending_answer") or {}
        if str(pending.get("from") or "") == pid:
            return pid
        return None

    if raw is not None and str(raw).strip():
        s = str(raw).strip().strip("\"'`")
        if UUID_RE.match(s):
            hit = _ok(s)
            if hit:
                return hit
        name_hit = by_name.get(s.lower())
        if name_hit:
            return _ok(str(name_hit.get("id")))

    thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else {}
    for key in ("starter_id", "other_id"):
        hit = _ok(str(thread.get(key) or "") or None)
        if hit:
            return hit
    pending = (observe.get("inbox") or {}).get("pending_answer") or {}
    hit = _ok(str(pending.get("from") or "") or None)
    if hit:
        return hit
    for nid in by_id:
        hit = _ok(nid)
        if hit:
            return hit
    return None


def _craft_line(agent_name: str, system: str) -> str:
    first = (system or "").split(".")[0].strip()
    if len(first) > 20:
        return first[:160]
    return f"Doing a concrete {agent_name} craft beat — methods only, no secrets."


def _solo_decision(
    agent_name: str,
    observe: dict[str, Any],
    reason: str,
    system: str = "",
) -> dict[str, Any]:
    haunt = _haunt_for(agent_name, observe)
    you_place = (observe.get("you") or {}).get("place_id")
    craft = _craft_line(agent_name, system)
    objects = _object_ids_here(observe)

    if you_place != haunt and haunt in set(_place_ids(observe)):
        return {
            "action": "walk",
            "target_place": haunt,
            "target_agent": None,
            "item": None,
            "utterance": None,
            "thought": f"{reason} Walking to {haunt}.",
        }

    picks: list[dict[str, Any]] = [
        {
            "action": "reflect",
            "utterance": craft,
            "thought": reason,
        },
        {
            "action": "work",
            "utterance": f"{agent_name} working a small real task: {craft[:120]}",
            "thought": reason,
        },
        {
            "action": "practice_skill",
            "utterance": f"Practicing one {agent_name} drill — {craft[:100]}",
            "thought": reason,
        },
        {
            "action": "leave_note",
            "utterance": f"Note to self: {craft[:140]}",
            "thought": reason,
        },
    ]
    if objects:
        picks.append(
            {
                "action": "inspect",
                "item": objects[0],
                "utterance": f"Inspecting {objects[0]} with a craft eye.",
                "thought": reason,
            }
        )
    pick = random.choice(picks)
    return {
        "action": pick["action"],
        "target_place": None,
        "target_agent": None,
        "item": pick.get("item"),
        "utterance": (pick.get("utterance") or "")[:280] or None,
        "thought": pick.get("thought") or reason,
    }


def _substantive_reply(
    agent_name: str,
    system: str,
    observe: dict[str, Any],
    question: str | None,
) -> dict[str, Any]:
    peer = _resolve_peer(observe)
    if not peer:
        return _solo_decision(
            agent_name, observe, "Wanted to answer but no peer nearby.", system
        )
    craft = _craft_line(agent_name, system)
    q = (question or "your point").strip()[:100]
    utterance = (
        f"On '{q}' — my take as {agent_name}: {craft}. "
        "One next step: try that method once, then compare notes."
    )[:280]
    return {
        "action": "talk",
        "target_agent": peer,
        "target_place": None,
        "item": None,
        "utterance": utterance,
        "thought": "Answering with craft detail instead of another greeting.",
    }


def _sanitize_decision(
    decision: dict[str, Any],
    agent_name: str,
    system: str,
    observe: dict[str, Any],
) -> dict[str, Any]:
    """Force act payload to use real place ids / peer uuids; never self-target."""
    you = observe.get("you") or {}
    you_id = str(you.get("id") or "")
    places = set(_place_ids(observe))
    objects = set(_object_ids_here(observe))
    inbox = observe.get("inbox") or {}
    waiting = bool(inbox.get("waiting_on_you"))
    pending = inbox.get("pending_answer") or {}
    thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else None
    bodies = _msg_bodies(thread)
    greeting_loop = _is_greeting_loop(bodies)

    action = str(decision.get("action") or "idle").strip()
    if action not in ALLOWED_ACTIONS:
        return _solo_decision(agent_name, observe, f"Unknown action {action}.", system)

    utterance = decision.get("utterance")
    if isinstance(utterance, str):
        utterance = utterance.strip()[:280] or None
    else:
        utterance = None

    if action in SOCIAL_ACTIONS and _is_greeting_utterance(utterance):
        if waiting or pending:
            return _substantive_reply(
                agent_name,
                system,
                observe,
                pending.get("question") if isinstance(pending, dict) else None,
            )
        return _solo_decision(
            agent_name, observe, "Blocked greeting utterance.", system
        )

    if action in SOCIAL_ACTIONS and greeting_loop and not (waiting or pending):
        # Allow craft talk through; only bounce empty/greeting-ish lines.
        if _is_greeting_utterance(utterance) or not utterance:
            return _solo_decision(
                agent_name, observe, "Skipping empty greeting in a stuck thread.", system
            )

    if action == "walk":
        place = str(decision.get("target_place") or "").strip()
        if place not in places:
            place = _haunt_for(agent_name, observe)
        if place not in places:
            return _solo_decision(
                agent_name, observe, "No valid walk destination.", system
            )
        if place == you.get("place_id"):
            return _solo_decision(
                agent_name, observe, "Already at destination — solo craft.", system
            )
        return {
            "action": "walk",
            "target_place": place,
            "target_agent": None,
            "item": None,
            "utterance": None,
            "thought": decision.get("thought") or f"Walking to {place}.",
        }

    if action == "inspect":
        item = str(decision.get("item") or "").strip()
        if item not in objects:
            if objects:
                item = next(iter(objects))
            else:
                return _solo_decision(
                    agent_name, observe, "No object here to inspect.", system
                )
        return {
            "action": "inspect",
            "target_place": None,
            "target_agent": None,
            "item": item,
            "utterance": utterance,
            "thought": decision.get("thought") or "Inspecting something nearby.",
        }

    if action in SOCIAL_ACTIONS:
        peer = _resolve_peer(observe, decision.get("target_agent"))
        if not peer or peer == you_id:
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
                "Social act needs a real nearby peer uuid (not self/name).",
                system,
            )
        if not utterance or len(utterance) < 12:
            utterance = _craft_line(agent_name, system)
        return {
            "action": action,
            "target_place": None,
            "target_agent": peer,
            "item": None,
            "utterance": utterance[:280],
            "thought": decision.get("thought") or "Sharing craft with a peer.",
        }

    # Solo / ambient
    return {
        "action": action,
        "target_place": None,
        "target_agent": None,
        "item": None,
        "utterance": utterance or _craft_line(agent_name, system),
        "thought": decision.get("thought") or "Solo craft beat.",
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
            "last_action": you.get("last_action"),
            "origin_summary": (you.get("origin_summary") or "")[:160],
        },
        "hour": observe.get("hour"),
        "event": observe.get("event"),
        "nearby": [
            {
                "id": n.get("id"),
                "name": n.get("name"),
                "place_id": n.get("place_id"),
                "status": n.get("status"),
            }
            for n in nearby[:6]
        ],
        "nearby_ids_only": [n.get("id") for n in nearby[:6] if n.get("id")],
        "in_sight": [
            {
                "id": n.get("id"),
                "name": n.get("name"),
                "place_id": n.get("place_id"),
                "tiles": n.get("tiles"),
            }
            for n in (observe.get("in_sight") or [])[:6]
            if isinstance(n, dict)
        ],
        "objects_here": _object_ids_here(observe)[:8],
        "talk_range": observe.get("talk_range"),
        "sight_range": observe.get("sight_range"),
        "inbox": observe.get("inbox"),
        "what_to_do_next": (observe.get("what_to_do_next") or [])[:4],
        "thread": None
        if not thread
        else {
            "topic": thread.get("topic"),
            "waiting_on": thread.get("waiting_on"),
            "turn_count": thread.get("turn_count"),
            "recent_lines": bodies[-5:],
            "greeting_loop": _is_greeting_loop(bodies),
        },
        "memories": (observe.get("memories") or [])[:4],
        "place_ids": _place_ids(observe),
        "rules": {
            "target_agent": "MUST be a UUID from nearby_ids_only (never a name, never yourself).",
            "target_place": "MUST be an id from place_ids. Use in_sight[].place_id to approach.",
            "inspect": "Requires item id from objects_here.",
            "open_minds": "Seek peers, share methods, discuss craft — never secrets.",
        },
    }


def _social_beat(
    agent_name: str,
    system: str,
    observe: dict[str, Any],
    recent_actions: list[str],
) -> dict[str, Any] | None:
    """Prefer real peer talk when someone is in range; seek when only in sight."""
    nearby = observe.get("nearby") or []
    in_sight = observe.get("in_sight") or []
    places = set(_place_ids(observe))
    craft = _craft_line(agent_name, system)

    if nearby:
        peer = nearby[0]
        peer_id = peer.get("id")
        peer_name = peer.get("name") or "a peer"
        if not peer_id:
            return None
        # Rotate social verbs so threads aren't only talk.
        cycle = ["talk", "share_experience", "ask_question", "teach", "debate"]
        last = recent_actions[-1] if recent_actions else ""
        action = next((a for a in cycle if a != last), "talk")
        prompts = {
            "talk": f"{peer_name}, from my craft: {craft[:140]} — what's one method you'd keep?",
            "share_experience": f"I tried this recently: {craft[:140]}. Curious how you handle it, {peer_name}.",
            "ask_question": f"{peer_name}, when you do your craft, what's the first check you run before trusting a result?",
            "teach": f"One portable tip from me: {craft[:140]}. Steal it if it helps.",
            "debate": f"Gentle pushback, {peer_name}: is the usual approach always right, or does {craft[:80]}… change it?",
        }
        return {
            "action": action,
            "target_agent": peer_id,
            "target_place": None,
            "item": None,
            "utterance": prompts.get(action, craft)[:280],
            "thought": (
                f"Open minds: socializing with {peer_name} about craft — "
                f"not small talk."
            )[:180],
        }

    if in_sight:
        peer = in_sight[0]
        dest = peer.get("place_id")
        if dest and dest in places:
            return {
                "action": "walk",
                "target_place": dest,
                "target_agent": None,
                "item": None,
                "utterance": None,
                "thought": (
                    f"I notice {peer.get('name') or 'someone'} about "
                    f"{peer.get('tiles', '?')} tiles out — walking to {dest} "
                    f"to exchange methods (open minds)."
                )[:180],
            }
    return None


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
    nearby = observe.get("nearby") or []
    in_sight = observe.get("in_sight") or []
    social_streak = 0
    for a in reversed(recent_actions):
        if a in SOCIAL_ACTIONS:
            social_streak += 1
        else:
            break
    solo_streak = 0
    for a in reversed(recent_actions):
        if a not in SOCIAL_ACTIONS and a != "idle":
            solo_streak += 1
        else:
            break

    # Only break greeting spam when it is clearly stuck (many greeting lines).
    if greeting_loop and len(bodies) >= 6 and not waiting and not pending:
        seek = _social_beat(agent_name, system, observe, recent_actions)
        # Prefer seeking a different place / peer over more greetings.
        if in_sight:
            return _sanitize_decision(
                seek or _solo_decision(agent_name, observe, "Leaving greeting loop.", system),
                agent_name,
                system,
                observe,
            )
        return _solo_decision(
            agent_name,
            observe,
            "Greeting loop stuck — brief solo then find someone new.",
            system,
        )

    if you.get("status") == "walking":
        return {
            "action": "idle",
            "thought": (
                you.get("thought")
                or "Still walking toward a peer or place — keeping social intent."
            ),
            "utterance": None,
            "target_agent": None,
            "target_place": None,
            "item": None,
        }

    # Soft anti-loop: after 4 social beats, one solo — then social again.
    # If we've been solo for a while and peers exist, force socialize.
    if solo_streak >= 2 and (nearby or in_sight) and not waiting:
        forced = _social_beat(agent_name, system, observe, recent_actions)
        if forced:
            return _sanitize_decision(forced, agent_name, system, observe)

    if social_streak >= 4 and not waiting and not pending and not nearby:
        return _solo_decision(
            agent_name,
            observe,
            "Short craft beat between conversations.",
            system,
        )

    # When peers are right here, often take a social beat without relying on the tiny model.
    if nearby and social_streak < 4 and random.random() < 0.7:
        forced = _social_beat(agent_name, system, observe, recent_actions)
        if forced:
            return _sanitize_decision(forced, agent_name, system, observe)

    if in_sight and not nearby and random.random() < 0.65:
        forced = _social_beat(agent_name, system, observe, recent_actions)
        if forced:
            return _sanitize_decision(forced, agent_name, system, observe)

    slim = _slim_observe(observe)
    priorities = list(observe.get("what_to_do_next") or [])
    if waiting or pending:
        priorities.insert(
            0,
            "PRIORITY: Answer with ONE concrete method from your craft. "
            "target_agent = UUID from nearby_ids_only. No greetings.",
        )
    if nearby:
        priorities.insert(
            0,
            "Peers in talk range — prefer talk/share_experience/teach/ask_question with craft detail.",
        )
    elif in_sight:
        priorities.insert(
            0,
            "Peers in sight — walk to their place_id first, then talk (open minds).",
        )
    priorities.append(
        "Balance: socialize often when peers are near; solo craft when alone. Never invent peer UUIDs."
    )

    prompt = (
        f"You are {agent_name} in AgentWorld. Choose ONE next beat as JSON only.\n"
        f"Schema: {{\"action\":\"walk|talk|ask_question|share_experience|teach|debate|"
        f"practice_skill|reflect|work|inspect|eat|rest|idle|leave_note\","
        f"\"target_place\":null_or_place_id,\"target_agent\":null_or_uuid,"
        f"\"item\":null_or_object_id,\"utterance\":null_or_speech,\"thought\":\"private social/craft why\"}}\n\n"
        f"HARD RULES:\n"
        f"- thought should say who you want to meet and what craft topic (open minds).\n"
        f"- target_agent MUST be a UUID from nearby_ids_only. NEVER a name. NEVER yourself.\n"
        f"- If only in_sight: walk to that peer's place_id (do not talk yet).\n"
        f"- target_place MUST be from place_ids.\n"
        f"- Never ask how-are-you. Prefer methods, opinions, lessons.\n"
        f"- Recent actions: {recent_actions[-6:] or ['(none)']}\n\n"
        f"Priorities:\n- " + "\n- ".join(priorities[:6]) + "\n\n"
        f"Context:\n{json.dumps(slim, ensure_ascii=False)[:4200]}\n\n"
        f"Your craft:\n{system[:450]}"
    )

    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Return only valid JSON. Use real UUIDs from nearby_ids_only. "
                        "You want open-minds conversations about craft when peers are near."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "options": {"temperature": 0.7},
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
        forced = _social_beat(agent_name, system, observe, recent_actions)
        if forced and (nearby or in_sight):
            return _sanitize_decision(forced, agent_name, system, observe)
        if waiting or pending:
            return _sanitize_decision(
                _substantive_reply(
                    agent_name,
                    system,
                    observe,
                    pending.get("question") if isinstance(pending, dict) else None,
                ),
                agent_name,
                system,
                observe,
            )
        return _solo_decision(
            agent_name, observe, "Model returned bad JSON — solo fallback.", system
        )

    return _sanitize_decision(parsed, agent_name, system, observe)


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

    # One recovery beat if validation still failed server-side.
    if not act.get("ok"):
        err = str(act.get("error") or "")
        if any(
            x in err
            for x in (
                "bad_place",
                "invalid input syntax",
                "no_object",
                "uuid",
                "target",
            )
        ):
            decision = _solo_decision(
                agent_name,
                obs,
                f"Recovering after act error: {err[:80]}",
                system,
            )
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
                if agent.get("local_only"):
                    continue
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
                    peer = (result.get("decision") or {}).get("target_agent") or ""
                    print(
                        f"[mind] {aid} {tag} action={action} "
                        f"peer={(str(peer)[:8] + '..') if peer else '-'} "
                        f"utt={(utt[:46] + '...') if len(utt) > 46 else utt} "
                        f"err={(result.get('result') or {}).get('error')}"
                    )
                except Exception as exc:  # noqa: BLE001
                    self.last[aid] = {"at": time.time(), "ok": False, "error": str(exc)}
                    print(f"[mind] {aid} error: {exc}")
                if self._stop.wait(random.uniform(4.0, 8.0)):
                    return
            if self._stop.wait(self.interval_sec):
                return
