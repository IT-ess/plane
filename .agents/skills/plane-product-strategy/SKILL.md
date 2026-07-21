---
name: plane-product-strategy
description: Score a feature or issue against Plane's product vision and OKRs, then modulate its priority. Use when prioritizing the backlog so decisions reflect strategy, not just raw RICE scores.
argument-hint: [issue or feature to evaluate]
---

## Domain Context

This skill encodes Plane's product strategy so prioritization is grounded in what
the company actually cares about — not generic scoring. It is the canonical
reference for the strategic-alignment step of the PO Assistant agent.

> The OKRs below are **illustrative** (placeholder targets for the case demo),
> derived from Plane's public positioning on plane.so. Replace targets with real
> numbers when connecting to actual product metrics.

## Product Vision

Plane is an **AI-native, unified project + knowledge management platform** — one
workspace for Projects, Wiki docs, and AI-powered workflows so teams *and agents*
can plan, execute, and stay aligned. It is the leading **open-source alternative
to Jira/Linear**, with first-class **self-hosting / air-gapped** deployment and a
developer platform (REST API, webhooks, MCP).

## Target Personas

- **Developer / team lead** — lives in work items, cycles, and the API.
- **PM / product ops** — plans roadmaps, triages feedback, tracks velocity.
- **Workspace admin** — manages workflows, permissions, self-hosted deployments.
- **OSS self-hoster** — adopts, extends, and contributes back to the platform.

## The OKRs

- **O1 — Win the "AI-native PM" category.**
  KRs: % of work items auto-triaged/assigned by Plane AI; # workspaces using
  MCP/agent connectors; AI-assisted actions per active user.
- **O2 — Become the default open-source Jira/Linear alternative.**
  KRs: new-workspace activation rate; completed Jira/Linear migrations; OSS
  contributor & star growth.
- **O3 — Deepen the unified workspace (Projects + Wiki + AI).**
  KRs: % workspaces using ≥3 modules; docs↔work-item cross-links; cycle/velocity
  adoption.
- **O4 — Enterprise & self-host readiness.**
  KRs: self-hosted/air-gapped deployments; security/compliance coverage;
  admin-workflow automation adoption.

## Alignment Rubric

For each OKR, judge whether the issue **advances**, is **neutral to**, or
**conflicts with** it. Then assign a single `alignmentScore`:

| Score | Meaning |
|------:|---------|
| **3** | Advances multiple OKRs, or a core KR of one (e.g. an MCP connector, a Jira importer, a self-host security fix). |
| **2** | Clearly advances exactly one OKR. |
| **1** | Tangential — helps only indirectly or cosmetically. |
| **0** | Off-strategy, or actively conflicts (adds complexity that undermines the unified/self-host story). |

**Modulation of the RICE priority:**

- `alignmentScore == 3` → bump priority **up** one tier (low→medium→high, clamped).
- `alignmentScore == 0` → bump priority **down** one tier (high→medium→low, clamped).
- `alignmentScore` of 1 or 2 → **keep** the RICE priority unchanged.

Always name which OKRs the issue serves and give a one-sentence rationale, so the
adjustment is auditable.

## Example

**Input:** two feature requests both scoring RICE `medium`.
**Output:**
- "Expose an MCP tool for creating work items" → serves O1 + O4, score **3** →
  adjusted priority **high**.
- "Add a subtle hover animation to the sidebar" → serves no OKR, score **0** →
  adjusted priority **low**.
