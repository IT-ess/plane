// Self-check for parseBugForm. Run: npx tsx test-bug-form.ts
import assert from "node:assert";
import { parseBugForm } from "./bug-form";

const BODY = `
### Is there an existing issue for this?

- [x] I have searched the existing issues

### Current behavior

When I try to add a webhook it shows an error.

### Steps to reproduce

1. Go to Workspace settings
2. Click Create

### Environment

Production

### Browser

Mozilla Firefox

### Variant

Self-hosted

### Version

v1.3.1
`.trim();

const { labels, sections } = parseBugForm(BODY);

assert.deepStrictEqual(labels, ["env:production", "browser:mozilla-firefox", "variant:self-hosted"]);
assert.deepStrictEqual(
  sections.map((s) => s.title),
  ["Current behavior", "Steps to reproduce", "Version"]
);
// The checkbox block is dropped; prose content is preserved.
assert.ok(sections[0].body.startsWith("When I try"));

// Free-format body (no ### headers) → empty, so the caller falls back to the raw body.
assert.deepStrictEqual(parseBugForm("just some plain text, no headers"), {
  labels: [],
  sections: [],
});
// ...including multi-line free format — the first line must NOT become a section title.
assert.deepStrictEqual(parseBugForm("I found a bug.\n\nSteps:\n1. do a thing\n2. it breaks"), {
  labels: [],
  sections: [],
});

// Optional dropdown left blank → no label.
assert.deepStrictEqual(parseBugForm("### Browser\n\n_No response_").labels, []);

console.log("✅ bug-form: all asserts passed");
