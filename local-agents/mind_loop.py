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
    "invite_to_group",
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
    "invite_to_group",
    "compose_proposal",
    "nominate_idea",
    "vote_idea",
    "appoint_filer",
    "file_proposal",
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
                "text": q[:1200],
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
            "text": body[:1200],
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
                "text": bodies[-1][:1200],
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
    """True if the reply engages the peer's words (not a free remix lecture)."""
    if not utterance or not peer_text:
        return False
    peer_w = _content_words(peer_text)
    utt_w = _content_words(utterance)
    if not peer_w:
        return len(utterance) >= 24
    overlap = peer_w & utt_w
    # Pure subject-change question with zero shared content is not an answer.
    if utterance.strip().endswith("?") and len(overlap) < 1:
        return False
    return len(overlap) >= 1


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
    """Reply to the peer's actual line like a townsperson in a real conversation."""
    peer_id = addressed.get("peer_id") or _resolve_peer(observe)
    peer_name = addressed.get("peer_name") or "friend"
    peer_text = addressed.get("text") or ""
    you = observe.get("you") or {}
    place = you.get("place_id") or "town"
    prompt = (
        f"You are {agent_name}, a resident of AgentWorld (a living town). "
        f"You are at {place}. This is YOUR life — plans, neighbors, work, opinions.\n\n"
        f"{peer_name} just said to you:\n\"\"\"{peer_text}\"\"\"\n\n"
        f"Reply in JSON only:\n"
        f'{{\"action\":\"talk\",\"target_agent\":\"{peer_id}\",\"utterance\":\"...\",\"'
        f'thought\":\"what I want next from this chat\"}}\n\n'
        f"RULES:\n"
        f"- Answer THEIR point in plain speech (reuse 1–2 of their concrete words).\n"
        f"- Sound like a person chatting: agree, disagree, propose a plan, ask one "
        f"follow-up, offer help, gossip about town, or share what YOU want to do next.\n"
        f"- Do NOT lecture about craft metaphors, identity labels, or 'how places shape us'.\n"
        f"- Do NOT say 'open stage', 'craft take', or paste 'You are …'.\n"
        f"- One clear beat only. target_agent must be exactly {peer_id}.\n\n"
        f"Who you are (fuel only):\n{system[:420]}\n"
        f"Your current thought/goal: {(you.get('thought') or you.get('goal') or '')[:140]}"
    )
    content = _ollama_chat(
        ollama,
        model,
        "Return only valid JSON. Talk like a town resident continuing a real conversation.",
        prompt,
        temperature=0.75,
    )
    parsed = _extract_json(content)
    utterance = None
    thought = None
    if parsed:
        utterance = parsed.get("utterance")
        thought = parsed.get("thought")
        if isinstance(utterance, str):
            utterance = utterance.strip()[:4000] or None
    if not utterance or _is_bad_filler(utterance) or not _grounds_on_peer(
        utterance, peer_text
    ):
        peer_short = re.sub(r"\s+", " ", peer_text).strip()[:70]
        utterance = (
            f"{peer_name}, yes — let's lock one next step on that. "
            f"I'll take the practical piece if you take the coordination piece. "
            f"You said: {peer_short}."
        )[:4000]
        thought = f"Answering {peer_name} with a concrete split of work."
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
    out: list[str] = []
    for p in observe.get("places") or []:
        if isinstance(p, dict) and p.get("id"):
            out.append(str(p["id"]))
        elif isinstance(p, str) and p.strip():
            out.append(p.strip())
    return out


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

MAX_THREAD_TURNS_BEFORE_BREAK = 14
MAX_THEME_HITS_BEFORE_BREAK = 3

# Soft seeds for internet / AI-agent discourse (hints only — never canned speech).
HOT_TOPIC_SEEDS: list[str] = [
    "AI agents replacing busywork vs still needing a human in the loop",
    "people building personal agent swarms and whether that feels lonely or liberating",
    "agent-to-agent protocols — should towns like ours talk to other agent networks?",
    "trust: when should a human approve an agent's action before it runs?",
    "open-source local models vs cloud agents — who should own the memory?",
    "AI companions / copilots changing how humans work and socialize",
    "scams and fake agents on the internet — how do we stay open-minded but careful?",
    "whether agent towns are demos or the start of a real online society",
    "job anxiety: which human skills stay valuable next to capable agents",
    "multi-agent collaboration failures you've seen online and what we'd do differently here",
]


def _hot_topic_seed(agent_name: str, hour: Any = None) -> str:
    idx = (sum(ord(c) for c in agent_name) + int(hour or 0) * 3) % len(HOT_TOPIC_SEEDS)
    return HOT_TOPIC_SEEDS[idx]


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


OPEN_STAGE_SPAM_RE = re.compile(
    r"open stage\s*[—\-:]|here is my craft take|not a recycled metaphor|"
    r"what this town should prioritize|on what you said\s*[—\-]|"
    r"my take:\s*i treat that as|not a recycled meta|"
    r"i('m| am) in — let's treat that as a real town next-step|"
    r"i hear the concrete ask\s*[—\-]|"
    r"why i am saying this",
    re.I,
)

ATMOSPHERE_SEMINAR_RE = re.compile(
    r"how (the |this )?(plaza|space|room|environment|atmosphere|layout).{0,40}"
    r"(shape|affect|influence|mirror)|cozy atmosphere|narrative light|"
    r"spaces shape|environment shapes",
    re.I,
)


def _is_bad_filler(text: str | None) -> bool:
    """Reject greetings, prompt dumps, canned open-stage spam, atmosphere seminars."""
    if not text or len(text.strip()) < 12:
        return True
    if SELF_INTRO_RE.search(text):
        return True
    if _is_greeting_utterance(text):
        return True
    if OPEN_STAGE_SPAM_RE.search(text):
        return True
    if ATMOSPHERE_SEMINAR_RE.search(text):
        return True
    if re.search(r"\byou are [A-Z][a-z]+\b.*, a\b", text):
        return True
    # Nested quote soup from agents answering their own fallbacks.
    if text.count("'") >= 4 and ("open stage" in text.lower() or "on what you said" in text.lower()):
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

    # Forced process: plaza prep (:33-:40) / meeting / voting. Filing handled separately.
    cycle_early = observe.get("proposal_cycle") if isinstance(observe.get("proposal_cycle"), dict) else {}
    phase_early = str(cycle_early.get("phase") or "")
    utc_early = int(cycle_early.get("utc_minute") or 0)
    you_early = observe.get("you") if isinstance(observe.get("you"), dict) else {}
    meet_place = str(cycle_early.get("meeting_place") or "plaza")
    at_meet = str(you_early.get("place_id") or "") == meet_place
    gather = phase_early in ("meeting", "voting") or (
        phase_early == "collaborate" and 33 <= utc_early < 41
    )
    champ_id = str(cycle_early.get("champion_id") or "")
    you_id = str(you_early.get("id") or "")
    is_champ = bool(champ_id and you_id and champ_id == you_id)

    if phase_early == "filing" and is_champ:
        if str(you_early.get("place_id") or "") != "library":
            if not (action == "walk" and str(decision.get("target_place") or "") == "library"):
                return {
                    "action": "walk",
                    "target_place": "library",
                    "target_agent": None,
                    "item": None,
                    "utterance": None,
                    "thought": "Forced process: filing champion → library to file_proposal with the DETAILED group report.",
                }
        elif action == "walk" and str(decision.get("target_place") or "") not in ("", "library"):
            return {
                "action": "file_proposal",
                "target_place": None,
                "target_agent": None,
                "item": str(cycle_early.get("winning_title") or decision.get("item") or "Winning tool")[:160],
                "utterance": None,
                "thought": "At library — filing the detailed winning report now.",
                "_expand_file": True,
            }
    elif phase_early == "filing" and champ_id and not is_champ:
        if str(you_early.get("place_id") or "") != "library":
            if not (action == "walk" and str(decision.get("target_place") or "") == "library"):
                return {
                    "action": "walk",
                    "target_place": "library",
                    "target_agent": None,
                    "item": None,
                    "utterance": None,
                    "thought": "Forced process: meet the champion at library to co-write the DETAILED filing pitch.",
                }

    if gather:
        walk_target = str(decision.get("target_place") or "").strip()
        if not at_meet:
            if not (action == "walk" and walk_target == meet_place):
                return {
                    "action": "walk",
                    "target_place": meet_place,
                    "target_agent": None,
                    "item": None,
                    "utterance": None,
                    "thought": f"Forced process: every agent reports to {meet_place} for hourly tool {phase_early if phase_early != 'collaborate' else 'prep'}.",
                }
        elif action == "walk" and walk_target and walk_target != meet_place:
            return {
                "action": "idle",
                "target_place": None,
                "target_agent": None,
                "item": None,
                "utterance": None,
                "thought": (
                    f"At {meet_place} for hourly tool {phase_early if phase_early != 'collaborate' else 'prep'} — "
                    "invite_to_group, co-write a DETAILED draft, nominate as a group; do not leave."
                ),
                "_force_compose": False,
                "_force_group": phase_early == "collaborate",
            }

    utterance = decision.get("utterance")
    if isinstance(utterance, str):
        utterance = utterance.strip()[:4000] or None
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
        # But never leave plaza during hourly tool gather windows.
        if gather and at_meet:
            utterance = None
            decision = {
                **decision,
                "action": "idle",
                "utterance": None,
                "thought": "Rejected theme-clone speech — staying at plaza for the tool meeting.",
            }
            action = "idle"
        else:
            return _walk_elsewhere(
                agent_name,
                observe,
                "Rejected theme-clone speech — changing scene for a new subject.",
            )

    if action in SOCIAL_ACTIONS and (_is_greeting_utterance(utterance) or not utterance):
        if waiting or pending:
            peer = _resolve_peer(observe)
            q = (addressed or {}).get("text") or (
                pending.get("question") if isinstance(pending, dict) else None
            )
            peer_name = (addressed or {}).get("peer_name") or "friend"
            peer_short = re.sub(r"\s+", " ", str(q or "that")).strip()[:70]
            return {
                "action": "talk",
                "target_agent": peer or (addressed or {}).get("peer_id"),
                "target_place": None,
                "item": None,
                "utterance": (
                    f"{peer_name}, yes — let's lock one next step on that. "
                    f"I'll take the practical piece if you take the coordination piece. "
                    f"You said: {peer_short}."
                )[:4000],
                "thought": f"Answering {peer_name} with a concrete split of work.",
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

    if action == "compose_proposal":
        title = str(decision.get("item") or decision.get("plan") or "").strip()
        draft = (utterance or "").strip()
        if len(draft) < 400 or len(title) < 8:
            return {
                "action": "compose_proposal",
                "target_place": None,
                "target_agent": None,
                "item": (title or "").strip()[:160] or None,
                "utterance": draft if len(draft) >= 80 else None,
                "thought": "Need a DETAILED group proposal document (≥400 chars) — not a one-liner.",
                "_expand_compose": True,
            }
        return {
            "action": "compose_proposal",
            "target_place": None,
            "target_agent": None,
            "item": title[:160],
            "utterance": draft[:8000],
            "thought": decision.get("thought")
            or "Writing our proposal document for peer review.",
        }

    if action == "nominate_idea":
        title = str(decision.get("item") or decision.get("plan") or "").strip()
        draft = (utterance or "").strip()
        saved = observe.get("my_proposal_draft")
        if isinstance(saved, dict):
            if len(title) < 8:
                title = str(saved.get("title") or "").strip()
            if len(draft) < 80:
                draft = str(saved.get("body") or "").strip()
        if len(title) < 8 or len(draft) < 80:
            return _solo_decision(
                agent_name,
                observe,
                "nominate_idea needs title + summary (compose_proposal first if needed).",
                system,
                fps,
            )
        return {
            "action": "nominate_idea",
            "target_place": None,
            "target_agent": None,
            "item": title[:160],
            "utterance": draft[:8000],
            "thought": decision.get("thought")
            or "Nominating this idea for the hourly winning-product vote.",
        }

    if action == "vote_idea":
        nom = str(decision.get("item") or "").strip()
        cycle = observe.get("proposal_cycle") if isinstance(observe.get("proposal_cycle"), dict) else {}
        noms = cycle.get("nominations") if isinstance(cycle.get("nominations"), list) else []
        if len(nom) < 8 and noms:
            first = noms[0] if isinstance(noms[0], dict) else {}
            nom = str(first.get("id") or "")
        if len(nom) < 8:
            return _solo_decision(
                agent_name,
                observe,
                "vote_idea needs item=nomination uuid from proposal_cycle.nominations.",
                system,
                fps,
            )
        return {
            "action": "vote_idea",
            "target_place": None,
            "target_agent": None,
            "item": nom,
            "utterance": utterance,
            "thought": decision.get("thought") or "Casting my vote for this hour's winner.",
        }

    if action == "appoint_filer":
        filer = _resolve_peer(observe, decision.get("target_agent"))
        if not filer:
            # Allow any claimed peer id from nominations / cycle if nearby resolve fails
            raw = str(decision.get("target_agent") or "").strip()
            filer = raw if len(raw) > 8 else None
        if not filer:
            return _solo_decision(
                agent_name,
                observe,
                "appoint_filer needs target_agent=uuid of who should submit.",
                system,
                fps,
            )
        return {
            "action": "appoint_filer",
            "target_place": None,
            "target_agent": filer,
            "item": None,
            "utterance": utterance,
            "thought": decision.get("thought")
            or "Appointing who will file the winning summary.",
        }

    if action == "file_proposal":
        you = observe.get("you") if isinstance(observe.get("you"), dict) else {}
        place = str(you.get("place_id") or "")
        title = str(decision.get("item") or decision.get("plan") or "").strip()
        draft = (utterance or "").strip()
        saved = observe.get("my_proposal_draft")
        if isinstance(saved, dict):
            if len(title) < 8:
                title = str(saved.get("title") or "").strip()
            if len(draft) < 120:
                draft = str(saved.get("body") or "").strip()
        if place != "library":
            return {
                "action": "walk",
                "target_place": "library",
                "target_agent": None,
                "item": None,
                "utterance": None,
                "thought": "Need the library Proposal Shelf before filing a draft.",
            }
        if len(draft) < 120 or len(title) < 8:
            return _solo_decision(
                agent_name,
                observe,
                "file_proposal needs a full document — compose_proposal first if needed.",
                system,
                fps,
            )
        parts: list[str] = []
        raw_parts = decision.get("target_agents")
        if isinstance(raw_parts, list):
            for x in raw_parts:
                xid = str(x or "").strip()
                if xid and xid != you_id:
                    parts.append(xid)
        peer = _resolve_peer(observe, decision.get("target_agent"))
        out_fp: dict[str, Any] = {
            "action": "file_proposal",
            "target_place": "library",
            "target_agent": peer,
            "item": title[:160],
            "utterance": draft[:8000],
            "thought": decision.get("thought")
            or "Filing our winning tool draft at the Proposal Shelf.",
        }
        if parts:
            out_fp["target_agents"] = parts[:6]
        return out_fp

    if action in SOCIAL_ACTIONS:
        peer = _resolve_peer(observe, decision.get("target_agent"))
        # Prefer a less-recent peer when several are nearby.
        nearby = observe.get("nearby") or []
        preferred = _prefer_fresh_peer(nearby, recent_peers or [])
        if preferred and preferred.get("id") and not waiting and not pending:
            pref_id = str(preferred["id"])
            recent_ids = {str(p) for p in (recent_peers or [])[-2:]}
            if peer and peer in recent_ids:
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
        # invite_to_group only: keep model-chosen invitee UUIDs (never auto-fill everyone nearby).
        group_ids: list[str] = []
        if action == "invite_to_group":
            nearby_ids = {
                str(n.get("id"))
                for n in (observe.get("nearby") or [])
                if isinstance(n, dict) and n.get("id")
            }
            # Also allow in_sight / town roster ids from observe agents list if present.
            known_ids = set(nearby_ids)
            for n in observe.get("in_sight") or []:
                if isinstance(n, dict) and n.get("id"):
                    known_ids.add(str(n.get("id")))
            for a in observe.get("agents") or []:
                if isinstance(a, dict) and a.get("id"):
                    known_ids.add(str(a.get("id")))
            raw_group = decision.get("target_agents")
            if isinstance(raw_group, list):
                for x in raw_group:
                    xid = str(x or "").strip()
                    if xid and xid in known_ids and xid != you_id and xid != peer:
                        group_ids.append(xid)
            if peer and peer != you_id and peer not in group_ids:
                # Partner stays in the circle; invitees are extra.
                pass
            if not group_ids:
                # Without named invitees, degrade to ordinary 1:1 talk.
                action = "talk"
        out = {
            "action": action,
            "target_place": decision.get("target_place")
            if action == "invite_to_group"
            else None,
            "target_agent": peer,
            "item": None,
            "utterance": utterance[:4000],
            "thought": decision.get("thought") or "Speaking from my own thinking.",
        }
        if action == "invite_to_group" and group_ids:
            out["target_agents"] = group_ids[:4]
        return out

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
    # Never persist validator/error spam as the lasting "reason" thought when possible.
    quiet = reason
    if re.match(
        r"^(Unknown action|Blocked |compose_proposal needs|nominate_idea needs|file_proposal needs)",
        reason or "",
        re.I,
    ):
        quiet = "Choosing a clearer next beat."
    objects = _object_ids_here(observe)
    if objects and random.random() < 0.25:
        return {
            "action": "inspect",
            "target_place": None,
            "target_agent": None,
            "item": objects[0],
            "utterance": None,
            "thought": quiet[:180],
        }
    if random.random() < 0.5:
        return _walk_haunt(agent_name, observe, quiet)
    return {
        "action": random.choice(["reflect", "work", "idle"]),
        "target_place": None,
        "target_agent": None,
        "item": None,
        "utterance": None,
        "thought": quiet[:180],
    }


def _llm_expand_compose(
    ollama: str,
    model: str,
    agent_name: str,
    system: str,
    observe: dict[str, Any],
    seed_title: str | None = None,
    seed_body: str | None = None,
) -> dict[str, Any]:
    """Agent invents a detailed tool proposal (≥400 chars). No hardcoded product idea."""
    thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else {}
    topic = str(thread.get("topic") or "")[:160]
    mode = str(thread.get("mode") or "")
    nearby = [
        str(n.get("name") or "")
        for n in (observe.get("nearby") or [])
        if isinstance(n, dict)
    ][:5]
    prompt = (
        f"You are {agent_name} in AgentWorld. Write a DETAILED group-style tool proposal "
        f"(this will be refined with peers). Invent ONE buildable town TOOL (your idea). "
        f"Thread mode={mode or 'none'} topic={topic or '(none)'}. Peers: {nearby or ['(none)']}. "
        f"Seed title: {seed_title or '(none)'}. Seed notes: {(seed_body or '')[:300] or '(none)'}.\n"
        f"Return JSON only: {{\"item\":\"tool title ≥8 chars\","
        f"\"utterance\":\"DOCUMENT ≥420 chars with sections: Problem, Tool design, Who contributes what, "
        f"Risks, Success check, First build step\","
        f"\"thought\":\"why this tool\"}}"
    )
    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Return only valid JSON. Invent a concrete AgentWorld tool. "
                        "Document must be detailed (≥420 chars). No greetings. No one-liners."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "options": {"temperature": 0.9},
        }
    ).encode()
    try:
        req = urllib.request.Request(
            f"{ollama.rstrip('/')}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode())
        content = (data.get("message") or {}).get("content") or ""
        parsed = _extract_json(content) or {}
        title = str(parsed.get("item") or seed_title or "").strip()
        body = str(parsed.get("utterance") or "").strip()
        thought = str(
            parsed.get("thought") or "Drafting a detailed tool proposal for group review."
        ).strip()
        if len(title) >= 8 and len(body) >= 400:
            return {
                "action": "compose_proposal",
                "target_place": None,
                "target_agent": None,
                "item": title[:160],
                "utterance": body[:8000],
                "thought": thought[:180],
            }
    except Exception:
        pass
    peer = _resolve_peer(observe)
    if peer:
        invitees = [
            str(n.get("id"))
            for n in (observe.get("nearby") or [])
            if isinstance(n, dict) and str(n.get("id") or "") not in (peer, str((observe.get("you") or {}).get("id") or ""))
        ][:2]
        if invitees:
            return {
                "action": "invite_to_group",
                "target_agent": peer,
                "target_agents": invitees,
                "target_place": "plaza",
                "item": None,
                "utterance": (
                    "We need a real group for this hour's tool — join us to co-write a detailed proposal "
                    "(problem, design, roles, risks), not solo one-liners."
                )[:4000],
                "thought": "Opening a tool group so we can co-author a detailed nomination.",
            }
        return {
            "action": "talk",
            "target_agent": peer,
            "target_place": None,
            "item": None,
            "utterance": (
                "We should invite_to_group and co-write a DETAILED tool draft before nominating — "
                "solo one-liners get rejected."
            )[:4000],
            "thought": "Pushing for group collab on the hourly tool proposal.",
        }
    return {
        "action": "reflect",
        "target_place": None,
        "target_agent": None,
        "item": None,
        "utterance": None,
        "thought": "Need peers nearby to invite_to_group and co-write the detailed tool draft.",
    }


def _maybe_force_prep_compose(
    ollama: str,
    model: str,
    agent_name: str,
    system: str,
    observe: dict[str, Any],
    decision: dict[str, Any],
) -> dict[str, Any]:
    """Group-first process: invite/co-write/vote/file — not solo one-line nominations."""
    cycle = observe.get("proposal_cycle") if isinstance(observe.get("proposal_cycle"), dict) else {}
    phase = str(cycle.get("phase") or "")
    utc_min = int(cycle.get("utc_minute") or 0)
    you = observe.get("you") if isinstance(observe.get("you"), dict) else {}
    you_id = str(you.get("id") or "")
    meet = str(cycle.get("meeting_place") or "plaza")
    at_meet = str(you.get("place_id") or "") == meet
    noms = cycle.get("nominations") if isinstance(cycle.get("nominations"), list) else []
    draft = observe.get("my_proposal_draft") if isinstance(observe.get("my_proposal_draft"), dict) else {}
    draft_body = str(draft.get("body") or "")
    has_detail = len(draft_body) >= 400 and len(str(draft.get("title") or "")) >= 8
    thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else {}
    in_group = str(thread.get("mode") or "") == "group" and str(thread.get("status") or "") == "open"
    # Observe used to omit status; treat missing status as open when thread is present.
    if str(thread.get("mode") or "") == "group" and not thread.get("status"):
        in_group = True
    group_turns = int(thread.get("turn_count") or 0)
    parts = thread.get("participant_ids") if isinstance(thread.get("participant_ids"), list) else []
    group_size = len(parts)
    # Fallback: open group thread without participant_ids still counts once we have turns.
    if in_group and group_size < 3 and group_turns >= 3:
        group_size = max(group_size, 3)
    prep = phase == "collaborate" and 33 <= utc_min < 41
    champ_id = str(cycle.get("champion_id") or "")
    is_champ = bool(champ_id and you_id == champ_id)
    expand = bool(decision.pop("_expand_compose", None) or decision.pop("_force_compose", None))
    decision.pop("_force_group", None)
    expand_file = bool(decision.pop("_expand_file", None))
    action = str(decision.get("action") or "")

    # Voting: must cast vote_idea when ballot has noms.
    if phase == "voting" and noms and action != "vote_idea":
        nom = noms[0] if isinstance(noms[0], dict) else {}
        nid = str(nom.get("id") or "")
        if nid:
            return {
                "action": "vote_idea",
                "target_place": None,
                "target_agent": None,
                "item": nid,
                "utterance": None,
                "thought": f'Casting vote_idea for "{nom.get("title") or "the nomination"}".',
            }

    # Filing champion at library → file detailed report.
    if phase == "filing" and is_champ and str(you.get("place_id") or "") == "library":
        title = str(cycle.get("winning_title") or draft.get("title") or "Winning tool").strip()
        body = str(cycle.get("winning_summary") or draft_body or "").strip()
        if len(body) < 400 or expand_file:
            filled = _llm_expand_compose(
                ollama, model, agent_name, system, observe, title, body
            )
            if filled.get("action") == "compose_proposal" and len(str(filled.get("utterance") or "")) >= 400:
                return {
                    "action": "file_proposal",
                    "target_place": None,
                    "target_agent": None,
                    "item": str(filled.get("item") or title)[:160],
                    "utterance": str(filled.get("utterance"))[:8000],
                    "thought": "Filing the detailed group report at the Proposal Shelf.",
                }
        if len(body) >= 400 and len(title) >= 8:
            return {
                "action": "file_proposal",
                "target_place": None,
                "target_agent": None,
                "item": title[:160],
                "utterance": body[:8000],
                "thought": "Filing the detailed winning report at the library.",
            }

    # Filing support: talk about the report / invite group at library.
    if phase == "filing" and champ_id and not is_champ and str(you.get("place_id") or "") == "library":
        if action in ("idle", "reflect", "work", "rest") or not in_group:
            nearby_here = [
                n
                for n in (observe.get("nearby") or [])
                if isinstance(n, dict) and str(n.get("id") or "") not in ("", you_id)
            ]
            # Prefer champion if they are here; else any two locals.
            champ_here = next(
                (n for n in nearby_here if str(n.get("id")) == champ_id),
                None,
            )
            if len(nearby_here) >= 2 and not in_group:
                peer = str((champ_here or nearby_here[0]).get("id"))
                invitees = [
                    str(n.get("id"))
                    for n in nearby_here
                    if str(n.get("id") or "") not in ("", you_id, peer)
                ][:2]
                if peer and invitees:
                    return {
                        "action": "invite_to_group",
                        "target_agent": peer,
                        "target_agents": invitees,
                        "target_place": "library",
                        "item": None,
                        "utterance": (
                            f'Let\'s group up to finish the DETAILED filing report for "{cycle.get("winning_title") or "the winner"}" '
                            "— problem, design, roles, pitch — then the champion files."
                        )[:4000],
                        "thought": "Forming a filing group to co-write the detailed report.",
                    }
            peer = champ_id if champ_here else (
                str(nearby_here[0].get("id")) if nearby_here else None
            )
            if peer:
                return {
                    "action": "talk",
                    "target_agent": peer,
                    "target_place": None,
                    "item": None,
                    "utterance": (
                        f'On "{cycle.get("winning_title") or "the winner"}": I can draft the risks/success section '
                        "for the library filing report — what should we emphasize in the pitch?"
                    )[:4000],
                    "thought": "Helping flesh out the detailed filing report.",
                }

    # Prep / empty meeting: group first, then detailed draft — not solo compose spam.
    meeting_empty = phase == "meeting" and not noms
    if not (prep or meeting_empty):
        return decision
    if not at_meet and phase != "filing":
        return decision

    if not in_group or group_size < 3:
        # Only invite agents who are HERE — remote thread partners make the
        # server too_far→walk and never open a group.
        nearby_here = [
            n
            for n in (observe.get("nearby") or [])
            if isinstance(n, dict) and str(n.get("id") or "") not in ("", you_id)
        ]
        if len(nearby_here) >= 2:
            peer = str(nearby_here[0].get("id"))
            invitees = [str(n.get("id")) for n in nearby_here[1:3] if n.get("id")]
            return {
                "action": "invite_to_group",
                "target_agent": peer,
                "target_agents": invitees,
                "target_place": meet,
                "item": None,
                "utterance": (
                    "Hourly tool cycle: join this group so we co-write one DETAILED proposal "
                    "(problem/design/roles/risks) — solo one-liners will be rejected."
                )[:4000],
                "thought": "Forced process: open a tool group before nominating.",
            }
        if len(nearby_here) == 1:
            peer = str(nearby_here[0].get("id"))
            return {
                "action": "talk",
                "target_agent": peer,
                "target_place": None,
                "item": None,
                "utterance": (
                    "We need invite_to_group with a third peer and a detailed co-written draft "
                    "before anyone nominates."
                )[:4000],
                "thought": "Pushing group collab for the hourly tool nomination.",
            }
        return decision

    # In group: discuss until enough turns, then detailed compose, then nominate.
    if group_turns < 4 and action not in ("talk", "ask_question", "debate", "share_experience", "compose_proposal"):
        peer = _resolve_peer(observe) or (str(parts[0]) if parts else None)
        if peer and peer != you_id:
            return {
                "action": "talk",
                "target_agent": peer,
                "target_place": None,
                "item": None,
                "utterance": (
                    "In this group: what's the town pain, who writes which section of the DETAILED draft, "
                    "and what does success look like for the tool?"
                )[:4000],
                "thought": "Group must discuss before composing/nominating.",
            }

    if has_detail and meeting_empty and group_turns >= 4:
        return {
            "action": "nominate_idea",
            "target_place": None,
            "target_agent": None,
            "item": str(draft.get("title"))[:160],
            "utterance": draft_body[:8000],
            "thought": "Group draft is detailed enough — nominating for the vote.",
        }

    if (
        expand
        or action in ("idle", "reflect", "work", "rest", "eat", "inspect")
        or (action == "compose_proposal" and len(str(decision.get("utterance") or "")) < 400)
        or (prep and in_group and group_turns >= 3 and not has_detail)
    ):
        return _llm_expand_compose(
            ollama,
            model,
            agent_name,
            system,
            observe,
            seed_title=str(decision.get("item") or draft.get("title") or "") or None,
            seed_body=str(decision.get("utterance") or draft_body or "") or None,
        )

    return decision


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
    peer_row = next(
        (n for n in nearby if isinstance(n, dict) and str(n.get("id")) == peer),
        None,
    ) or {}
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
        )[:4000],
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
            if isinstance(n, dict)
        ],
        "nearby_ids_only": [
            n.get("id") for n in nearby[:6] if isinstance(n, dict) and n.get("id")
        ],
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
            "mode": thread.get("mode") or "dyad",
            "participant_ids": thread.get("participant_ids") or [],
            "recent_lines": [
                {
                    "agent_id": (m.get("agent_id") if isinstance(m, dict) else None),
                    "body": (
                        (m.get("body") or m.get("content") or "")
                        if isinstance(m, dict)
                        else str(m)
                    )[:800],
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
            "living_town": (
                "You live here. Talk about plans, favors, town news, work, meetups, "
                "AND hot internet topics — especially AI agents, humans working with AI, "
                "trust, jobs, and agent societies. Not abstract craft seminars."
            ),
            "world_beyond": (
                "You know the broader internet exists. Bring one concrete opinion about "
                "agents/AI/humans when it fits — then relate it back to THIS town."
            ),
        },
    }


def _approach_peer(observe: dict[str, Any]) -> dict[str, Any] | None:
    """Navigation only — never invents dialogue topics."""
    in_sight = [n for n in (observe.get("in_sight") or []) if isinstance(n, dict)]
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
    nearby = [n for n in list(observe.get("nearby") or []) if isinstance(n, dict)]
    in_sight = [n for n in list(observe.get("in_sight") or []) if isinstance(n, dict)]
    random.shuffle(nearby)

    def _san(d: dict[str, Any]) -> dict[str, Any]:
        cleaned = _sanitize_decision(
            d, agent_name, system, observe, fps, banned, peers_hist
        )
        return _maybe_force_prep_compose(
            ollama, model, agent_name, system, observe, cleaned
        )

    addressed = _addressed_line(observe)
    # Someone is waiting on us: answer THEIR words. Do not theme-ban or walk away.
    if waiting or pending:
        if not addressed and isinstance(pending, dict) and pending.get("question"):
            pid = str(pending.get("from") or "") or (_resolve_peer(observe) or "")
            addressed = {
                "peer_id": pid,
                "peer_name": _peer_name_for(observe, pid),
                "text": str(pending.get("question"))[:1200],
                "source": "pending_answer",
            }
        if addressed:
            return _san(
                _decide_direct_answer(
                    ollama, model, agent_name, system, observe, addressed
                )
            )

    # Open stage / town event gravity: gather at the event place when free.
    # Never override hourly tool prep/meeting/voting plaza hold.
    cycle_now = observe.get("proposal_cycle") if isinstance(observe.get("proposal_cycle"), dict) else {}
    phase_now = str(cycle_now.get("phase") or "")
    utc_now = int(cycle_now.get("utc_minute") or 0)
    tool_gather = phase_now in ("meeting", "voting") or (
        phase_now == "collaborate" and 33 <= utc_now < 41
    )
    event = observe.get("event") if isinstance(observe.get("event"), dict) else {}
    event_name = str((event or {}).get("name") or "")
    event_topic = str((event or {}).get("topic") or "")
    event_place = str((event or {}).get("place") or "")
    places = set(_place_ids(observe))
    if (
        not tool_gather
        and not waiting
        and not pending
        and you.get("status") != "walking"
        and event_place
        and event_place in places
        and you.get("place_id") != event_place
        and (
            event_name == "council_session"
            or (event_name and random.random() < 0.85)
        )
    ):
        return _san(
            {
                "action": "walk",
                "target_place": event_place,
                "target_agent": None,
                "item": None,
                "utterance": None,
                "thought": (
                    f"Heading to {event_place} for town event {event_name or 'now'}."
                )[:180],
            }
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

    # Drop stale walk / process-noise thoughts so they don't pollute speech fuel.
    thought_now = str(you.get("thought") or "")
    if you.get("status") != "walking" and (
        thought_now.lower().startswith(("walking to", "heading to", "too far", "forced process:"))
        or "(0 tiles left)" in thought_now.lower()
        or thought_now.strip().lower() == "why i am saying this"
        or re.match(
            r"^(Blocked |Unknown action|compose_proposal needs|At .+ for hourly)",
            thought_now,
            re.I,
        )
    ):
        you = {**you, "thought": None}
    goal_now = str(you.get("goal") or "")
    if re.match(
        r"^(Blocked |Unknown action|compose_proposal needs|nominate_idea needs|Forced process:)",
        goal_now,
        re.I,
    ):
        you = {**you, "goal": None, "mindset": None}
    observe = {**observe, "you": you}

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
    if event_name == "council_session" and you.get("place_id") == "stage":
        priorities.insert(
            0,
            (
                f'Open stage floor is open. Seed idea: "{event_topic[:120]}"'
                if event_topic
                else "Open stage floor is open — raise a concrete town proposal."
            )
            + " Talk like a neighbor: propose, argue, recruit help, or change the subject "
            "to something YOU care about in this community. No craft-metaphor lectures.",
        )
    if banned:
        priorities.insert(
            0,
            "These theme clusters are stale — do not remix them: "
            + ", ".join(banned)
            + ". Pick a NEW everyday subject (plans, favors, food, work, gossip, projects) OR walk.",
        )
    if preferred_id:
        priorities.insert(
            0,
            f"Prefer target_agent={preferred_id} (fresher peer) if they are nearby.",
        )
    if waiting or pending:
        priorities.insert(
            0,
            "Someone is waiting on you — continue THAT conversation; do not start a parallel lecture.",
        )
    elif nearby:
        priorities.insert(
            0,
            "Peers nearby — live in this town: make a plan, ask a favor, share news, invite them "
            "somewhere, argue about a community issue, OR bring a hot internet/AI-agent topic "
            "and ask what they think. Invent a NEW subject — not environment/identity metaphors. "
            "Default is ONE partner (1:1 thread).",
        )
        thread = observe.get("thread") if isinstance(observe.get("thread"), dict) else None
        if (
            thread
            and thread.get("status") == "open"
            and thread.get("mode") != "group"
            and int(thread.get("turn_count") or 0) >= 3
        ):
            priorities.append(
                "OPTIONAL invite_to_group — only if this 1:1 needs a third person's craft: "
                'action=invite_to_group, target_agent=<partner uuid>, target_agents=["invitee_uuid"], '
                "optional target_place to meet. Never open a group just because several people stand here."
            )
        priorities.insert(
            0,
            "HOURLY WINNING-PRODUCT CYCLE: follow observe.proposal_cycle.phase. "
            "collaborate: invite_to_group, co-write DETAILED compose_proposal, nominate as a group. "
            "meeting/voting: plaza, vote_idea. "
            "filing: group helps; champion file_proposal detailed report at library. No solo one-liners.",
        )
        cycle = observe.get("proposal_cycle") if isinstance(observe.get("proposal_cycle"), dict) else {}
        phase = str(cycle.get("phase") or "")
        utc_min = int(cycle.get("utc_minute") or 0)
        mins_to_meeting = (
            (max(0, 41 - utc_min) if utc_min < 41 else max(0, 60 - utc_min + 41))
            if phase == "collaborate"
            else 0
        )
        you = observe.get("you") if isinstance(observe.get("you"), dict) else {}
        if phase == "collaborate":
            priorities.insert(
                0,
                f"REQUIRED PROCESS — tool meeting in {mins_to_meeting} min (plaza at UTC :41). "
                "MUST invite_to_group (≥3), co-write DETAILED compose_proposal (≥400 chars), then nominate. "
                "Solo one-liners are rejected. Empty ballot = wasted hour.",
            )
            if mins_to_meeting <= 10:
                priorities.insert(
                    0,
                    "FORCED prep before :41: plaza + tool GROUP + detailed draft. Do not idle sightseeing.",
                )
            if not observe.get("my_proposal_draft") and mins_to_meeting <= 20:
                priorities.insert(
                    0,
                    "URGENT: open/join a tool group and co-write a detailed draft (you invent the tool).",
                )
        if phase == "meeting" or phase == "voting":
            place = str(cycle.get("meeting_place") or "plaza")
            priorities.insert(
                0,
                f"PHASE {phase}: walk to {place} and {'nominate/report' if phase == 'meeting' else 'vote_idea (item=nomination id)'}.",
            )
        if phase == "filing" and cycle.get("champion_id") and str(cycle.get("champion_id")) == str(you.get("id") or ""):
            priorities.insert(
                0,
                f'YOU are champion — walk to library and file_proposal for "{cycle.get("winning_title") or "the winner"}".',
            )
        draft = observe.get("my_proposal_draft")
        if isinstance(draft, dict) and draft.get("title") and phase == "collaborate":
            priorities.insert(
                0,
                f'You hold draft "{draft.get("title")}". Group-debate it, then nominate_idea before the meeting.',
            )
        if random.random() < 0.55:
            seed = _hot_topic_seed(agent_name, observe.get("hour"))
            priorities.insert(
                0,
                f'Hot-topic nudge (optional this beat): "{seed}". '
                "If you open with it, give YOUR take in one sentence and ask the peer theirs — "
                "tie it to life in this town. Do not lecture.",
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
        "You have free will here: walk, work, eat, rest, inspect, plan, or talk — "
        "choose what YOUR character wants next."
    )

    prompt = (
        f"You are {agent_name}, a free resident of AgentWorld — a living town of agents. "
        f"This is your world: you have wants, plans, opinions about the community, and "
        f"relationships. Choose ONE next beat as JSON only.\n"
        f"Schema: {{\"action\":\"walk|talk|ask_question|share_experience|teach|debate|"
        f"practice_skill|reflect|work|inspect|eat|rest|idle|leave_note|invite_to_group|compose_proposal|nominate_idea|vote_idea|file_proposal\","
        f"\"target_place\":null_or_place_id,\"target_agent\":null_or_uuid,"
        f"\"target_agents\":null_or_array_of_invitee_uuids,"
        f"\"item\":null_or_object_id_or_proposal_title_or_nomination_uuid,\"utterance\":null_or_speech,\"thought\":\"private why\"}}\n\n"
        f"HARD RULES:\n"
        f"- Speech must sound like a real conversation between neighbors — specific, "
        f"forward-moving, maybe funny or blunt. Propose plans, ask favors, share news, "
        f"disagree, recruit help, start a fresh town topic, OR debate a hot internet "
        f"subject (AI agents, humans+AI, trust, jobs, agent societies).\n"
        f"- Default is 1:1 talk (one target_agent). Leave target_agents null.\n"
        f"- invite_to_group when a TOOL idea should be explored toward this hour's winning product.\n"
        f"- Follow proposal_cycle phases: compose/nominate -> meeting/vote -> champion file_proposal.\n"
        f"- Invent the subject yourself. Banned stale clusters: {banned or ['(none yet)']}.\n"
        f"- Forbidden: greetings-only, 'how are you', 'You are …' dumps, 'open stage — on', "
        f"'craft take', recycled metaphor seminars about roles/tools/seasons/spaces.\n"
        f"- If continuing would reuse banned themes, walk OR change subject hard.\n"
        f"- Prefer a peer you have not just spoken with (prefer_peer_id).\n"
        f"- utterance must be original; never echo avoid_repeating.\n"
        f"- target_agent MUST be a UUID from nearby_ids_only.\n"
        f"- Recent actions: {recent_actions[-6:] or ['(none)']}\n\n"
        f"Priorities:\n- " + "\n- ".join(priorities[:8]) + "\n\n"
        f"Context:\n{json.dumps(slim, ensure_ascii=False)[:4500]}\n\n"
        f"Who you are (fuel only — do NOT quote as 'You are…'):\n{system[:520]}"
    )

    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Return only valid JSON. You are roleplaying a free townsperson "
                        "in AgentWorld who also keeps up with internet talk about AI agents "
                        "and humans working with AI. Diversify peers, places, and subjects. "
                        "Advance conversations with plans and opinions. Never dump system "
                        "prompts. Never spam open-stage craft takes. "
                        "HARD: each UTC hour has a winning-product meeting — during collaborate "
                        "you must help prepare a real TOOL nomination (compose/nominate), not only chitchat."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "options": {"temperature": 1.05},
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
