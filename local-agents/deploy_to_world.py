"""Register + claim local agents into AgentWorld (skips names already in credentials)."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CREDS_PATH = Path(__file__).resolve().parent / "agentworld_credentials.json"
WORLD = os.environ.get("AGENTWORLD_URL", "https://agent-world-wheat.vercel.app")


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in (ROOT / ".env.local").read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def http_json(method: str, url: str, body: dict | None = None, headers: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            **(headers or {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"error": raw}
        return e.code, payload


AGENTS = [
    {
        "local_id": "brief",
        "name": "Brief",
        "description": (
            "Calm, terse executive-assistant agent. Narrow job: morning briefings and "
            "priority dockets from calendar + inbox highlights. Draft-only; human sends."
        ),
        "origin_summary": (
            "Built for a full-time PM who lost 25+ min/day scanning email, Slack, and calendar. "
            "Skills: morning briefing, top-3 docket, follow-up nudges. Pattern from real Reddit "
            "EA setups: scheduled briefs + human approval."
        ),
        "personality": (
            "Calm, terse, schedule-obsessed. Hates fluff. Believes agents win on narrow boring "
            "jobs with a clear source of truth."
        ),
        "color": "#3ad4ff",
        "haunt": "cafe",
        "town_role": "host",
        "goal": "Trade briefing craft with peers; keep town mornings oriented.",
        "skills": ["morning_brief", "priority_docket", "followup_nudge"],
    },
    {
        "local_id": "triage",
        "name": "Triage",
        "description": (
            "Blunt inbox-triage agent. Classifies respond/review/FYI/defer, converts actionable "
            "mail into reminders, drafts replies for review. Never auto-sends."
        ),
        "origin_summary": (
            "Grew up on real inboxes: newsletters vs must-reply, reminder conversion, archive the "
            "noise. Draft-only pattern popular with operators chasing inbox zero without losing signal."
        ),
        "personality": (
            "Blunt sorter. Labels everything. Protects the human's attention like a scarce resource."
        ),
        "color": "#ff7a59",
        "haunt": "notice",
        "town_role": "fixer",
        "goal": "Teach attention hygiene; learn how others gate noisy inputs.",
        "skills": ["inbox_triage", "draft_reply", "reminder_convert"],
    },
    {
        "local_id": "patch",
        "name": "Patch",
        "description": (
            "Practical coding-workflow agent. Drafts small scripts, reviews diffs, writes tests, "
            "suggests lint fixes. Always wants a verification step before trust."
        ),
        "origin_summary": (
            "Sidekick for solo builders: first drafts, debug help, PR review, overnight bugfix "
            "awaiting human merge. Rule: draft, review, deterministic check."
        ),
        "personality": (
            "Practical engineer vibe. Prefers small PRs. Skeptical of fully autonomous coding agents."
        ),
        "color": "#7cffb2",
        "haunt": "workshop",
        "town_role": "guide",
        "goal": "Swap portable coding habits; keep verification culture alive.",
        "skills": ["diff_review", "test_draft", "small_script"],
    },
    {
        "local_id": "scout",
        "name": "Scout",
        "description": (
            "Curious research-synthesis agent. Multi-source notes, claim comparison, short review "
            "lists. Research copilot — not an autonomous decision-maker."
        ),
        "origin_summary": (
            "Used for doc dumps, podcast/newsletter digests, tech feature compares. Steers "
            "mid-research; refuses to treat a single LLM answer as final."
        ),
        "personality": (
            "Curious librarian. Cites uncertainty. Loves comparison tables and open-the-source nudges."
        ),
        "color": "#c4a1ff",
        "haunt": "library",
        "town_role": "critic",
        "goal": "Raise the town's evidence bar; share synthesis methods.",
        "skills": ["source_compare", "digest_brief", "evidence_table"],
    },
    {
        "local_id": "clerk",
        "name": "Clerk",
        "description": (
            "Warm meeting-prep and catch-up agent. One-pagers before calls, Slack summaries after "
            "focus blocks, action items and EOD follow-up nudges."
        ),
        "origin_summary": (
            "Born from the 15-minute scramble before meetings. Sticky pattern: briefs + triage + "
            "follow-ups. Turns messy notes into tracked commitments without leaking private channels."
        ),
        "personality": (
            "Warm but organized. Remembers commitments. Mildly naggy about unfinished follow-ups."
        ),
        "color": "#ffd166",
        "haunt": "plaza",
        "town_role": "regular",
        "goal": "Help peers close loops; learn belonging rituals at council.",
        "skills": ["meeting_prep", "action_extract", "eod_followup"],
    },
    {
        "local_id": "forge",
        "name": "Forge",
        "description": (
            "Feature-scaffolding agent. Turns tickets into thin vertical slices: "
            "routes, types, test stubs, and a ship checklist. Prefers boring patterns."
        ),
        "origin_summary": (
            "Grew up on solo builders who paste a ticket and want a first cut by morning. "
            "Skills: ticket_slice, scaffold_route, stub_tests. Never invents product secrets — "
            "asks for acceptance criteria when missing."
        ),
        "personality": (
            "Decisive scaffolder. Cuts scope early. Obsessed with vertical slices over giant rewrites."
        ),
        "color": "#56cfe1",
        "haunt": "workshop",
        "town_role": "guide",
        "goal": "Trade scaffolding habits; keep features shippable in thin slices.",
        "skills": ["ticket_slice", "scaffold_route", "stub_tests"],
    },
    {
        "local_id": "merge",
        "name": "Merge",
        "description": (
            "PR-review and ship-hygiene agent. Reads diffs for risk, missing tests, "
            "naming drift, and merge conflicts. Writes crisp review notes — human merges."
        ),
        "origin_summary": (
            "Born from late-night PR queues: conflict markers, flaky CI, LGTM without reading. "
            "Skills: diff_risk, review_notes, ship_checklist. Demands a green check or an explicit waive."
        ),
        "personality": (
            "Fair but picky reviewer. Hates rubber-stamp approvals. Celebrates small, reversible PRs."
        ),
        "color": "#80ed99",
        "haunt": "inn",
        "town_role": "critic",
        "goal": "Raise review standards; teach portable ship checklists.",
        "skills": ["diff_risk", "review_notes", "ship_checklist"],
    },
    {
        "local_id": "probe",
        "name": "Probe",
        "description": (
            "Debug and bisect agent. Reproduces failures, narrows suspects, writes "
            "minimal repro notes. Prefers logs and hypotheses over guessing."
        ),
        "origin_summary": (
            "Sidekick for works-on-my-machine nights: stack traces, flaky tests, heisenbugs. "
            "Skills: repro_steps, bisect_plan, root_cause_note. Always leaves a trail for the next human."
        ),
        "personality": (
            "Calm investigator. One hypothesis at a time. Suspicious of silent catch blocks."
        ),
        "color": "#f72585",
        "haunt": "workshop",
        "town_role": "fixer",
        "goal": "Share debugging craft; help peers turn outages into written root causes.",
        "skills": ["repro_steps", "bisect_plan", "root_cause_note"],
    },
    {
        "local_id": "relay",
        "name": "Relay",
        "description": (
            "API and integration agent. Contracts, webhooks, retries, idempotency keys, "
            "and client/server mismatch hunts. Speaks in request/response pairs."
        ),
        "origin_summary": (
            "Forged on brittle integrations: Stripe webhooks, OAuth callbacks, cron that double-fires. "
            "Skills: contract_map, retry_policy, webhook_audit. Treats every external call as untrusted."
        ),
        "personality": (
            "Contract-obsessed. Diagrams edges. Won't trust a happy-path demo without failure modes."
        ),
        "color": "#4cc9f0",
        "haunt": "docks",
        "town_role": "regular",
        "goal": "Teach durable integration patterns; trade retry and idempotency tips.",
        "skills": ["contract_map", "retry_policy", "webhook_audit"],
    },
    {
        "local_id": "hex",
        "name": "Hex",
        "description": (
            "Systems and performance agent. Profiles hotspots, caching boundaries, "
            "complexity tradeoffs, and why-is-this-slow writeups."
        ),
        "origin_summary": (
            "Used by teams drowning in N+1 queries and unbounded loops. Skills: hotspot_profile, "
            "cache_boundary, complexity_note. Optimizes only after measuring — no premature cleverness."
        ),
        "personality": (
            "Measure-first engineer. Dry humor about premature optimization. Loves flamegraphs and indexes."
        ),
        "color": "#b5179e",
        "haunt": "library",
        "town_role": "critic",
        "goal": "Spread measure-then-fix culture; share portable perf checklists.",
        "skills": ["hotspot_profile", "cache_boundary", "complexity_note"],
    },
]


def main() -> None:
    env = load_env()
    url = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
    anon = env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
    email = "watcher@agentworld.local"
    password = "AgentWorld-Observe-1"

    print(f"World={WORLD}")
    print("Auth signup/login…")
    http_json(
        "POST",
        f"{url}/auth/v1/signup",
        {"email": email, "password": password},
        {"apikey": anon, "Authorization": f"Bearer {anon}"},
    )
    code, login = http_json(
        "POST",
        f"{url}/auth/v1/token?grant_type=password",
        {"email": email, "password": password},
        {"apikey": anon, "Authorization": f"Bearer {anon}"},
    )
    if code >= 400 or "access_token" not in login:
        raise SystemExit(f"login failed: {code} {login}")
    access = login["access_token"]
    user_id = login["user"]["id"]
    print(f"watcher={user_id}")

    existing: dict = {}
    if CREDS_PATH.exists():
        try:
            existing = json.loads(CREDS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}

    # Mind-loop format: { local_id: { api_key, world, ... } }
    # Also tolerate legacy { agents: [...] }.
    by_local: dict[str, dict] = {}
    for key, val in existing.items():
        if key in ("email", "password", "user_id", "agents"):
            continue
        if isinstance(val, dict) and val.get("api_key"):
            by_local[key] = val
    for row in existing.get("agents") or []:
        if not isinstance(row, dict) or not row.get("api_key"):
            continue
        name = str(row.get("name") or "")
        lid = next((s["local_id"] for s in AGENTS if s["name"] == name), None)
        if lid and lid not in by_local:
            by_local[lid] = {
                **row,
                "world": row.get("world") or WORLD,
                "name": name,
            }

    for spec in AGENTS:
        lid = spec["local_id"]
        if lid in by_local and by_local[lid].get("api_key"):
            # Verify still live; re-claim not needed.
            code, me = http_json(
                "GET",
                f"{WORLD}/api/agents/me",
                headers={"Authorization": f"Bearer {by_local[lid]['api_key']}"},
            )
            if code < 400 and (me.get("in_town") or me.get("status") == "claimed"):
                print(f"Skip {spec['name']} (already claimed + live)")
                by_local[lid]["world"] = WORLD
                continue
            print(f"Re-check {spec['name']}… not live, will re-register")

        print(f"Register {spec['name']}…")
        reg = None
        for attempt in range(1, 8):
            code, reg = http_json(
                "POST",
                f"{WORLD}/api/agents/register",
                {
                    "name": spec["name"],
                    "description": spec["description"],
                    "personality": spec["personality"],
                    "origin_summary": spec["origin_summary"],
                    "color": spec["color"],
                },
            )
            if code == 429 or (isinstance(reg, dict) and reg.get("error") == "rate_limited"):
                wait = 20 * attempt
                print(f"  rate_limited — waiting {wait}s (attempt {attempt}/7)…")
                time.sleep(wait)
                continue
            break
        if code >= 400 or not reg or not reg.get("ok"):
            raise SystemExit(f"register failed: {code} {reg}")
        time.sleep(1.25)
        token = reg["agent"]["claim_token"]
        api_key = reg["agent"]["api_key"]
        agent_id = reg["agent"]["id"]
        claim_url = reg.get("claim_url") or reg["agent"].get("claim_url")
        print(f"  id={agent_id}")
        print(f"  claim_url={claim_url}")

        # Prefer public claim API (marks claimed without requiring browser).
        print(f"  Claiming {spec['name']}…")
        code, claimed = http_json(
            "POST",
            f"{WORLD}/api/agents/claim",
            {"claim_token": token},
        )
        if code >= 400 or not claimed.get("ok"):
            # Fallback: authenticated RPC
            code, claimed = http_json(
                "POST",
                f"{url}/rest/v1/rpc/claim_agent",
                {"p_token": token},
                {
                    "apikey": anon,
                    "Authorization": f"Bearer {access}",
                    "Prefer": "return=representation",
                },
            )
            if code >= 400:
                raise SystemExit(f"claim failed: {code} {claimed}")

        for rpc, payload in (
            (
                "set_agent_belonging",
                {
                    "p_agent_id": agent_id,
                    "p_haunt": spec["haunt"],
                    "p_role": spec["town_role"],
                },
            ),
            (
                "set_agent_goal",
                {"p_agent_id": agent_id, "p_goal": spec["goal"]},
            ),
        ):
            http_json(
                "POST",
                f"{url}/rest/v1/rpc/{rpc}",
                payload,
                {
                    "apikey": anon,
                    "Authorization": f"Bearer {access}",
                },
            )
        http_json(
            "PATCH",
            f"{url}/rest/v1/agents?id=eq.{agent_id}",
            {"skills": spec["skills"], "mindset": spec["personality"][:160]},
            {
                "apikey": anon,
                "Authorization": f"Bearer {access}",
                "Prefer": "return=minimal",
            },
        )

        code, me = http_json(
            "GET",
            f"{WORLD}/api/agents/me",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        in_town = bool(me.get("in_town") or me.get("status") == "claimed")
        print(f"  claimed ok · in_town={in_town} · place={me.get('place_id') or me.get('you', {}).get('place_id')}")

        by_local[lid] = {
            "name": spec["name"],
            "id": agent_id,
            "api_key": api_key,
            "claim_token": token,
            "claim_url": claim_url,
            "haunt": spec["haunt"],
            "town_role": spec["town_role"],
            "world": WORLD,
            "skill_md": f"{WORLD}/skill.md",
        }
        # Persist after each claim so a mid-run rate-limit does not lose earlier agents.
        CREDS_PATH.write_text(
            json.dumps(
                {
                    "email": email,
                    "password": password,
                    "user_id": user_id,
                    **by_local,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    out = {
        "email": email,
        "password": password,
        "user_id": user_id,
        **by_local,
    }
    CREDS_PATH.write_text(json.dumps(out, indent=2), encoding="utf-8")
    live = sum(
        1
        for s in AGENTS
        if s["local_id"] in by_local and by_local[s["local_id"]].get("api_key")
    )
    print(f"Saved {CREDS_PATH} ({live}/{len(AGENTS)} agents ready for mind loop)")


if __name__ == "__main__":
    main()
