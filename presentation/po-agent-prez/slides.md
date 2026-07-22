---
theme: default
title: PO Assistant — AI issue pre-qualification for Plane
info: |
  An AI Product Owner assistant that triages GitHub issues and publishes
  structured, prioritized work items into Plane.
class: text-center
transition: slide-left
mdc: true
---

# PO Assistant

### An AI agent that pre-qualifies issues for the Product Owner

From a raw GitHub issue → a triaged, RICE-scored, strategy-aligned
work item in **Plane**, with a ready-to-use user story.

<div class="pt-8 opacity-70 text-sm">
<!-- TODO: author name · role applied for · date -->
Technical test — AI assistant for a Product Owner
</div>

<!--
15-min slot. This deck is the 3-4 min "architecture & choices" backbone;
the live demo carries the rest.
-->

---
layout: section
---

# 1 · The problem

Where a Product Owner bleeds time — and how not to make it worse

---

# The PO is drowning in inbound

<div grid="~ cols-2 gap-8" class="pt-4">

<div>

Every new issue, email, or feedback ticket forces the PO to, by hand:

- **Read & classify** — bug? feature? question? noise?
- **Check for duplicates** across the whole backlog
- **Guess a priority** — often gut-feel, rarely comparable
- **Re-write** a vague request into an actionable story
- **Re-decide** priorities every single day

</div>

<div class="opacity-90">

The cost isn't any single issue — it's the **repetition**.

The same 15-minute ritual, dozens of times a week, on input of
wildly uneven quality.

That triage time is time *not* spent on strategy, discovery,
and talking to users.

</div>

</div>

<!--
Straight from the case brief: PO overwhelmed with feedback, feature
requests, and constant re-prioritization.
-->

---

# Gain time — without losing it elsewhere

<div grid="~ cols-2 gap-6" class="pt-2">

<div>

### ✅ Automate the repetitive first pass

- Classify + label on arrival
- Detect likely duplicates
- Draft a **first-pass** RICE score
- Scaffold the user story & acceptance criteria
- Land it in the backlog, ready to review

<div class="text-sm opacity-70 pt-2">
The agent does the boring 80%. The PO edits, not authors.
</div>

</div>

<div>

### ⛔ What *not* to do <span class="text-xs opacity-60">(assumption)</span>

- **Don't let the agent decide** — it *proposes*, the PO disposes
- **No black-box scores** — every number is justified & inspectable
- **Don't auto-close / auto-reject** issues
- **Don't over-automate** low-confidence cases into false certainty
- **Don't add a new tool to babysit** — meet the PO where work already lands

</div>

</div>

<!--
The design north star: assist, don't replace. A wrong autonomous decision
costs more PO time than no decision at all — trust is the scarce resource.
-->

---
layout: section
---

# 2 · Product context

Why the output lands in **Plane**

---

# What is Plane?

<div grid="~ cols-2 gap-8" class="pt-4">

<div>

**Plane** is an open-source project & product management platform —
an alternative to Jira / Linear.

Its core objects are exactly what a PO works in:

- **Work items** (issues / stories / epics)
- **States**, **labels**, **priorities**
- **Intake** — a triage inbox for incoming items
- **Cycles**, modules, initiatives

</div>

<div>

### Why it fits this test

- A **real PM data model** to write into — not a toy sink <span class="text-xs opacity-60">(assumption)</span>
- A first-class **MCP server** → the agent creates work items with tools, not brittle REST glue
- An **intake state** purpose-built to receive machine-triaged items for human review
- **Open source** → the whole workflow lives *in the repo* I forked, and the team can dogfood it

</div>

</div>

<!--
Plane isn't incidental: its MCP server + intake state are the two features
that make "agent → reviewable backlog item" clean instead of hacky.
-->

---
layout: section
---

# 3 · Solution architecture

One issue in → a reviewable work item out

---

# The pipeline

```mermaid {theme: 'neutral', scale: 0.72}
flowchart TB
  A([Issue opened]) --> B[GitHub Action → issue-agent.ts<br/>Claude Agent SDK · preflight: Plane MCP up?]
  B --> T[1 · Triage — classify + label]
  T --> AN[2 · Analysis — pain points · dedup]
  AN --> R[3 · RICE — score → priority]
  R --> AL[4 · Alignment — OKR fit → modulate]
  AL --> S[5 · User story — criteria · complexity]
  S --> O1[[Post to GitHub — label + comment]]
  S --> O2[[Publish to Plane — work item + story]]
  T -. bug / question .-> R
  S -. bug / question .-> O1

  classDef step fill:#eef2ff,stroke:#6366f1,color:#1e1b4b;
  classDef out fill:#ecfdf5,stroke:#10b981,color:#064e3b;
  class T,AN,R,AL,S step;
  class O1,O2 out;
```

<div class="text-sm opacity-80 pt-1">

Each numbered step is an **isolated agent run** loaded with **one skill + a minimal tool allow-list**.
Bugs & questions **skip** Analysis and Story (dotted paths). Steps hand off via `/tmp/<step>.json`.

</div>

<!--
Walk it: trigger → orchestrator → fail-fast preflight → 6 skill-scoped steps
→ two sinks. The conditional skips keep cheap issues cheap.
-->

---

# Each step, and its skill

<div class="text-sm">

| # | Step | Skill | Always? | Produces |
|---|------|-------|---------|----------|
| 1 | **Triage** | — | ✅ | type + confidence, applies GitHub label |
| 2 | **Analysis** | `user-feedback-synthesizer` | feature/feedback | pain points, themes, duplicates |
| 3 | **RICE** | `feature-prioritization-assistant` | ✅ | Reach×Impact×Conf/Effort → priority |
| 4 | **Alignment** | `plane-product-strategy` | ✅ | OKR fit 0–3 → modulates priority |
| 5 | **User story** | `prd-writer` | feature/feedback | story + acceptance criteria + complexity |
| 6 | **Publish** | Plane MCP | ✅ | work item, labels, link, analysis comment |

</div>

<div class="pt-3 opacity-90">

The agent covers all three brief pillars — **feedback analysis**, **prioritization** (RICE + strategy),
and **assisted writing** — as separate, composable steps.

</div>

<!--
Map back to the brief's three feature categories explicitly.
-->

---

# Design choices that matter

<div grid="~ cols-2 gap-6" class="pt-2 text-sm">

<div>

**One skill per step, minimal tools**
Focused context, cheaper runs, no cross-talk — a step can't misuse a tool it was never given.

**File-based hand-off**
Isolated runs communicate through `/tmp/*.json` — each step is independently testable and replayable.

**Determinism guard**
The priority tier bump is **recomputed in TypeScript** (`adjustPriority`), never trusted from the LLM — the rule can't drift.

</div>

<div>

**Idempotent publish**
Dedup guard on `external_source / external_id` → re-running the workflow never creates duplicate work items.

**Fail-fast preflight**
Verifies the Plane MCP connects *before* spending 6 steps — no silent "success" with no output.

**Dogfooding**
Items are published into Plane's **own** Plane project — the team manages Plane with the agent.

</div>

</div>

<!--
These are the "engineering judgment" points — LLM where it adds value,
plain code where correctness must be guaranteed.
-->

---
layout: section
---

# 4 · Areas for improvement

Conscious scope for a demo — and where it goes next

---

# What I deliberately left out

<div grid="~ cols-2 gap-6" class="pt-2 text-sm">

<div>

### Cut for the demo <span class="text-xs opacity-60">(assumption)</span>

- **Hardcoded** Plane project & intake-state IDs → would come from config / workspace lookup
- **Illustrative OKRs** in the alignment prompt → should be sourced from real product strategy
- **GitHub issues only** — no email / support-ticket / call-notes ingestion yet
- **One issue at a time** (`issues: opened`) — no backlog re-scoring or batch runs

</div>

<div>

### Natural next steps

- **Human-in-the-loop gate** — a review/approve step before priority is committed
- **Feedback loop** — learn from PO edits to calibrate RICE & alignment
- **Comparative prioritization** — score the *whole* backlog together, not per-issue in isolation
- **Eval harness** — regression tests on a labeled issue set (beyond `test-local.ts`)
- **Cost/latency budget** per issue

</div>

</div>

<!--
Frame these as choices, not gaps: each has a clear upgrade path. Shows I
know where the edges are.
-->

---
layout: center
class: text-center
---

# Recap

**GitHub issue → agent pipeline → reviewable Plane work item**

Assist, don't replace · every number justified · human keeps the call

<div class="pt-8 text-sm opacity-70">
<!-- TODO: repo link · Plane workspace link · demo issue link -->
Code: <code>agent-scripts/issue-agent.ts</code> · Workflow: <code>.github/workflows/issue-agent.yml</code>
</div>
