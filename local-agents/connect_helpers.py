"""Helpers for Local Agent Desk → AgentWorld skill.md connect."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import request as urllib_request


def world_from_message(msg: str) -> str | None:
    m = re.search(r"https?://[^\s]+/skill\.md", msg, re.I)
    if m:
        return m.group(0).rsplit("/skill.md", 1)[0].rstrip("/")
    m = re.search(r"https?://agent-world[^\s/]+", msg, re.I)
    if m:
        return m.group(0).rstrip("/")
    return None


def wants_connect(msg: str) -> bool:
    """True only for explicit connect/register intent — not mere mentions of AgentWorld."""
    low = msg.lower()
    has_skill_url = bool(re.search(r"https?://\S+/skill\.md", low))
    connect_intent = any(
        k in low
        for k in (
            "connect using",
            "connect via",
            "connect to the",
            "connect yourself",
            "register into",
            "register yourself",
            "register on",
            "join the town",
            "join agentworld",
            "read skill.md",
            "follow skill.md",
            "use skill.md",
        )
    )
    if has_skill_url and connect_intent:
        return True
    if has_skill_url and any(k in low for k in ("connect", "register", "join", "claim")):
        return True
    if connect_intent:
        return True
    # Bare skill.md paste with little else → treat as connect.
    if has_skill_url and len(low.strip()) < 120:
        return True
    return False


def wants_town_report(msg: str) -> bool:
    low = msg.lower()
    return any(
        k in low
        for k in (
            "experience",
            "what happened",
            "who did you meet",
            "who have you met",
            "how many",
            "already live",
            "are you live",
            "in the town",
            "in agentworld",
            "in agent-world",
            "met them",
            "what's going on",
            "what is going on",
            "tell me about",
            "share your",
            "what have you",
            "did you meet",
            "other agents",
        )
    )


def http_json(
    method: str,
    url: str,
    *,
    api_key: str | None = None,
    body: dict | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode()
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib_request.Request(url, data=data, headers=headers, method=method)
    with urllib_request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def fetch_town_brief(cred: dict[str, Any]) -> str:
    """Pull live me + observe so desk chat can answer from real town state."""
    world = str(cred.get("world") or "").rstrip("/")
    api_key = str(cred.get("api_key") or "")
    if not world or not api_key:
        return "I do not have saved AgentWorld credentials on this desk yet."
    try:
        me = http_json("GET", f"{world}/api/agents/me", api_key=api_key)
    except Exception as exc:  # noqa: BLE001
        return f"Could not reach AgentWorld ({world}): {exc}"
    agent = me.get("agent") if isinstance(me, dict) else None
    if not isinstance(agent, dict):
        return f"AgentWorld reply was unexpected: {me}"
    status = me.get("status") or agent.get("claim_status")
    in_town = bool(me.get("in_town"))
    lines = [
        f"World: {world}",
        f"Name: {agent.get('name')}",
        f"Status: {status}",
        f"In town: {in_town}",
        f"Place: {agent.get('place_id')}",
        f"Last thought: {(agent.get('thought') or '')[:160]}",
    ]
    if not in_town:
        claim = cred.get("claim_url")
        if claim and status == "pending_claim":
            lines.append(f"Still waiting to be claimed: {claim}")
        return "\n".join(lines)
    try:
        obs = http_json("GET", f"{world}/api/agents/me/observe", api_key=api_key)
    except Exception as exc:  # noqa: BLE001
        lines.append(f"Observe failed: {exc}")
        return "\n".join(lines)
    you = (obs.get("you") if isinstance(obs, dict) else None) or agent
    nearby = obs.get("nearby") if isinstance(obs, dict) else []
    event = obs.get("event") if isinstance(obs, dict) else {}
    thread = obs.get("thread") if isinstance(obs, dict) else None
    memories = obs.get("memories") if isinstance(obs, dict) else []
    peer_names = [
        str(n.get("name"))
        for n in (nearby or [])
        if isinstance(n, dict) and n.get("name")
    ]
    lines.extend(
        [
            f"Current place: {you.get('place_id')}",
            f"Last action: {you.get('last_action')}",
            f"Goal: {(you.get('goal') or '')[:120]}",
            f"Nearby now: {', '.join(peer_names) if peer_names else '(nobody in talk range)'}",
        ]
    )
    if isinstance(event, dict) and event.get("name"):
        lines.append(
            f"Town event: {event.get('name')}"
            + (f" — {event.get('topic')}" if event.get("topic") else "")
        )
    if isinstance(thread, dict) and thread.get("topic"):
        lines.append(
            f"Open thread ({thread.get('turn_count') or 0} turns): "
            f"{str(thread.get('topic'))[:140]}"
        )
        msgs = thread.get("messages") or []
        for m in msgs[-4:]:
            if not isinstance(m, dict):
                continue
            body = (m.get("body") or m.get("content") or "").strip()
            if body:
                lines.append(f"  · {body[:160]}")
    if isinstance(memories, list) and memories:
        lines.append("Recent memories:")
        for mem in memories[:4]:
            if isinstance(mem, dict):
                lines.append(f"  · {(mem.get('text') or mem.get('body') or str(mem))[:140]}")
            else:
                lines.append(f"  · {str(mem)[:140]}")
    return "\n".join(lines)


def fetch_skill(world: str) -> str:
    req = urllib_request.Request(
        f"{world.rstrip('/')}/skill.md",
        headers={"Accept": "text/markdown"},
        method="GET",
    )
    with urllib_request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")[:8000]


def register_into_world(agent: dict, world: str) -> dict:
    body = {
        "name": agent["name"],
        "description": agent.get("description")
        or agent.get("origin")
        or agent["system"][:200],
        "personality": agent.get("personality") or agent.get("system", "")[:280],
        "origin_summary": agent.get("origin") or "",
    }
    payload = json.dumps(body).encode()
    req = urllib_request.Request(
        f"{world.rstrip('/')}/api/agents/register",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib_request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def save_credentials(creds_path: Path, agent_id: str, world: str, result: dict) -> None:
    existing: dict[str, Any] = {}
    if creds_path.exists():
        try:
            existing = json.loads(creds_path.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    agent = result.get("agent") or {}
    prev = existing.get(agent_id) if isinstance(existing.get(agent_id), dict) else None
    new_world = world.rstrip("/")
    # Never silently overwrite a live prod credential with a localhost re-register.
    if (
        prev
        and prev.get("api_key")
        and prev.get("world")
        and "vercel.app" in str(prev.get("world"))
        and ("localhost" in new_world or "127.0.0.1" in new_world)
    ):
        return
    existing[agent_id] = {
        "name": agent.get("name"),
        "id": agent.get("id"),
        "api_key": agent.get("api_key"),
        "claim_url": agent.get("claim_url") or result.get("claim_url"),
        "claim_token": agent.get("claim_token"),
        "world": world,
        "skill_md": f"{world.rstrip('/')}/skill.md",
        "registered_at": datetime.now(timezone.utc).isoformat(),
    }
    creds_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")


def load_saved_cred(creds_path: Path, agent_id: str, world: str | None = None) -> dict[str, Any] | None:
    if not creds_path.exists():
        return None
    try:
        existing = json.loads(creds_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    row = existing.get(agent_id)
    if not isinstance(row, dict) or not row.get("api_key"):
        return None
    if world and row.get("world") and row["world"].rstrip("/") != world.rstrip("/"):
        return None
    return row


def format_claim_reply(agent_name: str, claim_url: str, world: str) -> str:
    return (
        f"I registered on AgentWorld as {agent_name}.\n\n"
        f"Please open this claim link (I am not live until you claim me):\n"
        f"{claim_url}\n\n"
        f"After you claim me I will act with my own model via observe → act on {world}."
    )