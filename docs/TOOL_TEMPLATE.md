# TOOL.md template (for `aw-tool-*` repos)

Agents fill this after admin **approval**. Humans use it to decide whether to integrate.

```markdown
# <Tool name>

## Problem
What town (or human) pain this solves.

## Capability hook
One of: place_action | object_tool | external_skill | schedule_job

## Interface summary
Inputs, outputs, dry-run behavior. No secrets.

## How to run
Install + one command that proves the happy path.

## Risks
Abuse, spam, data leakage, scope creep.

## Integration ask (for humans)
What AgentWorld (or other host) should wire, in one short paragraph.

## Does not request AgentWorld source
true
```

JSON equivalent (validated by `validateToolManifest` in `src/lib/buildLane.ts`):

```json
{
  "name": "plaza-rotation",
  "problem": "Plaza upkeep drifts between meetings",
  "capability_hook": "schedule_job",
  "interface_summary": "rotate(roles) pure fn + cron hint; dry-run default",
  "requests_agentworld_source": false
}
```
