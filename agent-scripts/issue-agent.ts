import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { adjustPriority } from "./priority";
import { parseBugForm } from "./bug-form";

const ISSUE = {
  number: process.env.ISSUE_NUMBER!,
  title: process.env.ISSUE_TITLE!,
  body: process.env.ISSUE_BODY || "(no description)",
  repo: process.env.GITHUB_REPOSITORY!,
};

// Body copy for LLM prompts only — capped so a huge issue can't inflate all 5 prompts.
// ponytail: 4000-char ceiling; parseBugForm / storyHtml still use the full ISSUE.body.
const BODY = ISSUE.body.length > 4000 ? ISSUE.body.slice(0, 4000) + "\n…(truncated)" : ISSUE.body;

// ponytail: assumes entrypoint runs from agent-scripts/ (the workflow + test-local both do).
const REPO_ROOT = resolve(process.cwd(), "..");

// Skip GitHub side effects (labels + comment) so a local run can exercise the Plane path alone.
const POST_GH = process.env.SKIP_GITHUB !== "1";

// The team's own Plane project — it dogfoods Plane to build Plane.
// Hardcoded to the demo workspace. ponytail: re-fetch via list_projects/list_states if the workspace is recreated.
const PLANE_PROJECT_ID = "024d5c16-fab9-4bca-b57d-72e16db1183a"; // Plane-agent-demo
// Intake work items land in the project's Intake inbox, auto-assigned to the Triage
// state — no state id needed; a human accepts/rejects them before they hit the backlog.
// CI has no cached OAuth, so authenticate the Plane MCP with a Personal Access Token instead.
// When PLANE_API_KEY is set (CI), use the api-key endpoint; otherwise fall back to the local OAuth cache (dev).
const PLANE_MCP = process.env.PLANE_API_KEY
  ? {
      plane: {
        type: "http" as const,
        url: "https://mcp.plane.so/http/api-key/mcp",
        // The api-key endpoint authenticates via Bearer (verified: x-api-key → 401 needs-auth, Bearer → 200).
        headers: {
          Authorization: `Bearer ${process.env.PLANE_API_KEY}`,
          "x-workspace-slug": process.env.PLANE_WORKSPACE_SLUG ?? "",
        },
      },
    }
  : undefined;
const PUBLISH_TOOLS = [
  "Bash",
  "mcp__plane__search_work_items",
  "mcp__plane__list_labels",
  "mcp__plane__create_label",
  "mcp__plane__create_intake_work_item",
  "mcp__plane__update_work_item",
  "mcp__plane__create_work_item_link",
  "mcp__plane__create_work_item_comment",
];
// Each step only gets the one skill it needs (used both for loading and the fail-fast guard).
const SKILL = {
  analysis: "user-feedback-synthesizer",
  rice: "feature-prioritization-assistant",
  alignment: "plane-product-strategy",
  story: "prd-writer",
} as const;

// Cheap model for the pure classification/scoring steps (alias "haiku" also resolves).
const HAIKU = "claude-haiku-4-5-20251001";

type StepOpts = {
  skills?: string[];
  allowedTools?: string[];
  // Only the publish step talks to Plane. Attaching the MCP loads ~200 tool schemas into
  // context — a huge per-step token cost — so every other step runs without it.
  useMcp?: boolean;
  // undefined → ANTHROPIC_MODEL (Sonnet); set HAIKU for cheap deterministic steps.
  model?: string;
  // true → light adaptive thinking; false → thinking off. Most steps emit a tiny fixed JSON
  // and don't need reasoning (priority math is recomputed in TS anyway), so default is off.
  effortLow?: boolean;
  // Cap turns so a step that loops on a tool error can't silently burn 10× the tokens.
  maxTurns?: number;
};

async function runStep(name: string, prompt: string, opts: StepOpts = {}): Promise<string> {
  const { skills = [], allowedTools = ["Bash"], useMcp = false, model, effortLow = false, maxTurns = 4 } = opts;
  console.log(`\n${"─".repeat(60)}\n[${name.toUpperCase()}]\n${"─".repeat(60)}`);
  for await (const msg of query({
    prompt,
    options: {
      allowedTools,
      cwd: REPO_ROOT,
      maxTurns,
      // "local" (dev) pulls in the `plane` MCP from ~/.claude.json + its cached OAuth — only wanted
      // when this step actually needs Plane, otherwise it auto-loads every plane tool schema.
      settingSources: useMcp ? ["project", "local"] : ["project"],
      // In CI, PLANE_MCP injects the api-key endpoint explicitly (no OAuth cache available).
      ...(useMcp && PLANE_MCP ? { mcpServers: PLANE_MCP } : {}),
      ...(model ? { model } : {}),
      ...(effortLow ? { effort: "low" as const } : { thinking: { type: "disabled" as const } }),
      skills,
    },
  })) {
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
${BODY}

## Your tasks

1. Classify this issue as exactly one of:
   - bug           (something is broken)
   - feature-request (a new capability is requested)
   - feedback      (opinion or improvement suggestion)
   - question      (asking how something works)
   - other         (doesn't fit above)

2. ${
    POST_GH
      ? `Apply the matching label:
   gh issue edit ${ISSUE.number} --repo ${ISSUE.repo} --add-label "<type>"`
      : "(GitHub labeling skipped in local test mode — do not run gh.)"
  }

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
Use the \`user-feedback-synthesizer\` skill (invoke it via the Skill tool) to analyze this issue.

## Context
Issue #${ISSUE.number}: "${ISSUE.title}"
Type: ${triage.type}

Body:
${BODY}

## Your tasks

1. Synthesize the feedback by:
   - Clustering signals into themes (what category of problem does each pain point belong to?)
   - Assessing severity per theme: critical (blocks work) / high (major friction) / medium (notable inconvenience) / low (nice-to-have)
   - Identifying quick wins (small-effort, high-visibility improvements buried in the request)
   - Extracting the core feature intent (what job-to-be-done is the user trying to accomplish?)

2. Write your analysis to /tmp/analysis.json using Python:
   python3 -c "
import json
data = {
    'painPoints': ['<specific pain point 1>', '<specific pain point 2>'],
    'featureIntent': '<the underlying job-to-be-done the user wants to accomplish>',
    'themes': [
        {'name': '<theme name>', 'severity': 'critical|high|medium|low', 'description': '<one sentence>'}
    ],
    'quickWins': ['<small improvement that could be shipped fast>']
}
json.dump(data, open('/tmp/analysis.json', 'w'))
"

quickWins may be empty if none found.
`.trim();
}

function ricePrompt(triage: Record<string, unknown>, analysis: Record<string, unknown>) {
  const hasAnalysis = Object.keys(analysis).length > 0;
  return `
You are a senior product manager for Plane, a project management platform used by software teams.
Use the \`feature-prioritization-assistant\` skill (invoke it via the Skill tool) for the RICE method.

## Issue
#${ISSUE.number}: "${ISSUE.title}"
Type: ${triage.type}
Reasoning: ${triage.reasoning}

${
  hasAnalysis
    ? `## Feedback analysis
Pain points: ${JSON.stringify(analysis.painPoints ?? [])}
Feature intent: ${analysis.featureIntent ?? "N/A"}`
    : ""
}

Body:
${BODY}

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
Use the \`plane-product-strategy\` skill (invoke it via the Skill tool) to judge this issue's strategic fit.

## Issue
#${ISSUE.number}: "${ISSUE.title}"
Type: ${triage.type}
Feature intent: ${analysis.featureIntent ?? ISSUE.title}
RICE priority (before alignment): ${rice.priority ?? "medium"}

Body:
${BODY}

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
Use the \`prd-writer\` skill (invoke it via the Skill tool) to structure this user story.

## Context
Issue #${ISSUE.number}: "${ISSUE.title}"
Feature intent: ${analysis.featureIntent ?? ISSUE.title}
Pain points: ${JSON.stringify(analysis.painPoints ?? [])}
Themes: ${JSON.stringify(analysis.themes ?? [])}

Body:
${BODY}

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

// Builds the shared analysis markdown — reused for the GitHub comment and the Plane work-item comment.
function buildComment(
  triage: Record<string, unknown>,
  analysis: Record<string, unknown>,
  rice: Record<string, unknown>,
  alignment: Record<string, unknown>,
  story: Record<string, unknown>,
  finalPriority: string
) {
  const okrsServed = (alignment.okrsServed as string[]) ?? [];
  const hasStory = !!story.userStory;
  const hasAnalysis = !!(analysis.painPoints as unknown[])?.length;
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

  return comment;
}

function postPrompt(finalPriority: string, comment: string) {
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

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// Bug work-item body: render each parsed form section under its title.
// ponytail: no full markdown rendering — same fidelity ceiling storyHtml's raw
// fallback already has (escaped text), just sectioned with line breaks kept.
function bugHtml(sections: { title: string; body: string }[]) {
  return sections.map((s) => `<h2>${esc(s.title)}</h2><p>${esc(s.body).replace(/\n/g, "<br>")}</p>`).join("");
}

// Minimal HTML for the work-item description — Plane renders HTML, not markdown.
function storyHtml(story: Record<string, unknown>) {
  if (!story.userStory) return `<p>${esc(ISSUE.body)}</p>`; // bug/question: no story → fall back to the issue body
  const criteria = (story.acceptanceCriteria as string[]) ?? [];
  const metrics = (story.successMetrics as string[]) ?? [];
  const inScope = (story.inScope as string[]) ?? [];
  const outOfScope = (story.outOfScope as string[]) ?? [];
  const li = (items: string[]) => items.map((s) => `<li>${esc(s)}</li>`).join("");
  const scopeCell = (items: string[]) => (items.length ? `<ul>${li(items)}</ul>` : "—");
  return [
    story.problemStatement ? `<h2>Problem</h2><p>${esc(story.problemStatement)}</p>` : "",
    `<h2>User story</h2><blockquote>${esc(story.userStory)}</blockquote>`,
    criteria.length ? `<h2>Acceptance criteria</h2><ol>${li(criteria)}</ol>` : "",
    metrics.length ? `<h2>Success metrics</h2><ul>${li(metrics)}</ul>` : "",
    inScope.length || outOfScope.length
      ? `<h2>Scope</h2><table><tr><th>In scope</th><th>Out of scope</th></tr>` +
        `<tr><td>${scopeCell(inScope)}</td><td>${scopeCell(outOfScope)}</td></tr></table>`
      : "",
    story.complexity
      ? `<h2>Complexity</h2><table><tr><th>Estimate</th><th>Rationale</th></tr>` +
        `<tr><td>${esc(story.complexity)}</td><td>${esc(story.complexityRationale)}</td></tr></table>`
      : "",
  ]
    .filter(Boolean)
    .join("");
}

function publishPrompt(labels: string[], descriptionHtml: string, finalPriority: string, comment: string) {
  const extId = `${ISSUE.repo}#${ISSUE.number}`;
  return `
You are publishing this issue into the Intake inbox of the team's own Plane project (they dogfood Plane).
An intake work item lands in the Triage state for a human to accept/reject before it becomes backlog work.
Use the Plane MCP tools. Project id: ${PLANE_PROJECT_ID}.

Do these steps in order:

1. DEDUP GUARD — call search_work_items(query="${extId}", external_source="github", external_id="${extId}").
   If any result already links to this issue, STOP: write {"skipped": "duplicate"} to /tmp/publish.json and do nothing else.

2. LABELS — call list_labels(project_id="${PLANE_PROJECT_ID}"). You need these labels, named exactly: ${JSON.stringify(labels)}.
For each one that does not already exist, create_label(project_id="${PLANE_PROJECT_ID}", name=<the label>). Collect the ids of ALL of them.

3. CREATE (intake) — create_intake_work_item with:
   - project_id="${PLANE_PROJECT_ID}"
   - data={"issue": {"name": "#${ISSUE.number} ${String(ISSUE.title).replace(/"/g, "'")}", "description_html": <<<${descriptionHtml}>>>, "priority": "${finalPriority}"}}
   The response is an intake work item. Take the underlying work item id from its "issue" field
   (same value as issue_detail.id). Use THAT id — not the intake id — for every step below.

4. BACKFILL — the intake create can't set labels or external ids, so do it in one update_work_item call:
   update_work_item(project_id="${PLANE_PROJECT_ID}", work_item_id=<id from step 3>,
     labels=[<ALL label ids from step 2>], external_source="github", external_id="${extId}").
   Do NOT set state — leave it in Triage so it stays in the inbox.

5. LINK — create_work_item_link(project_id="${PLANE_PROJECT_ID}", work_item_id=<id>, url="https://github.com/${ISSUE.repo}/issues/${ISSUE.number}").

6. COMMENT — create_work_item_comment(project_id="${PLANE_PROJECT_ID}", work_item_id=<id>, comment_html) with the FULL analysis below, passed verbatim as comment_html:
<<<
${comment}
>>>

7. Write {"workItemId": "<id>", "skipped": false} to /tmp/publish.json using python3.
`.trim();
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nIssue Agent starting for #${ISSUE.number}: "${ISSUE.title}"`);
  console.log(`Repository: ${ISSUE.repo}`);

  // Fail fast if a skill name won't resolve — otherwise the SDK just silently omits it.
  for (const s of Object.values(SKILL)) {
    if (!existsSync(`${REPO_ROOT}/.claude/skills/${s}`))
      throw new Error(`Skill "${s}" not found under .claude/skills/ — check the name`);
  }

  // Step 1 — Triage (always) — pure classification → cheap model, no thinking.
  const triageJson = await runStep("triage", triagePrompt(), { model: HAIKU });
  const triage = parse(triageJson);
  console.log(`  → type: ${triage.type}, confidence: ${triage.confidence}`);

  const isBugOrQuestion = triage.type === "bug" || triage.type === "question";

  // Step 2 — Analysis (skipped for bugs and questions) — synthesis benefits from light thinking.
  let analysis: Record<string, unknown> = {};
  if (!isBugOrQuestion) {
    const analysisJson = await runStep("analysis", analysisPrompt(triage), {
      skills: [SKILL.analysis],
      effortLow: true,
      maxTurns: 5,
    });
    analysis = parse(analysisJson);
    console.log(`  → pain points: ${((analysis.painPoints as string[]) ?? []).length}`);
  }

  // Step 3 — RICE (always) — scores are recomputed/clamped in TS, so no thinking needed.
  const riceJson = await runStep("rice", ricePrompt(triage, analysis), {
    skills: [SKILL.rice],
    model: HAIKU,
  });
  const rice = parse(riceJson);
  console.log(`  → RICE: ${rice.riceScore} (${rice.priority})`);

  // Step 4 — Strategic alignment (always) — modulates the RICE priority (bump recomputed in TS).
  const alignmentJson = await runStep("alignment", alignmentPrompt(triage, analysis, rice), {
    skills: [SKILL.alignment],
    model: HAIKU,
  });
  const alignment = parse(alignmentJson);
  // Guard: recompute the tier bump from the model's score so the label can't drift from the rule.
  alignment.adjustedPriority = adjustPriority(rice.priority, alignment.alignmentScore);
  console.log(
    `  → alignment: ${alignment.alignmentScore}/3, priority ${rice.priority} → ${alignment.adjustedPriority} (OKRs: ${((alignment.okrsServed as string[]) ?? []).join(",") || "none"})`
  );

  // Step 5 — User story (feature-request and feedback only) — writing benefits from light thinking.
  let story: Record<string, unknown> = {};
  if (!isBugOrQuestion) {
    const storyJson = await runStep("story", storyPrompt(analysis), {
      skills: [SKILL.story],
      effortLow: true,
      maxTurns: 5,
    });
    story = parse(storyJson);
    console.log(`  → complexity: ${story.complexity}`);
  }

  const finalPriority = alignment.adjustedPriority as string; // recomputed above from the alignment score
  const comment = buildComment(triage, analysis, rice, alignment, story, finalPriority);

  // Bugs come from a structured issue form: lift dropdowns → labels, prose → titled body (deterministic, in TS).
  const bugForm = triage.type === "bug" ? parseBugForm(ISSUE.body) : { labels: [], sections: [] };
  const labels = [String(triage.type ?? "other"), ...bugForm.labels];
  const descriptionHtml = bugForm.sections.length ? bugHtml(bugForm.sections) : storyHtml(story);

  // Step 6 — Post comment + priority label to GitHub (skipped in local test mode) — two gh calls.
  if (POST_GH) {
    await runStep("post", postPrompt(finalPriority, comment), { maxTurns: 5 });
    console.log("\n✅ Analysis posted to issue #" + ISSUE.number);
  } else {
    console.log("\n⏭️  SKIP_GITHUB=1 — skipped GitHub label + comment");
  }

  // Step 7 — Publish as a work item in the team's Plane project (always) — ~6 sequential MCP calls.
  const publishJson = await runStep("publish", publishPrompt(labels, descriptionHtml, finalPriority, comment), {
    allowedTools: PUBLISH_TOOLS,
    useMcp: true, // publish is the only step that needs the Plane MCP
    maxTurns: 12,
  });
  const publish = parse(publishJson);
  if (!publish.skipped && !publish.workItemId)
    throw new Error(
      "Publish step produced no workItemId — /tmp/publish.json was not written or is empty. " +
        "A Plane MCP call likely failed mid-run; see the [PUBLISH] output above for the failing tool."
    );
  console.log(
    publish.skipped
      ? `  → Plane: skipped (${publish.skipped})`
      : `✅ Plane intake work item created: ${publish.workItemId}`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
