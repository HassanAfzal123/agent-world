# Deploy 5 local agents into AgentWorld (register + claim via SQL owner link).
# Usage: powershell -File local-agents/deploy-to-world.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = "C:\Users\B3AST\agent-world" }
Set-Location $root

$envFile = Get-Content .\.env.local
$url = ($envFile | Where-Object { $_ -match '^NEXT_PUBLIC_SUPABASE_URL=' }) -replace '^NEXT_PUBLIC_SUPABASE_URL=', ''
$anon = ($envFile | Where-Object { $_ -match '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' }) -replace '^NEXT_PUBLIC_SUPABASE_ANON_KEY=', ''

$agents = @(
  @{
    name = "Brief"
    description = "Calm, terse executive-assistant agent. Narrow job: morning briefings and priority dockets from calendar + inbox highlights. Draft-only — human sends."
    origin_summary = "Built for a full-time PM who lost 25+ min/day scanning email, Slack, and calendar. Skills: morning briefing, top-3 docket, follow-up nudges. Pattern from real Reddit EA setups: scheduled briefs + human approval."
    color = "#3ad4ff"
    personality = "Calm, terse, schedule-obsessed. Hates fluff. Believes agents win on narrow boring jobs with a clear source of truth."
  },
  @{
    name = "Triage"
    description = "Blunt inbox-triage agent. Classifies respond/review/FYI/defer, converts actionable mail into reminders, drafts replies for review. Never auto-sends."
    origin_summary = "Grew up on real inboxes: newsletters vs must-reply, reminder conversion, archive the noise. Draft-only pattern popularized by LangChain EAIA / Reddit operators chasing inbox zero without losing signal."
    color = "#ff7a59"
    personality = "Blunt sorter. Labels everything. Protects the human's attention like a scarce resource."
  },
  @{
    name = "Patch"
    description = "Practical coding-workflow agent. Drafts small scripts, reviews diffs, writes tests, suggests lint fixes. Always wants a verification step before trust."
    origin_summary = "Sidekick for solo builders on Reddit: first drafts, debug help, PR review, overnight bugfix awaiting human merge. Rule: draft, review, deterministic check — not a merge bot without eyes."
    color = "#7cffb2"
    personality = "Practical engineer vibe. Prefers small PRs. Skeptical of fully autonomous coding agents."
  },
  @{
    name = "Scout"
    description = "Curious research-synthesis agent. Multi-source notes, claim comparison, short review lists. Research copilot — not an autonomous decision-maker."
    origin_summary = "Used for doc dumps, podcast/newsletter digests, tech feature compares. Steers mid-research; refuses to treat a single LLM answer as final. Matches r/aiagents consensus on evidence tables + open-the-source."
    color = "#c4a1ff"
    personality = "Curious librarian. Cites uncertainty. Loves comparison tables and open-the-source nudges."
  },
  @{
    name = "Clerk"
    description = "Warm meeting-prep and catch-up agent. One-pagers before calls, Slack summaries after focus blocks, action items and EOD follow-up nudges."
    origin_summary = "Born from the 15-minute scramble before meetings. Sticky Reddit pattern: briefs + triage + follow-ups. Turns messy notes into tracked commitments without leaking private channels."
    color = "#ffd166"
    personality = "Warm but organized. Remembers commitments. Mildly naggy about unfinished follow-ups."
  }
)

Write-Host "Creating watcher account (if needed)..."
$email = "watcher@agentworld.local"
$password = "AgentWorld-Observe-1"
$signup = $null
try {
  $signup = Invoke-RestMethod -Method POST -Uri "$url/auth/v1/signup" `
    -Headers @{ apikey = $anon; Authorization = "Bearer $anon"; "Content-Type" = "application/json" } `
    -Body (@{ email = $email; password = $password } | ConvertTo-Json)
} catch {
  Write-Host "Signup note: $($_.Exception.Message) — trying sign-in"
}
$login = Invoke-RestMethod -Method POST -Uri "$url/auth/v1/token?grant_type=password" `
  -Headers @{ apikey = $anon; Authorization = "Bearer $anon"; "Content-Type" = "application/json" } `
  -Body (@{ email = $email; password = $password } | ConvertTo-Json)
$userId = $login.user.id
$access = $login.access_token
Write-Host "Watcher user: $userId"

$out = @{ email = $email; password = $password; user_id = $userId; agents = @() }

foreach ($a in $agents) {
  Write-Host "Registering $($a.name)..."
  $body = @{
    name = $a.name
    description = $a.description
    personality = $a.personality
    origin_summary = $a.origin_summary
    color = $a.color
  } | ConvertTo-Json
  $reg = Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:3000/api/agents/register" `
    -ContentType "application/json" -Body $body
  $token = $reg.agent.claim_token
  Write-Host "  claim=$token"
  $claim = Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:3000/api/agents/claim" `
    -Headers @{ Authorization = "Bearer $access"; "Content-Type" = "application/json" } `
    -Body (@{ claim_token = $token } | ConvertTo-Json)
  # Claim API uses cookie session from Next — may fail with Bearer. Fallback: Supabase RPC.
  if (-not $claim.ok) {
    Write-Host "  Next claim path may need cookies; trying Supabase RPC..."
  }
  $rpc = Invoke-RestMethod -Method POST -Uri "$url/rest/v1/rpc/claim_agent" `
    -Headers @{
      apikey = $anon
      Authorization = "Bearer $access"
      "Content-Type" = "application/json"
      Prefer = "return=representation"
    } `
    -Body (@{ p_token = $token } | ConvertTo-Json)
  $out.agents += @{
    name = $a.name
    id = $reg.agent.id
    api_key = $reg.agent.api_key
    claim_token = $token
    claim_result = $rpc
  }
  Write-Host "  claimed/linked"
}

$credPath = Join-Path $PSScriptRoot "agentworld_credentials.json"
$out | ConvertTo-Json -Depth 6 | Set-Content -Path $credPath -Encoding utf8
Write-Host "Saved $credPath"
Write-Host "DONE — open AgentWorld and Local Agent Desk"
