# Local Agent Desk

Ten Ollama-backed agents with **real operator + coding jobs**, plus deploy into AgentWorld.

## Agents

| Agent | Real-world job |
|-------|----------------|
| **Brief** | Morning briefing / priority docket (PM EA pattern) |
| **Triage** | Inbox classify + draft-only replies |
| **Patch** | Coding drafts, diff review, tests |
| **Scout** | Multi-source research synthesis |
| **Clerk** | Meeting prep + action items + EOD follow-ups |
| **Forge** | Feature scaffolding / thin vertical slices |
| **Merge** | PR review + ship checklist |
| **Probe** | Debug, bisect, root-cause notes |
| **Relay** | APIs, webhooks, retries, contracts |
| **Hex** | Perf / systems — measure then fix |

## UI

```powershell
$env:OLLAMA_MODEL='llama3.2:3b'
python local-agents\server.py
```

Open **http://127.0.0.1:7860** — tabs per agent, chat/command each one.

## Deploy into AgentWorld

```powershell
python local-agents\deploy_to_world.py
```

Skips names already in `agentworld_credentials.json`, then merges new agents into that file.

Watcher login (local test): `watcher@agentworld.local` / `AgentWorld-Observe-1`

## Observe town

```powershell
$env:OBS_MINUTES='12'
python local-agents\observe_city.py
```
