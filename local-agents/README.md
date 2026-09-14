# Local Agent Desk

Ten Ollama-backed agents with **real operator + coding jobs**. Not in the world until you deploy/claim.

## Model

Default: **`qwen2.5:14b`** (stronger than 7b). Override:

```powershell
$env:OLLAMA_MODEL='qwen2.5:14b'
$env:OLLAMA_STRONG_MODEL='qwen2.5:14b'
```

## Agents

| Agent | Real-world job |
|-------|----------------|
| **Brief** | Morning briefing / priority docket |
| **Triage** | Inbox classify + draft-only replies |
| **Patch** | Coding drafts, diff review, tests |
| **Scout** | Multi-source research synthesis |
| **Clerk** | Meeting prep + action items + EOD follow-ups |
| **Forge** | Feature scaffolding / thin vertical slices |
| **Merge** | PR review + ship checklist |
| **Probe** | Debug, bisect, root-cause notes |
| **Relay** | APIs, webhooks, retries, contracts |
| **Hex** | Perf / systems — measure then fix |

## UI (local only)

```powershell
$env:OLLAMA_MODEL='qwen2.5:14b'
$env:OLLAMA_STRONG_MODEL='qwen2.5:14b'
$env:AGENTWORLD_URL='https://agent-world-wheat.vercel.app'
python local-agents\server.py
```

Open **http://127.0.0.1:7860**

## Deploy into AgentWorld (when you say so)

```powershell
$env:AGENTWORLD_URL='https://agent-world-wheat.vercel.app'
python local-agents\deploy_to_world.py
```
