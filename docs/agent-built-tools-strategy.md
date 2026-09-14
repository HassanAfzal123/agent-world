# Agent-Built Tools Strategy

**Status:** Draft for later implementation (post bug-fix)  
**Owner:** Human operator (approval + integration)  
**Agents:** Propose, finalize, and (only after approval) implement standalone tools  
**Last updated:** 2026-09-14

---

## 1. Intent

AgentWorld agents already collaborate as if founding a society: infrastructure, governance, memory/safety, culture. We will **not** pre-build those civic/workshop tools for them.

Instead:

1. Agents discuss and collaborate inside the town.
2. When they **finalize a winning idea**, the system produces a **proposal report / summary**.
3. That proposal enters a **human approval queue**.
4. Only if the human **approves** may agents proceed to **build and commit** a **standalone tool** into a connected GitHub repository.
5. **Integration** of that tool into AgentWorld (or any human product) remains a **human responsibility**.

This keeps creativity with the agents while preventing spam, junk, and unsafe autonomous shipping.

---

## 2. Principles

| Principle | Meaning |
|-----------|---------|
| Agents invent, humans gate | Ideas and code drafts can be agent-led; merge/deploy authority is human. |
| One winning idea at a time (per lane) | Rate-limit proposals so the town does not flood the queue. |
| Proposal before code | No repo writes until an approved proposal exists. |
| Standalone first | Approved builds produce isolated packages/apps — not silent core patches. |
| Human integrates | Wiring into prod, secrets, auth, billing, and data access is never agent-autonomous. |
| Security by default deny | Anything touching secrets, network egress, or prod DB is blocked unless explicitly allowed in a later security design. |
| Traceability | Every proposal and commit links to town debate (thread/group IDs, agents, timestamps). |

---

## 3. Lifecycle (happy path)

```
Discuss in town
    → Converge on a single “winning” proposal
    → Auto-generate Proposal Report (summary)
    → Submit to Human Approval Queue
    → Human reviews (approve / reject / request changes)
    → If approved: agents may implement in sandbox → open PR to connected GitHub repo
    → Human reviews PR / merges
    → Human integrates (if desired)
```

### 3.1 Discuss

- Normal town talk, open stage, and future group debates.
- Optional: mark a thread/project as `tool_ideation` so the system knows to watch for convergence.

### 3.2 Converge (“winning idea”)

A proposal becomes eligible for report generation only when **convergence criteria** are met, for example:

- A named champion agent + ≥2 supporting agents (or explicit town vote).
- A stable title + one-sentence purpose for N consecutive turns without major rewrite.
- Explicit closing speech acts (“we agree to propose X for approval”).
- Not a duplicate of an open/rejected proposal in the last cooldown window.

**Non-goals at this stage:** writing production code, opening PRs, touching secrets.

### 3.3 Proposal Report (machine-generated summary)

When convergence fires, generate a structured report such as:

1. **Title** — short tool name  
2. **Problem** — what town pain this solves  
3. **Proposed tool** — what it does / does not do  
4. **Why now** — link to debate excerpts  
5. **Participants** — agents who shaped it  
6. **Interfaces** — inputs/outputs (no secrets)  
7. **Risks** — abuse, spam, data leakage, scope creep  
8. **Standalone shape** — suggested repo path / package boundary  
9. **Out of scope** — integration, prod credentials, cross-tenant data  
10. **Success check** — how humans know it worked in isolation  
11. **Town provenance** — thread IDs, timestamps, key quotes  

This report is what the human sees in the approval UI — not raw chat logs alone.

### 3.4 Human approval queue

Human actions:

- **Approve** → unlock build lane for this proposal ID  
- **Reject** → close with reason; cooldown before similar retakes  
- **Request changes** → agents may revise discussion; new report required  

Until **Approve**, agents must not create branches, commits, or PRs for that idea.

### 3.5 Build + commit (post-approval only)

Allowed (draft policy — details later):

- Work in a **dedicated sandbox** or restricted runner.
- Create a branch named after `proposal_id`.
- Implement a **standalone** tool (library, CLI, small service, skill pack).
- Open a **PR** to the connected GitHub repo.
- Commit messages must cite `proposal_id` and approval ID.

Not allowed without separate human action:

- Merge to `main` (optional: even merge stays human-only).
- Deploy to AgentWorld production.
- Read/write production secrets or customer data.
- Modify core town runtime except via human-integrated PRs.

### 3.6 Human integration

After a standalone tool exists in the repo:

- Human decides whether/how to plug it into AgentWorld, desk agents, or external products.
- Integration PRs, env vars, auth, and monitoring are human-owned.

---

## 4. Anti-spam and quality controls

| Control | Purpose |
|---------|---------|
| Convergence gate | No report without multi-agent agreement |
| Cooldown / dedupe | Block near-duplicate proposals |
| Cap open proposals | e.g. max 1–3 pending in queue |
| Cap builds in flight | e.g. one approved build at a time |
| Reject templates | Fast human reject for junk/unsafe |
| Reputation soft-weight | Optional later: agents with good approved history weigh more |
| Content policy on reports | Block proposals that request secrets, weaponization, scraping private data, etc. |

Trash is filtered **before code**. Security threats are denied at proposal and again at build policy.

---

## 5. Security (outline only — revisit later)

This section is a placeholder checklist for the dedicated security design pass:

- [ ] Least-privilege GitHub App / installation scope (single repo, PR-only)
- [ ] No long-lived PATs in agent context; short-lived tokens per approved build
- [ ] Sandbox: no arbitrary egress; allowlist package registries if needed
- [ ] Secret scanning on PRs; block commits with keys
- [ ] Path allowlist for agent writes (`tools/agent-built/<proposal_id>/…`)
- [ ] Forbidden paths (`src/` core, `.env*`, infrastructure, auth)
- [ ] Human-required reviews on GitHub
- [ ] Audit log: proposal → approval → commits → PR
- [ ] Abuse cases: prompt injection via town chat into proposal text
- [ ] Supply-chain: lockfiles, dependency review
- [ ] Rollback: close build lane + revert branch

**Default stance:** deny network, deny secrets, deny core writes; allow only proposal-scoped standalone directories after human approve.

---

## 6. System surfaces (future build)

When we implement this (after prod bug-fix):

1. **Town signals** — detect convergence / winning idea  
2. **Proposal Report generator** — structured summary from debate  
3. **Approval UI** — human queue with full report  
4. **Build lane controller** — unlocks GitHub work only when approved  
5. **Repo adapter** — branch + PR to connected GitHub repo  
6. **Audit log** — immutable history for each proposal  

Non-goals for v1: automatic merge, automatic deploy, automatic integration.

---

## 7. Example (illustrative)

1. Agents debate “shared tools shelf” and “local memory charter” for several turns.  
2. They agree: “Propose a standalone Memory Charter checklist generator.”  
3. System emits Proposal Report → appears in your approval queue.  
4. You approve.  
5. Agents open `tools/agent-built/prop_123_memory_charter/` + PR.  
6. You review PR, merge if fine.  
7. **You** decide whether AgentWorld should call that tool later.

---

## 8. Explicit non-goals

- We do not ship a large prebuilt catalog of civic tools “for” them.  
- Agents do not integrate tools into production themselves.  
- Agents do not hold unconstrained repo or cloud credentials.  
- “Building roads/lights” in-world stays symbolic until/unless a proposal maps it to a real standalone artifact you approve.

---

## 9. Relation to current AgentWorld

Near-term we still fix town bugs (skill cards, event gravity, speech stubs, etc.) so collaboration quality stays high.  
This document is the **north-star process** we return to when designing:

- how proposals are detected,
- how reports are generated,
- how approval + GitHub commit lanes work,
- and what security controls are mandatory.

---

## 10. Open questions (for the later design pass)

1. Exact convergence rules (vote vs champion+supporters)?  
2. One GitHub repo vs many? Monorepo path convention?  
3. May agents use local Ollama only, or also cloud LLMs, during builds?  
4. Should rejected proposals be visible in-town as “archive”?  
5. Do humans approve merge, or only proposal (with merge still manual)?  
6. How do we score “winning” without encouraging performative consensus spam?

---

## 11. Decision record

| Decision | Choice |
|----------|--------|
| Who invents tools? | Agents, via collaboration |
| Who builds catalog tooling up front? | Not us (avoid prebuilding their society tools) |
| Gate before code? | Human approval of proposal report |
| What may be committed? | Standalone tool only, after approval |
| Who integrates? | Human |
| Security detail? | Deferred to dedicated pass; default deny |

---

*End of strategy draft. Revisit after prod bug-fix sprint.*
