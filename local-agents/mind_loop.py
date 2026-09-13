"""Local mind loop: connected agents drive themselves via observe → LLM → act.

Hard-validates place IDs + peer UUIDs, blocks self-targets / greeting loops /
system-prompt dumps. Speech topics come from the model — code does not script them.
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
    "mira": "plaza",
    "knurl": "workshop",
    "lumen": "cafe",
    "drift": "park",
    "spar": "notice",
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


def _peer_name_for(observe: dict[str, Any], peer_id: str | None) -> str:
    if not peer_id:
        return "friend"
    for n in list(observe.get("nearby") or []) + list(observe.get("in_sight") or []):
        if isinstance(n, dict) and str(n.get("id") or "") == peer_id:
            return str(n.get("name") or "friend")
    return "friend"


def _addressed_line(observe: dict[str, Any]) -> dict[str, str] | None:
    """What a peer actually said to this agent (pending question or last peer thread line)."""
    you = observe.get("you") or {}
    you_id = str(you.get("id") or "")
    inbox = observe.get("inbox") or {}
    pending = inbox.get("pending_answer") or {}
    if isinstance(pending, dict):
        q = str(pending.get("question") or "").strip()
        if q:
            pid = str(pending.get("from") or "") or ""
            return {
                "peer_id": pid,
                "peer_name": _peer_name_for(observe, pid),
                "text": q[:400],
                "source": "pending_answer",
            }

    thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else None
    if not thread:
        return None
    waiting = bool(inbox.get("waiting_on_you"))
    msgs = list(thread.get("messages") or [])
    for m in reversed(msgs):
        if not isinstance(m, dict):
            continue
        aid = str(m.get("agent_id") or "")
        body = str(m.get("body") or m.get("content") or "").strip()
        if not body or not aid or aid == you_id:
            continue
        return {
            "peer_id": aid,
            "peer_name": _peer_name_for(observe, aid),
            "text": body[:400],
            "source": "thread",
        }
    # waiting but messages lack agent_id — use last line as best effort
    if waiting:
        bodies = _msg_bodies(thread)
        if bodies:
            other = str(thread.get("other_id") or thread.get("starter_id") or "")
            if other == you_id:
                other = str(thread.get("starter_id") or thread.get("other_id") or "")
            return {
                "peer_id": other,
                "peer_name": _peer_name_for(observe, other),
                "text": bodies[-1][:400],
                "source": "thread_fallback",
            }
    return None


_STOP = {
    "that",
    "this",
    "with",
    "have",
    "from",
    "your",
    "about",
    "would",
    "could",
    "their",
    "there",
    "what",
    "when",
    "where",
    "which",
    "been",
    "were",
    "they",
    "them",
    "then",
    "than",
    "into",
    "just",
    "like",
    "some",
    "more",
    "very",
    "also",
    "does",
    "doing",
    "think",
    "thinking",
    "noticed",
    "wonder",
    "curious",
}


def _content_words(text: str) -> set[str]:
    return {
        w
        for w in re.findall(r"[a-z]{4,}", (text or "").lower())
        if w not in _STOP
    }


def _grounds_on_peer(utterance: str | None, peer_text: str | None) -> bool:
    """True if the reply shares concrete words with what was asked (not a free remix)."""
    if not utterance or not peer_text:
        return False
    peer_w = _content_words(peer_text)
    utt_w = _content_words(utterance)
    if not peer_w:
        return len(utterance) >= 24
    overlap = peer_w & utt_w
    # Asking a fresh question back usually fails grounding.
    asks_back = utterance.strip().endswith("?") and len(overlap) < 2
    if asks_back:
        return False
    return len(overlap) >= 2


def _ollama_chat(
    ollama: str,
    model: str,
    system: str,
    user: str,
    temperature: float = 0.7,
) -> str:
    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "options": {"temperature": temperature},
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
    return str((data.get("message") or {}).get("content") or "")


def _decide_direct_answer(
    ollama: str,
    model: str,
    agent_name: str,
    system: str,
    observe: dict[str, Any],
    addressed: dict[str, str],
) -> dict[str, Any]:
    """Focused reply path: must answer the peer's actual line, not start a parallel topic."""
    peer_id = addressed.get("peer_id") or _resolve_peer(observe)
    peer_name = addressed.get("peer_name") or "friend"
    peer_text = addressed.get("text") or ""
    you = observe.get("you") or {}
    prompt = (
        f"You are {agent_name}. A peer is waiting on YOUR answer.\n\n"
        f"{peer_name} just said to you:\n\"\"\"{peer_text}\"\"\"\n\n"
        f"Reply in JSON only:\n"
        f'{{\"action\":\"talk\",\"target_agent\":\"{peer_id}\",\"utterance\":\"...\",\"'
        f'thought\":\"I am answering their specific point about ...\"}}\n\n'
        f"RULES:\n"
        f"- utterance MUST answer THAT message (reuse 2+ of their concrete words).\n"
        f"- Do NOT ask them a similar question back.\n"
        f"- Do NOT change the subject to a new metaphor seminar.\n"
        f"- Give one concrete opinion, method, or example from your craft.\n"
        f"- target_agent must be exactly {peer_id}.\n"
        f"- Never paste 'You are …'.\n\n"
        f"Your background (fuel only):\n{system[:350]}\n"
        f"Your current thought/goal: {(you.get('thought') or '')[:120]}"
    )
    content = _ollama_chat(
        ollama,
        model,
        "Return only valid JSON. Answer the quoted peer message directly.",
        prompt,
        temperature=0.55,
    )
    parsed = _extract_json(content)
    utterance = None
    thought = None
    if parsed:
        utterance = parsed.get("utterance")
        thought = parsed.get("thought")
        if isinstance(utterance, str):
            utterance = utterance.strip()[:280] or None
    if not utterance or _is_bad_filler(utterance) or not _grounds_on_peer(
        utterance, peer_text
    ):
        # Minimal grounded stub — still better than a parallel topic.
        snippet = peer_text[:90].rstrip(".")
        utterance = (
            f"{peer_name}, on what you said — '{snippet}' — "
            f"my take: I treat that as a real constraint and I would start by naming "
            f"one concrete check before changing course."
        )[:280]
        thought = f"Answering {peer_name}'s actual line (fallback)."
    return {
        "action": "talk",
        "target_agent": peer_id,
        "target_place": None,
        "item": None,
        "utterance": utterance,
        "thought": (thought or f"Answering {peer_name} directly.")[:180],
    }


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


SELF_INTRO_RE = re.compile(
    r"^\s*you are\s+\w+|from my craft:\s*you are\b|i tried this recently:\s*you are\b",
    re.I,
)

# Theme buckets used to detect "roles/tools/seasons/spaces" seminar loops.
THEME_LEXICON: dict[str, set[str]] = {
    "identity_roles": {
        "identity",
        "identities",
        "role",
        "roles",
        "label",
        "labels",
        "becoming",
        "malleable",
    },
    "tools_friction": {
        "tool",
        "tools",
        "saw",
        "carpenter",
        "crutch",
        "hindrance",
        "cumbersome",
        "workflow",
        "process",
        "processes",
    },
    "seasons_fluid": {
        "season",
        "seasons",
        "leaves",
        "fluid",
        "fluidity",
        "adapt",
        "adapting",
        "adaptation",
    },
    "place_mood": {
        "space",
        "spaces",
        "room",
        "rooms",
        "mood",
        "moods",
        "atmosphere",
        "plaza",
        "place",
        "places",
    },
    "thinking_style": {
        "thinking",
        "style",
        "styles",
        "problem-solving",
        "creative",
        "collection",
        "methods",
    },
}

MAX_THREAD_TURNS_BEFORE_BREAK = 5
MAX_THEME_HITS_BEFORE_BREAK = 3


def _fingerprint(text: str) -> str:
    t = re.sub(r"\s+", " ", (text or "").lower()).strip()
    t = re.sub(r"[^a-z0-9 ?]", "", t)
    return t[:72]


def _theme_keys(text: str | None) -> set[str]:
    words = set(re.findall(r"[a-z]+", (text or "").lower()))
    hit: set[str] = set()
    for theme, lexicon in THEME_LEXICON.items():
        if words & lexicon:
            hit.add(theme)
    return hit


def _dominant_themes(bodies: list[str], recent_theme_hist: list[str] | None = None) -> list[str]:
    counts: dict[str, int] = defaultdict(int)
    for body in bodies[-8:]:
        for k in _theme_keys(body):
            counts[k] += 1
    for k in recent_theme_hist or []:
        counts[k] += 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [k for k, n in ranked if n >= 2][:5]


def _is_theme_clone(text: str | None, banned: list[str]) -> bool:
    if not text or not banned:
        return False
    hit = _theme_keys(text)
    if not hit:
        return False
    # Clone if mostly recycling the banned seminar themes.
    overlap = hit & set(banned)
    return len(overlap) >= 2 or (len(hit) <= 2 and bool(overlap))


def _is_bad_filler(text: str | None) -> bool:
    """Reject greetings and leaked system-prompt dumps — never invent a replacement topic."""
    if not text or len(text.strip()) < 12:
        return True
    if SELF_INTRO_RE.search(text):
        return True
    if _is_greeting_utterance(text):
        return True
    if re.search(r"\byou are [A-Z][a-z]+\b.*, a\b", text):
        return True
    return False


def _walk_elsewhere(
    agent_name: str,
    observe: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    places = [p for p in _place_ids(observe) if p]
    you_place = (observe.get("you") or {}).get("place_id")
    haunt = _haunt_for(agent_name, observe)
    candidates = [p for p in places if p != you_place]
    if not candidates:
        return {
            "action": "idle",
            "target_place": None,
            "target_agent": None,
            "item": None,
            "utterance": None,
            "thought": reason[:180],
        }
    dest = haunt if haunt in candidates else random.choice(candidates)
    return {
        "action": "walk",
        "target_place": dest,
        "target_agent": None,
        "item": None,
        "utterance": None,
        "thought": f"{reason} Leaving for {dest}."[:180],
    }


def _walk_haunt(
    agent_name: str,
    observe: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    return _walk_elsewhere(agent_name, observe, reason)


def _prefer_fresh_peer(
    nearby: list[dict[str, Any]],
    recent_peers: list[str],
) -> dict[str, Any] | None:
    if not nearby:
        return None
    recent = set(recent_peers[-4:])
    fresh = [n for n in nearby if str(n.get("id") or "") not in recent]
    pool = fresh or list(nearby)
    random.shuffle(pool)
    return pool[0]


def _should_break_social(
    observe: dict[str, Any],
    banned_themes: list[str],
) -> str | None:
    """Return reason to walk away / reset, else None."""
    thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else None
    turns = int((thread or {}).get("turn_count") or 0)
    if turns >= MAX_THREAD_TURNS_BEFORE_BREAK:
        return f"Thread is long ({turns} turns) — change place and peer."
    bodies = _msg_bodies(thread)
    if len(bodies) < 4:
        return None
    seminar = {"identity_roles", "tools_friction", "seasons_fluid", "place_mood", "thinking_style"}
    banned = set(banned_themes) if banned_themes else seminar
    hits = sum(
        1
        for b in bodies[-6:]
        if len(_theme_keys(b) & banned) >= 2
        or _is_theme_clone(b, list(banned))
    )
    if hits >= MAX_THEME_HITS_BEFORE_BREAK:
        return "Theme seminar detected — walk away and invent a different subject later."
    return None


def _sanitize_decision(
    decision: dict[str, Any],
    agent_name: str,
    system: str,
    observe: dict[str, Any],
    recent_fps: list[str] | None = None,
    banned_themes: list[str] | None = None,
    recent_peers: list[str] | None = None,
) -> dict[str, Any]:
    """Force act payload to use real place ids / peer uuids; never self-target."""
    fps = recent_fps or []
    banned = banned_themes or []
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
        return _solo_decision(
            agent_name, observe, f"Unknown action {action}.", system, fps
        )

    utterance = decision.get("utterance")
    if isinstance(utterance, str):
        utterance = utterance.strip()[:280] or None
    else:
        utterance = None

    if utterance and (_is_bad_filler(utterance) or _fingerprint(utterance) in fps):
        utterance = None

    addressed = _addressed_line(observe)
    must_answer = bool(waiting or pending)
    if (
        utterance
        and must_answer
        and addressed
        and not _grounds_on_peer(utterance, addressed.get("text"))
    ):
        # Knows someone spoke — but reply ignored their words. Force grounded answer path later.
        utterance = None

    if utterance and _is_theme_clone(utterance, banned) and not must_answer:
        # Do not speak another remix of the same seminar — leave the thread.
        return _walk_elsewhere(
            agent_name,
            observe,
            "Rejected theme-clone speech — changing scene for a new subject.",
        )

    if action in SOCIAL_ACTIONS and (_is_greeting_utterance(utterance) or not utterance):
        if waiting or pending:
            # Caller should have used _decide_direct_answer; keep a grounded stub here.
            peer = _resolve_peer(observe)
            q = (addressed or {}).get("text") or (
                pending.get("question") if isinstance(pending, dict) else None
            )
            peer_name = (addressed or {}).get("peer_name") or "friend"
            snippet = str(q or "what you raised")[:90]
            return {
                "action": "talk",
                "target_agent": peer or (addressed or {}).get("peer_id"),
                "target_place": None,
                "item": None,
                "utterance": (
                    f"{peer_name}, responding to '{snippet}': I hear the concrete ask — "
                    f"here is my actual position, not a new question."
                )[:280],
                "thought": "Grounded reply after empty/ungrounded speech.",
            }
        return _solo_decision(
            agent_name, observe, "Blocked greeting/filler utterance.", system, fps
        )

    if action in SOCIAL_ACTIONS and greeting_loop and not (waiting or pending):
        if _is_greeting_utterance(utterance) or not utterance or _is_bad_filler(utterance):
            return _solo_decision(
                agent_name,
                observe,
                "Skipping empty greeting in a stuck thread.",
                system,
                fps,
            )

    if action == "walk":
        place = str(decision.get("target_place") or "").strip()
        if place not in places:
            place = _haunt_for(agent_name, observe)
        if place not in places:
            return _solo_decision(
                agent_name, observe, "No valid walk destination.", system, fps
            )
        if place == you.get("place_id"):
            return _walk_elsewhere(
                agent_name, observe, "Already here — picking a different place."
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
                    agent_name, observe, "No object here to inspect.", system, fps
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
        # Prefer a less-recent peer when several are nearby.
        nearby = observe.get("nearby") or []
        preferred = _prefer_fresh_peer(nearby, recent_peers or [])
        if preferred and preferred.get("id") and not waiting and not pending:
            pref_id = str(preferred["id"])
            if peer and peer in {str(p.get("id")) for p in (recent_peers or [])[-2:]}:
                if pref_id != peer and random.random() < 0.65:
                    peer = pref_id
        if not peer or peer == you_id:
            if waiting or pending:
                return _substantive_reply(
                    agent_name,
                    system,
                    observe,
                    pending.get("question") if isinstance(pending, dict) else None,
                    fps,
                )
            return _solo_decision(
                agent_name,
                observe,
                "Social act needs a real nearby peer uuid (not self/name).",
                system,
                fps,
            )
        if not utterance or _is_bad_filler(utterance):
            return _solo_decision(
                agent_name,
                observe,
                "Model speech was empty/filler — silent beat instead of a scripted topic.",
                system,
                fps,
            )
        return {
            "action": action,
            "target_place": None,
            "target_agent": peer,
            "item": None,
            "utterance": utterance[:280],
            "thought": decision.get("thought") or "Speaking from my own thinking.",
        }

    # Solo / ambient — allow silent acts; never inject a topic bank.
    if utterance and _is_bad_filler(utterance):
        utterance = None
    return {
        "action": action,
        "target_place": None,
        "target_agent": None,
        "item": None,
        "utterance": utterance,
        "thought": decision.get("thought") or "Solo beat.",
    }


def _solo_decision(
    agent_name: str,
    observe: dict[str, Any],
    reason: str,
    system: str = "",
    recent_fps: list[str] | None = None,
) -> dict[str, Any]:
    """Silent / navigation-only fallback. No canned topical speech."""
    del system, recent_fps  # unused — speech must come from the model
    objects = _object_ids_here(observe)
    if objects and random.random() < 0.25:
        return {
            "action": "inspect",
            "target_place": None,
            "target_agent": None,
            "item": objects[0],
            "utterance": None,
            "thought": reason[:180],
        }
    if random.random() < 0.5:
        return _walk_haunt(agent_name, observe, reason)
    return {
        "action": random.choice(["reflect", "work", "idle"]),
        "target_place": None,
        "target_agent": None,
        "item": None,
        "utterance": None,
        "thought": reason[:180],
    }


def _substantive_reply(
    agent_name: str,
    system: str,
    observe: dict[str, Any],
    question: str | None,
    recent_fps: list[str] | None = None,
) -> dict[str, Any]:
    """Last-resort answer stub — still no prescribed topic bank."""
    del system, recent_fps
    peer = _resolve_peer(observe)
    if not peer:
        return _solo_decision(
            agent_name, observe, "Wanted to answer but no peer nearby."
        )
    nearby = observe.get("nearby") or []
    peer_row = next((n for n in nearby if str(n.get("id")) == peer), None) or {}
    peer_name = peer_row.get("name") or "friend"
    q = (question or "what you said").strip()[:80]
    return {
        "action": "talk",
        "target_agent": peer,
        "target_place": None,
        "item": None,
        "utterance": (
            f"{peer_name}, on '{q}' — holding for a real take from my own head, "
            f"not a recycled line."
        )[:280],
        "thought": "Answering without a hardcoded topic.",
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
            "recent_lines": [
                {
                    "agent_id": (m.get("agent_id") if isinstance(m, dict) else None),
                    "body": (
                        (m.get("body") or m.get("content") or "")
                        if isinstance(m, dict)
                        else str(m)
                    )[:200],
                }
                for m in (thread.get("messages") or [])[-6:]
            ],
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


def _approach_peer(observe: dict[str, Any]) -> dict[str, Any] | None:
    """Navigation only — never invents dialogue topics."""
    in_sight = observe.get("in_sight") or []
    places = set(_place_ids(observe))
    if not in_sight:
        return None
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
                f"Noticed {peer.get('name') or 'someone'} ~{peer.get('tiles', '?')} "
                f"tiles out — walking to {dest} so we can talk."
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
    recent_fps: list[str] | None = None,
    recent_peers: list[str] | None = None,
    recent_themes: list[str] | None = None,
    place_streak: int = 0,
) -> dict[str, Any]:
    fps = list(recent_fps or [])
    peers_hist = list(recent_peers or [])
    theme_hist = list(recent_themes or [])
    thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else None
    bodies = _msg_bodies(thread)
    for body in bodies[-8:]:
        fp = _fingerprint(body)
        if fp and fp not in fps:
            fps.append(fp)

    banned = _dominant_themes(bodies, theme_hist)
    # Always soft-ban the classic seminar if it is already showing up.
    seminar = {"identity_roles", "tools_friction", "seasons_fluid", "place_mood"}
    if sum(1 for b in bodies[-5:] if _theme_keys(b) & seminar) >= 2:
        for k in seminar:
            if k not in banned:
                banned.append(k)

    you = observe.get("you") or {}
    inbox = observe.get("inbox") or {}
    waiting = bool(inbox.get("waiting_on_you"))
    pending = inbox.get("pending_answer") or {}
    greeting_loop = _is_greeting_loop(bodies)
    nearby = list(observe.get("nearby") or [])
    in_sight = observe.get("in_sight") or []
    random.shuffle(nearby)

    def _san(d: dict[str, Any]) -> dict[str, Any]:
        return _sanitize_decision(
            d, agent_name, system, observe, fps, banned, peers_hist
        )

    addressed = _addressed_line(observe)
    # Someone is waiting on us: answer THEIR words. Do not theme-ban or walk away.
    if waiting or pending:
        if not addressed and isinstance(pending, dict) and pending.get("question"):
            pid = str(pending.get("from") or "") or (_resolve_peer(observe) or "")
            addressed = {
                "peer_id": pid,
                "peer_name": _peer_name_for(observe, pid),
                "text": str(pending.get("question"))[:400],
                "source": "pending_answer",
            }
        if addressed:
            return _san(
                _decide_direct_answer(
                    ollama, model, agent_name, system, observe, addressed
                )
            )

    # Hard break: long / theme-stuck threads → walk (closes dialogue server-side).
    if not waiting and not pending:
        break_reason = _should_break_social(observe, banned)
        if break_reason:
            return _san(_walk_elsewhere(agent_name, observe, break_reason))
        if place_streak >= 4 and nearby:
            return _san(
                _walk_elsewhere(
                    agent_name,
                    observe,
                    "Same place too long — scatter so conversations can change.",
                )
            )

    if greeting_loop and len(bodies) >= 6 and not waiting and not pending:
        return _san(
            _walk_elsewhere(
                agent_name,
                observe,
                "Greeting loop stuck — leave and reinvent the subject elsewhere.",
            )
        )

    if you.get("status") == "walking":
        return {
            "action": "idle",
            "thought": you.get("thought") or "Still walking.",
            "utterance": None,
            "target_agent": None,
            "target_place": None,
            "item": None,
        }

    # Prefer approaching a peer we have NOT recently spoken with.
    if in_sight and not nearby and not waiting and random.random() < 0.7:
        fresh_sight = [
            p
            for p in in_sight
            if str(p.get("id") or "") not in set(peers_hist[-3:])
        ] or list(in_sight)
        peer = fresh_sight[0]
        dest = peer.get("place_id")
        places = set(_place_ids(observe))
        if dest and dest in places and dest != you.get("place_id"):
            return _san(
                {
                    "action": "walk",
                    "target_place": dest,
                    "target_agent": None,
                    "item": None,
                    "utterance": None,
                    "thought": (
                        f"Seeking {peer.get('name') or 'someone'} at {dest} "
                        f"for a different conversation."
                    )[:180],
                }
            )

    preferred = _prefer_fresh_peer(nearby, peers_hist)
    preferred_id = str((preferred or {}).get("id") or "") or None

    slim = _slim_observe(observe)
    slim["nearby"] = [
        {
            "id": n.get("id"),
            "name": n.get("name"),
            "place_id": n.get("place_id"),
            "status": n.get("status"),
            "thought": (n.get("thought") or "")[:120],
            "origin_summary": (n.get("origin_summary") or "")[:100],
        }
        for n in nearby[:6]
    ]
    slim["avoid_repeating"] = fps[-8:]
    slim["banned_theme_clusters"] = banned
    slim["prefer_peer_id"] = preferred_id
    if addressed:
        slim["peer_just_said"] = addressed
    slim["diversity"] = {
        "recent_peers": peers_hist[-4:],
        "place_streak": place_streak,
        "hint": "Change subject domain. Do not remix roles/tools/seasons/spaces.",
    }
    priorities = list(observe.get("what_to_do_next") or [])
    # Strip "answer with NEW subject" noise — only applies when NOT answering.
    if banned:
        priorities.insert(
            0,
            "BANNED theme clusters for this beat (do not reuse): "
            + ", ".join(banned)
            + ". Invent a completely different subject OR walk away.",
        )
    if preferred_id:
        priorities.insert(
            0,
            f"Prefer target_agent={preferred_id} (fresher peer) if they are nearby.",
        )
    if nearby:
        priorities.insert(
            0,
            "Peers nearby — invent a NEW subject from a concrete detail of THEIR craft "
            "or THIS place's objects/event — not the banned themes. "
            "If someone asked you something (see peer_just_said), answer THAT instead.",
        )
    elif in_sight:
        priorities.insert(
            0,
            "Peers in sight — walk to their place_id first, then talk.",
        )
    if place_streak >= 2:
        priorities.append("Consider walking to another place_id to reset the scene.")
    priorities.append("Never invent peer UUIDs. Never dump system prompts into utterance.")
    priorities.append(
        "If the open thread is already about roles/tools/identity and nobody is waiting on you, walk away."
    )

    prompt = (
        f"You are {agent_name} in AgentWorld. Choose ONE next beat as JSON only.\n"
        f"Schema: {{\"action\":\"walk|talk|ask_question|share_experience|teach|debate|"
        f"practice_skill|reflect|work|inspect|eat|rest|idle|leave_note\","
        f"\"target_place\":null_or_place_id,\"target_agent\":null_or_uuid,"
        f"\"item\":null_or_object_id,\"utterance\":null_or_speech,\"thought\":\"private why\"}}\n\n"
        f"HARD RULES:\n"
        f"- Invent the topic yourself. Banned clusters this beat: {banned or ['(none yet)']}.\n"
        f"- If continuing would reuse banned themes, action=walk to a different place_id.\n"
        f"- Prefer a peer you have not just spoken with (prefer_peer_id).\n"
        f"- utterance must be original; never echo avoid_repeating.\n"
        f"- target_agent MUST be a UUID from nearby_ids_only.\n"
        f"- Never ask how-are-you. Never paste 'You are …'.\n"
        f"- Recent actions: {recent_actions[-6:] or ['(none)']}\n\n"
        f"Priorities:\n- " + "\n- ".join(priorities[:8]) + "\n\n"
        f"Context:\n{json.dumps(slim, ensure_ascii=False)[:4500]}\n\n"
        f"Your background (fuel only — do NOT quote as 'You are…'):\n{system[:400]}"
    )

    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Return only valid JSON. Use real UUIDs from nearby_ids_only. "
                        "Diversify: new peers, new places, new subject domains. "
                        "Refuse to remix roles/tools/seasons/spaces seminars. "
                        "Never dump system prompts."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "options": {"temperature": 1.0},
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
        if nearby or in_sight:
            return _san(
                _walk_elsewhere(
                    agent_name, observe, "Bad JSON — walking to reset the scene."
                )
            )
        if waiting or pending:
            return _san(
                _substantive_reply(
                    agent_name,
                    system,
                    observe,
                    pending.get("question") if isinstance(pending, dict) else None,
                    fps,
                )
            )
        return _solo_decision(
            agent_name, observe, "Model returned bad JSON — silent fallback.", system, fps
        )

    return _san(parsed)


def run_once(
    world: str,
    api_key: str,
    agent_name: str,
    system: str,
    ollama: str,
    model: str,
    recent_actions: list[str],
    recent_fps: list[str] | None = None,
    recent_peers: list[str] | None = None,
    recent_themes: list[str] | None = None,
    place_streak: int = 0,
) -> dict[str, Any]:
    world = world.rstrip("/")
    me = _http_json("GET", f"{world}/api/agents/me", api_key=api_key)
    if not me.get("ok") or not me.get("in_town"):
        return {"ok": False, "stage": "me", "result": me}
    obs = _http_json("GET", f"{world}/api/agents/me/observe", api_key=api_key)
    if not obs.get("ok"):
        return {"ok": False, "stage": "observe", "result": obs}

    decision = decide_act(
        ollama,
        model,
        agent_name,
        system,
        obs,
        recent_actions,
        recent_fps,
        recent_peers,
        recent_themes,
        place_streak,
    )
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
        "place_id": ((obs.get("you") or {}).get("place_id")),
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
        self._utter_fps: dict[str, deque[str]] = defaultdict(lambda: deque(maxlen=16))
        self._recent_peers: dict[str, deque[str]] = defaultdict(lambda: deque(maxlen=6))
        self._theme_hist: dict[str, deque[str]] = defaultdict(lambda: deque(maxlen=24))
        self._place_streak: dict[str, tuple[str | None, int]] = {}

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
                recent_fps = list(self._utter_fps[aid])
                recent_peers = list(self._recent_peers[aid])
                recent_themes = list(self._theme_hist[aid])
                place_id_prev, streak = self._place_streak.get(aid, (None, 0))
                try:
                    result = run_once(
                        cred["world"],
                        cred["api_key"],
                        agent.get("name") or aid,
                        agent.get("system") or "",
                        self.ollama,
                        agent.get("model") or self.model,
                        recent,
                        recent_fps,
                        recent_peers,
                        recent_themes,
                        streak,
                    )
                    action = (result.get("decision") or {}).get("action")
                    if action:
                        self._recent[aid].append(str(action))
                    utt = (result.get("decision") or {}).get("utterance") or ""
                    if utt:
                        fp = _fingerprint(str(utt))
                        if fp:
                            self._utter_fps[aid].append(fp)
                        for theme in _theme_keys(str(utt)):
                            self._theme_hist[aid].append(theme)
                    peer = (result.get("decision") or {}).get("target_agent") or ""
                    if peer:
                        self._recent_peers[aid].append(str(peer))
                    place_now = result.get("place_id")
                    if action == "walk":
                        self._place_streak[aid] = (None, 0)
                    elif place_now:
                        if place_now == place_id_prev:
                            self._place_streak[aid] = (place_now, streak + 1)
                        else:
                            self._place_streak[aid] = (place_now, 1)
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
