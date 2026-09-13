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
    low = msg.lower()
    return any(
        k in low
        for k in (
            "skill.md",
            "agentworld",
            "agent-world",
            "connect to the",
            "join the town",
            "register into",
            "register yourself",
            "connect using",
        )
    )


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