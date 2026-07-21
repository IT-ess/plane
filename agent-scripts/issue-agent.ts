import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "fs";

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
You are a product analyst for Plane, a project management platform.

## Context
Issue #${ISSUE.number}: "${ISSUE.title}"
Type: ${triage.type}

Body:
${ISSUE.body}

## Your tasks

1. Search for related issues (try 2-3 different keyword searches):
   gh issue list --repo ${ISSUE.repo} --state all --search "<keywords>" --json number,title --limit 5

2. Extract the key insights from the issue body.

3. Write your analysis to /tmp/analysis.json using Python:
   python3 -c "
import json
data = {
    'painPoints': ['<pain point 1>', '<pain point 2>'],
    'featureIntent': '<what the user ultimately wants to achieve>',
    'relatedIssues': [{'number': N, 'title': '...'}]
}
json.dump(data, open('/tmp/analysis.json', 'w'))
"

Replace all placeholders with real insights from the issue. relatedIssues may be empty if none found.
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

Score this issue using the RICE framework (each dimension 1–10):
- Reach: How many Plane users would benefit? (10 = nearly all users)
- Impact: How much does it improve their workflow? (10 = transformative)
- Confidence: How certain are we of these estimates? (10 = very certain)
- Effort: Engineering effort required (10 = huge multi-sprint effort)

RICE Score = (Reach × Impact × Confidence) / Effort (round to 1 decimal)

Priority thresholds:
- high   → RICE ≥ 40
- medium → RICE 15–39
- low    → RICE < 15

Write to /tmp/rice.json using Python:
python3 -c "
import json
reach, impact, confidence, effort = <R>, <I>, <C>, <E>
rice = round((reach * impact * confidence) / effort, 1)
data = {
    'reach': reach,
    'impact': impact,
    'confidence': confidence,
    'effort': effort,
    'riceScore': rice,
    'priority': 'high' if rice >= 40 else ('medium' if rice >= 15 else 'low'),
    'justification': '<2-3 sentences explaining the scores>'
}
json.dump(data, open('/tmp/rice.json', 'w'))
"
`.trim();
}

function storyPrompt(analysis: Record<string, unknown>) {
  return `
You are a product owner assistant for Plane, a project management platform.

## Context
Issue #${ISSUE.number}: "${ISSUE.title}"
Feature intent: ${analysis.featureIntent ?? ISSUE.title}
Pain points: ${JSON.stringify(analysis.painPoints ?? [])}

Body:
${ISSUE.body}

## Your task

Generate a structured user story. The persona should reflect the actual Plane user type
(e.g., "project manager", "developer", "team lead", "product owner").

Complexity scale:
- S  → trivial change, < 1 day
- M  → a few days
- L  → 1–2 sprints
- XL → multi-sprint, major effort

Write to /tmp/story.json using Python:
python3 -c "
import json
data = {
    'userStory': 'As a <persona>, I want <goal> so that <benefit>.',
    'acceptanceCriteria': [
        'Given <context>, when <action>, then <outcome>.',
        '<criterion 2>',
        '<criterion 3>'
    ],
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
  story: Record<string, unknown>
) {
  const hasStory = !!story.userStory;
  const hasAnalysis = !!(analysis.painPoints as unknown[])?.length;
  const relatedIssues = (analysis.relatedIssues as Array<{ number: number; title: string }>) ?? [];

  const riceBar = (n: number) => "█".repeat(Math.round(n)) + "░".repeat(10 - Math.round(n));

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

| Dimension | Score | Bar |
|-----------|------:|-----|
| Reach | ${rice.reach}/10 | \`${riceBar(rice.reach as number)}\` |
| Impact | ${rice.impact}/10 | \`${riceBar(rice.impact as number)}\` |
| Confidence | ${rice.confidence}/10 | \`${riceBar(rice.confidence as number)}\` |
| Effort | ${rice.effort}/10 | \`${riceBar(rice.effort as number)}\` |

**RICE Score: ${rice.riceScore}** → Priority: \`${rice.priority}\`

> ${rice.justification}
${
  hasAnalysis
    ? `
---

### 🔍 Feedback Analysis

**Pain points identified:**
${((analysis.painPoints as string[]) ?? []).map((p) => `- ${p}`).join("\n")}

**Feature intent:** ${analysis.featureIntent}
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

> ${story.userStory}

**Acceptance criteria:**
${((story.acceptanceCriteria as string[]) ?? []).map((c, i) => `${i + 1}. ${c}`).join("\n")}

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
   gh issue edit ${ISSUE.number} --repo ${ISSUE.repo} --add-label "priority:${rice.priority}"

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

  // Step 4 — User story (feature-request and feedback only)
  let story: Record<string, unknown> = {};
  if (!isBugOrQuestion) {
    const storyJson = await runStep("story", storyPrompt(analysis));
    story = parse(storyJson);
    console.log(`  → complexity: ${story.complexity}`);
  }

  // Step 5 — Post comment + priority label (always)
  await runStep("post", postPrompt(triage, analysis, rice, story));
  console.log("\n✅ Analysis posted to issue #" + ISSUE.number);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
