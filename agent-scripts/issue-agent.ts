import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { adjustPriority } from "./priority";

const ISSUE = {
  number: process.env.ISSUE_NUMBER!,
  title: process.env.ISSUE_TITLE!,
  body: process.env.ISSUE_BODY || "(no description)",
  repo: process.env.GITHUB_REPOSITORY!,
};

// ponytail: assumes entrypoint runs from agent-scripts/ (the workflow + test-local both do).
const REPO_ROOT = resolve(process.cwd(), "..");

// Skip GitHub side effects (labels + comment) so a local run can exercise the Plane path alone.
const POST_GH = process.env.SKIP_GITHUB !== "1";

// The team's own Plane project — it dogfoods Plane to build Plane.
// Hardcoded to the demo workspace. ponytail: re-fetch via list_projects/list_states if the workspace is recreated.
const PLANE_PROJECT_ID = "024d5c16-fab9-4bca-b57d-72e16db1183a"; // Plane-agent-demo
const PLANE_INTAKE_STATE = "055a5cd7-72ba-45b9-9c9e-dd577c022e8a"; // "Github intakes" state
// CI has no cached OAuth, so authenticate the Plane MCP with a Personal Access Token instead.
// When PLANE_API_KEY is set (CI), use the api-key endpoint; otherwise fall back to the local OAuth cache (dev).
const PLANE_MCP = process.env.PLANE_API_KEY
  ? {
      plane: {
        type: "http" as const,
        url: "https://mcp.plane.so/http/api-key/mcp",
        headers: {
          "x-api-key": process.env.PLANE_API_KEY,
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
  "mcp__plane__create_work_item",
  "mcp__plane__create_work_item_comment",
];
// Each step only gets the one skill it needs (used both for loading and the fail-fast guard).
const SKILL = {
  analysis: "user-feedback-synthesizer",
  rice: "feature-prioritization-assistant",
  alignment: "plane-product-strategy",
  story: "prd-writer",
} as const;

async function runStep(name: string, prompt: string, skills: string[] = [], allowedTools: string[] = ["Bash"]): Promise<string> {
  console.log(`\n${"─".repeat(60)}\n[${name.toUpperCase()}]\n${"─".repeat(60)}`);
  for await (const msg of query({
    prompt,
    options: {
      allowedTools,
      cwd: REPO_ROOT,
      // "local" so dev runs pick up the `plane` MCP config (local scope of ~/.claude.json) + its cached OAuth.
      settingSources: ["project", "local"],
      // In CI, PLANE_MCP injects the api-key endpoint explicitly (no OAuth cache available).
      ...(PLANE_MCP ? { mcpServers: PLANE_MCP } : {}),
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
${ISSUE.body}

## Your tasks

1. Classify this issue as exactly one of:
   - bug           (something is broken)
   - feature-request (a new capability is requested)
   - feedback      (opinion or improvement suggestion)
   - question      (asking how something works)
   - other         (doesn't fit above)

2. ${POST_GH ? `Apply the matching label:
   gh issue edit ${ISSUE.number} --repo ${ISSUE.repo} --add-label "<type>"` : "(GitHub labeling skipped in local test mode — do not run gh.)"}

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
Use the \`feature-prioritization-assistant\` skill (invoke it via the Skill tool) for the RICE method.

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
Use the \`plane-product-strategy\` skill (invoke it via the Skill tool) to judge this issue's strategic fit.

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
Use the \`prd-writer\` skill (invoke it via the Skill tool) to structure this user story.

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

// Minimal HTML for the work-item description — Plane renders HTML, not markdown.
function storyHtml(story: Record<string, unknown>) {
  const esc = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (!story.userStory)
    return `<p>${esc(ISSUE.body)}</p>`; // bug/question: no story → fall back to the issue body
  const criteria = (story.acceptanceCriteria as string[]) ?? [];
  return [
    story.problemStatement ? `<p><strong>Problem:</strong> ${esc(story.problemStatement)}</p>` : "",
    `<blockquote>${esc(story.userStory)}</blockquote>`,
    criteria.length
      ? `<p><strong>Acceptance criteria:</strong></p><ul>${criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`
      : "",
    story.complexity ? `<p><strong>Complexity:</strong> ${esc(story.complexity)} — ${esc(story.complexityRationale)}</p>` : "",
  ].filter(Boolean).join("");
}

function publishPrompt(
  triage: Record<string, unknown>,
  story: Record<string, unknown>,
  finalPriority: string,
  comment: string
) {
  const extId = `${ISSUE.repo}#${ISSUE.number}`;
  const labelName = String(triage.type ?? "other");
  return `
You are publishing this issue as a work item in the team's own Plane project (they dogfood Plane).
Use the Plane MCP tools. Project id: ${PLANE_PROJECT_ID}. Intake state id: ${PLANE_INTAKE_STATE}.

Do these steps in order:

1. DEDUP GUARD — call search_work_items(query="${extId}", external_source="github", external_id="${extId}").
   If any result already links to this issue, STOP: write {"skipped": "duplicate"} to /tmp/publish.json and do nothing else.

2. LABEL — call list_labels(project_id="${PLANE_PROJECT_ID}"). Find a label named exactly "${labelName}".
   If none exists, create_label(project_id="${PLANE_PROJECT_ID}", name="${labelName}"). Keep its id.

3. CREATE — create_work_item with:
   - project_id="${PLANE_PROJECT_ID}"
   - name="#${ISSUE.number} ${String(ISSUE.title).replace(/"/g, "'")}"
   - description_html=<<<${storyHtml(story)}>>>
   - state="${PLANE_INTAKE_STATE}"
   - priority="${finalPriority}"
   - labels=[<the label id from step 2>]
   - external_source="github", external_id="${extId}"
   Keep the returned work item id.

4. COMMENT — create_work_item_comment(project_id="${PLANE_PROJECT_ID}", work_item_id=<new id>, comment_html) with the FULL analysis below, passed verbatim as comment_html:
<<<
${comment}
>>>

5. Write {"workItemId": "<new id>", "skipped": false} to /tmp/publish.json using python3.
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

  // Step 1 — Triage (always)
  const triageJson = await runStep("triage", triagePrompt());
  const triage = parse(triageJson);
  console.log(`  → type: ${triage.type}, confidence: ${triage.confidence}`);

  const isBugOrQuestion = triage.type === "bug" || triage.type === "question";

  // Step 2 — Analysis (skipped for bugs and questions)
  let analysis: Record<string, unknown> = {};
  if (!isBugOrQuestion) {
    const analysisJson = await runStep("analysis", analysisPrompt(triage), [SKILL.analysis]);
    analysis = parse(analysisJson);
    console.log(`  → pain points: ${((analysis.painPoints as string[]) ?? []).length}, related: ${((analysis.relatedIssues as unknown[]) ?? []).length}`);
  }

  // Step 3 — RICE (always)
  const riceJson = await runStep("rice", ricePrompt(triage, analysis), [SKILL.rice]);
  const rice = parse(riceJson);
  console.log(`  → RICE: ${rice.riceScore} (${rice.priority})`);

  // Step 4 — Strategic alignment (always) — modulates the RICE priority
  const alignmentJson = await runStep("alignment", alignmentPrompt(triage, analysis, rice), [SKILL.alignment]);
  const alignment = parse(alignmentJson);
  // Guard: recompute the tier bump from the model's score so the label can't drift from the rule.
  alignment.adjustedPriority = adjustPriority(rice.priority, alignment.alignmentScore);
  console.log(`  → alignment: ${alignment.alignmentScore}/3, priority ${rice.priority} → ${alignment.adjustedPriority} (OKRs: ${((alignment.okrsServed as string[]) ?? []).join(",") || "none"})`);

  // Step 5 — User story (feature-request and feedback only)
  let story: Record<string, unknown> = {};
  if (!isBugOrQuestion) {
    const storyJson = await runStep("story", storyPrompt(analysis), [SKILL.story]);
    story = parse(storyJson);
    console.log(`  → complexity: ${story.complexity}`);
  }

  const finalPriority = alignment.adjustedPriority as string; // recomputed above from the alignment score
  const comment = buildComment(triage, analysis, rice, alignment, story, finalPriority);

  // Step 6 — Post comment + priority label to GitHub (skipped in local test mode)
  if (POST_GH) {
    await runStep("post", postPrompt(finalPriority, comment));
    console.log("\n✅ Analysis posted to issue #" + ISSUE.number);
  } else {
    console.log("\n⏭️  SKIP_GITHUB=1 — skipped GitHub label + comment");
  }

  // Step 7 — Publish as a work item in the team's Plane project (always)
  const publishJson = await runStep("publish", publishPrompt(triage, story, finalPriority, comment), [], PUBLISH_TOOLS);
  const publish = parse(publishJson);
  console.log(
    publish.skipped
      ? `  → Plane: skipped (${publish.skipped})`
      : `✅ Plane work item created: ${publish.workItemId}`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
