// Parse a GitHub bug issue-form body into Plane metadata.
// The form (.github/ISSUE_TEMPLATE/--bug-report.yaml) renders as "### <Field>\n\n<value>"
// blocks. Dropdown fields are metadata → Plane labels; prose fields stay in the body.
// Deterministic (like priority.ts) so a bug's metadata can't be reshaped by the LLM.

export type BugForm = {
  labels: string[];
  sections: { title: string; body: string }[];
};

// Dropdown field label (lowercased) → Plane label prefix.
const DROPDOWNS: Record<string, string> = {
  environment: "env",
  browser: "browser",
  variant: "variant",
};

// Blocks dropped entirely (checkbox noise, no value for a work item).
const OMIT = new Set(["is there an existing issue for this?"]);

const slug = (v: string) => v.trim().toLowerCase().replace(/\s+/g, "-");

export function parseBugForm(body: string): BugForm {
  // No form headers → free-format / template deleted; caller falls back to the raw body.
  if (!/^\s*###\s+/m.test(body)) return { labels: [], sections: [] };

  // ponytail: a "###" line inside a code fence would false-split; rare, make the
  // split fence-aware only if it bites.
  const blocks = body
    .split(/^\s*###\s+/m)
    .map((s) => s.trim())
    .filter(Boolean);

  const labels: string[] = [];
  const sections: { title: string; body: string }[] = [];

  for (const block of blocks) {
    const nl = block.indexOf("\n");
    const title = (nl === -1 ? block : block.slice(0, nl)).trim();
    const content = (nl === -1 ? "" : block.slice(nl + 1)).trim();
    const key = title.toLowerCase();

    if (OMIT.has(key)) continue;
    // Optional fields the user left blank render as "_No response_".
    if (!content || content === "_No response_") continue;

    const prefix = DROPDOWNS[key];
    if (prefix) labels.push(`${prefix}:${slug(content)}`);
    else sections.push({ title, body: content });
  }

  return { labels, sections };
}
