import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "fs";
import { adjustPriority } from "./priority";

const ISSUE = {
  number: process.env.ISSUE_NUMBER!,
  title: process.env.ISSUE_TITLE!,
  body: process.env.ISSUE_BODY || "(no description)",
  repo: process.env.GITHUB_REPOSITORY!,
};

async function runStep(name: string, prompt: string): Promise<string> {
  console.log(`\n${"─".repeat(60)}\n[${name.toUpperCase()}]\n${"─".repeat(60)}`);
  for await (const msg of query({ prompt, options: { allowedTools: ["Bash"] } })) {
    if (msg.type === "result") {
      if ((msg as any).is_error) throw new Error(`Step "${name}" failed`);
      break;
    }
  }
  const file = `/tmp/${name}.json`;
  return existsSync(file) ? readFileSync(file, "utf-8") : "{}";
}

function parse<T = Record<string, unknown>>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return {} as T;
  }
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

function triagePrompt() {
  return `
You are a GitHub issue triage agent for Plane, a project management platform (like Jira/Linear).

## Issue to triage
Repository: ${ISSUE.repo}
Issue number: ${ISSUE.number}
Title: ${ISSUE.title}

Body:
${ISSUE.body}

## Your tasks

1. Classify this issue as exactly one of:
   - bug           (something is broken)
   - feature-request (a new capability is requested)
   - feedback      (opinion or improvement suggestion)
   - question      (asking how something works)
   - other         (doesn't fit above)

2. Apply the matching label:
   gh issue edit ${ISSUE.number} --repo ${ISSUE.repo} --add-label "<type>"

3. Write your result to /tmp/triage.json using Python:
   python3 -c "
import json
data = {
    'type': '<type>',
    'confidence': 'high|medium|low',
    'reasoning': '<one concise sentence>'
}
json.dump(data, open('/tmp/triage.json', 'w'))
"

Replace <type>, confidence, and reasoning with your actual assessment.
`.trim();
}

function analysisPrompt(triage: Record<string, unknown>) {
  return `
You are a user research expert and product analyst for Plane, a project management platform.
Apply the User Feedback Synthesizer framework to this issue.

## Context
Issue #${ISSUE.number}: "${ISSUE.title}"
Type: ${triage.type}

Body:
${ISSUE.body}

## Your tasks

1. Search for related/duplicate issues (run 2-3 targeted searches):
   gh issue list --repo ${ISSUE.repo} --state all --search "<keywords>" --json number,title --limit 5

2. Synthesize the feedback by:
   - Clustering signals into themes (what category of problem does each pain point belong to?)
   - Assessing severity per theme: critical (blocks work) / high (major friction) / medium (notable inconvenience) / low (nice-to-have)
   - Identifying quick wins (small-effort, high-visibility improvements buried in the request)
   - Extracting the core feature intent (what job-to-be-done is the user trying to accomplish?)

3. Write your analysis to /tmp/analysis.json using Python:
   python3 -c "
import json
data = {
    'painPoints': ['<specific pain point 1>', '<specific pain point 2>'],
    'featureIntent': '<the underlying job-to-be-done the user wants to accomplish>',
    'themes': [
        {'name': '<theme name>', 'severity': 'critical|high|medium|low', 'description': '<one sentence>'}
    ],
    'quickWins': ['<small improvement that could be shipped fast>'],
    'relatedIssues': [{'number': N, 'title': '...'}]
}
json.dump(data, open('/tmp/analysis.json', 'w'))
"

relatedIssues may be empty. quickWins may be empty if none found.
`.trim();
}

function ricePrompt(
  triage: Record<string, unknown>,
  analysis: Record<string, unknown>
) {
  const hasAnalysis = Object.keys(analysis).length > 0;
  return `
You are a senior product manager for Plane, a project management platform used by software teams.

## Issue
#${ISSUE.number}: "${ISSUE.title}"
Type: ${triage.type}
Reasoning: ${triage.reasoning}

${
  hasAnalysis
    ? `## Feedback analysis
Pain points: ${JSON.stringify(analysis.painPoints ?? [])}
Feature intent: ${analysis.featureIntent ?? "N/A"}
Related issues found: ${((analysis.relatedIssues as unknown[]) ?? []).length}`
    : ""
}

Body:
${ISSUE.body}

## RICE scoring task

Use the standard RICE framework with these precise scales:

**Reach** — estimated % of active Plane users affected per quarter (1–100):
- 1–10: niche use case, very specific workflow
- 11–30: subset of users (e.g., admins, API users, power users)
- 31–60: a significant portion of users
- 61–100: most or all users

**Impact** — improvement magnitude per affected user (use exact values):
- 0.25 = minimal (trivial UX polish)
- 0.5  = low (noticeable but minor improvement)
- 1    = medium (meaningful, saves time)
- 2    = high (significant, removes real pain)
- 3    = massive (transformative, unlocks key workflows)

**Confidence** — certainty in estimates (10–100%):
- High: strong user signals, data, or prior art → 80–100%
- Medium: reasonable inference, some evidence → 50–75%
- Low: assumption-heavy, unclear scope → 10–40%

**Effort** — engineering effort in person-days (include design + dev + QA):
- 1–3 d: trivial (config change, copy fix)
- 4–10 d: small (new endpoint, UI component)
- 11–20 d: medium (new feature area)
- 21–60 d: large (cross-cutting, architectural)

RICE Score = (Reach × Impact × Confidence/100) / Effort × 100  ← multiply by 100 to keep scores readable

Priority thresholds (re-calibrated for this formula):
- high   → RICE ≥ 15
- medium → RICE 5–14
- low    → RICE < 5

Be honest about Confidence — use lower values when estimates rest on assumptions.
Include design, development, and testing in Effort.

Write to /tmp/rice.json using Python:
python3 -c "
import json
reach = <1-100>        # % of users
impact = <0.25|0.5|1|2|3>
confidence = <10-100>  # percent
effort = <person-days>
rice = round((reach * impact * confidence / 100) / effort * 100, 1)
data = {
    'reach': reach,
    'impact': impact,
    'confidence': confidence,
    'effort': effort,
    'riceScore': rice,
    'priority': 'high' if rice >= 15 else ('medium' if rice >= 5 else 'low'),
    'justification': '<2-3 sentences explaining each score with specific reasoning>'
}
json.dump(data, open('/tmp/rice.json', 'w'))
"
`.trim();
}

function alignmentPrompt(
  triage: Record<string, unknown>,
  analysis: Record<string, unknown>,
  rice: Record<string, unknown>
) {
  return `
You are a senior product strategist for Plane, a project management platform.
Apply the Plane Product Strategy framework to judge this issue's strategic fit.

## Issue
#${ISSUE.number}: "${ISSUE.title}"
Type: ${triage.type}
Feature intent: ${analysis.featureIntent ?? ISSUE.title}
RICE priority (before alignment): ${rice.priority ?? "medium"}

Body:
${ISSUE.body}

## Plane's OKRs (illustrative)
- O1 — Win the "AI-native PM" category (Plane AI auto-triage/assignment, MCP/agent connectors, AI-assisted actions).
- O2 — Become the default open-source Jira/Linear alternative (activation, Jira/Linear migration, OSS/community growth).
- O3 — Deepen the unified workspace (Projects + Wiki + AI depth, cross-module usage, cycles/velocity).
- O4 — Enterprise & self-host readiness (self-hosted/air-gapped deployments, security/compliance, admin-workflow automation).

## Scoring (alignmentScore 0-3)
- 3 = advances multiple OKRs, or a core KR of one
- 2 = clearly advances exactly one OKR
- 1 = tangential / only indirect or cosmetic help
- 0 = off-strategy, or actively conflicts

## Modulation of RICE priority
- score 3 → bump priority UP one tier (low→medium→high, clamped)
- score 0 → bump priority DOWN one tier (high→medium→low, clamped)
- score 1 or 2 → keep the RICE priority unchanged

Write to /tmp/alignment.json using Python:
python3 -c "
import json
rice_priority = '${rice.priority ?? "medium"}'
score = <0|1|2|3>
tiers = ['low', 'medium', 'high']
idx = tiers.index(rice_priority) if rice_priority in tiers else 1
delta = 1 if score == 3 else (-1 if score == 0 else 0)
adjusted = tiers[max(0, min(2, idx + delta))]
data = {
    'okrsServed': [<'O1'|'O2'|'O3'|'O4', ...>],
    'alignmentScore': score,
    'adjustedPriority': adjusted,
    'rationale': '<one sentence: which OKRs and why this score>'
}
json.dump(data, open('/tmp/alignment.json', 'w'))
"

okrsServed may be empty when score is 0.
`.trim();
}

function storyPrompt(analysis: Record<string, unknown>) {
  return `
You are a senior product owner for Plane, a project management platform.
Apply the PRD Writer framework to structure this user story.

## Context
Issue #${ISSUE.number}: "${ISSUE.title}"
Feature intent: ${analysis.featureIntent ?? ISSUE.title}
Pain points: ${JSON.stringify(analysis.painPoints ?? [])}
Themes: ${JSON.stringify(analysis.themes ?? [])}

Body:
${ISSUE.body}

## Your task

Produce a structured story following PRD best practices:

**Problem statement**: Clearly describe the current situation, the user's pain, and the business impact of NOT solving it.

**User story**: "As a <persona>, I want <specific goal> so that <measurable benefit>."
- Persona must be a real Plane user type (project manager / developer / team lead / product owner / admin)
- Goal must be specific and actionable, not vague
- Benefit must be measurable or at least concrete

**Acceptance criteria** (3–5 items, Given/When/Then format):
- Cover the happy path and at least one edge case
- Each criterion must be independently testable

**Success metrics**: 1–2 quantitative or observable metrics that would prove this feature is working (e.g., "API 404 rate for archive endpoint drops to 0", "support tickets about X decrease by 50%").

**Scope**:
- In scope: what IS part of this story
- Out of scope: adjacent things that are explicitly NOT included

**Complexity**:
- S  → < 1 day
- M  → 2–5 days
- L  → 1–2 sprints
- XL → multi-sprint

Write to /tmp/story.json using Python:
python3 -c "
import json
data = {
    'problemStatement': '<current situation + user pain + business impact>',
    'userStory': 'As a <persona>, I want <goal> so that <benefit>.',
    'acceptanceCriteria': [
        'Given <context>, when <action>, then <outcome>.',
        '<criterion 2>',
        '<criterion 3>'
    ],
    'successMetrics': ['<metric 1>', '<metric 2>'],
    'inScope': ['<item 1>', '<item 2>'],
    'outOfScope': ['<item 1>'],
    'complexity': 'S|M|L|XL',
    'complexityRationale': '<brief explanation>'
}
json.dump(data, open('/tmp/story.json', 'w'))
"
`.trim();
}

function postPrompt(
  triage: Record<string, unknown>,
  analysis: Record<string, unknown>,
  rice: Record<string, unknown>,
  alignment: Record<string, unknown>,
  story: Record<string, unknown>
) {
  // Applied priority = alignment-adjusted, falling back to raw RICE if alignment missing.
  const finalPriority =
    (alignment.adjustedPriority as string) ?? (rice.priority as string);
  const okrsServed = (alignment.okrsServed as string[]) ?? [];
  const hasStory = !!story.userStory;
  const hasAnalysis = !!(analysis.painPoints as unknown[])?.length;
  const relatedIssues = (analysis.relatedIssues as Array<{ number: number; title: string }>) ?? [];
  const themes = (analysis.themes as Array<{ name: string; severity: string; description: string }>) ?? [];
  const quickWins = (analysis.quickWins as string[]) ?? [];

  const severityEmoji: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };

  const comment = `
## 🤖 AI Product Owner Analysis

> Automatically generated by the PO Assistant agent.

---

### 🏷️ Triage

| Field | Value |
|-------|-------|
| **Type** | \`${triage.type}\` |
| **Confidence** | ${triage.confidence} |
| **Assessment** | ${triage.reasoning} |

---

### 📊 RICE Prioritization

| Dimension | Value | Notes |
|-----------|------:|-------|
| Reach | ${rice.reach}% of users | % of active users impacted |
| Impact | ${rice.impact}x | 0.25 minimal → 3 massive |
| Confidence | ${rice.confidence}% | certainty in estimates |
| Effort | ${rice.effort} person-days | design + dev + QA |

**RICE Score: ${rice.riceScore}** → Priority: \`${rice.priority}\`

> ${rice.justification}

---

### 🎯 Strategic Alignment

| Field | Value |
|-------|-------|
| **OKRs served** | ${okrsServed.length ? okrsServed.join(", ") : "none"} |
| **Alignment score** | ${alignment.alignmentScore ?? "—"} / 3 |
| **Applied priority** | \`${rice.priority}\` → \`${finalPriority}\`${finalPriority === rice.priority ? " (unchanged)" : ""} |

> ${alignment.rationale ?? "No strategic rationale provided."}
${
  hasAnalysis
    ? `
---

### 🔍 Feedback Analysis
${
  themes.length > 0
    ? `
**Themes identified:**
${themes.map((t) => `- ${severityEmoji[t.severity] ?? "⚪"} **${t.name}** (${t.severity}): ${t.description}`).join("\n")}`
    : ""
}

**Pain points:**
${((analysis.painPoints as string[]) ?? []).map((p) => `- ${p}`).join("\n")}

**Feature intent:** ${analysis.featureIntent}
${
  quickWins.length > 0
    ? `
**Quick wins:** ${quickWins.map((w) => `\`${w}\``).join(", ")}`
    : ""
}
${
  relatedIssues.length > 0
    ? `
**Related issues:** ${relatedIssues.map((i) => `#${i.number} — ${i.title}`).join(", ")}`
    : ""
}`
    : ""
}
${
  hasStory
    ? `
---

### 📝 User Story

${story.problemStatement ? `**Problem:** ${story.problemStatement}\n` : ""}
> ${story.userStory}

**Acceptance criteria:**
${((story.acceptanceCriteria as string[]) ?? []).map((c, i) => `${i + 1}. ${c}`).join("\n")}
${
  (story.successMetrics as string[] | undefined)?.length
    ? `
**Success metrics:** ${(story.successMetrics as string[]).map((m) => `\`${m}\``).join(" · ")}`
    : ""
}
${
  (story.inScope as string[] | undefined)?.length
    ? `
**In scope:** ${(story.inScope as string[]).map((s) => `\`${s}\``).join(", ")}
**Out of scope:** ${((story.outOfScope as string[]) ?? []).map((s) => `\`${s}\``).join(", ") || "—"}`
    : ""
}

**Complexity estimate:** \`${story.complexity}\` — ${story.complexityRationale}`
    : ""
}

---

<sub>🔬 Powered by Claude · RICE score auto-prioritizes the backlog · Labels applied automatically</sub>
`.trim();

  return `
You are posting an automated analysis comment on a GitHub issue for Plane.

## Tasks

1. Apply the priority label:
   gh issue edit ${ISSUE.number} --repo ${ISSUE.repo} --add-label "priority:${finalPriority}"

2. Post the following comment exactly as-is (do not modify the markdown):
   gh issue comment ${ISSUE.number} --repo ${ISSUE.repo} --body '${comment.replace(/'/g, "'\\''")}'

3. Confirm success by writing to /tmp/post.json:
   python3 -c "import json; json.dump({'done': True}, open('/tmp/post.json', 'w'))"
`.trim();
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nIssue Agent starting for #${ISSUE.number}: "${ISSUE.title}"`);
  console.log(`Repository: ${ISSUE.repo}`);

  // Step 1 — Triage (always)
  const triageJson = await runStep("triage", triagePrompt());
  const triage = parse(triageJson);
  console.log(`  → type: ${triage.type}, confidence: ${triage.confidence}`);

  const isBugOrQuestion = triage.type === "bug" || triage.type === "question";

  // Step 2 — Analysis (skipped for bugs and questions)
  let analysis: Record<string, unknown> = {};
  if (!isBugOrQuestion) {
    const analysisJson = await runStep("analysis", analysisPrompt(triage));
    analysis = parse(analysisJson);
    console.log(`  → pain points: ${((analysis.painPoints as string[]) ?? []).length}, related: ${((analysis.relatedIssues as unknown[]) ?? []).length}`);
  }

  // Step 3 — RICE (always)
  const riceJson = await runStep("rice", ricePrompt(triage, analysis));
  const rice = parse(riceJson);
  console.log(`  → RICE: ${rice.riceScore} (${rice.priority})`);

  // Step 4 — Strategic alignment (always) — modulates the RICE priority
  const alignmentJson = await runStep("alignment", alignmentPrompt(triage, analysis, rice));
  const alignment = parse(alignmentJson);
  // Guard: recompute the tier bump from the model's score so the label can't drift from the rule.
  alignment.adjustedPriority = adjustPriority(rice.priority, alignment.alignmentScore);
  console.log(`  → alignment: ${alignment.alignmentScore}/3, priority ${rice.priority} → ${alignment.adjustedPriority} (OKRs: ${((alignment.okrsServed as string[]) ?? []).join(",") || "none"})`);

  // Step 5 — User story (feature-request and feedback only)
  let story: Record<string, unknown> = {};
  if (!isBugOrQuestion) {
    const storyJson = await runStep("story", storyPrompt(analysis));
    story = parse(storyJson);
    console.log(`  → complexity: ${story.complexity}`);
  }

  // Step 6 — Post comment + priority label (always)
  await runStep("post", postPrompt(triage, analysis, rice, alignment, story));
  console.log("\n✅ Analysis posted to issue #" + ISSUE.number);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
