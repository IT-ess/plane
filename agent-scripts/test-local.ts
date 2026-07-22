// Local test runner — sets env vars then imports the agent.
// Usage: npx tsx test-local.ts

const BODY = `
  ### Is there an existing issue for this?

  - [x] I have searched the existing issues

  ### Summary

  Add a description field to Modules, similar to the one available for Work Items (plain text is sufficient, though rich text formatting would be a nice bonus). This would let users document the purpose, scope, or high-level summary of a Module directly where it belongs, making it easier to understand what a Module is about at a glance — especially useful when onboarding teammates or reviewing older Modules.

  ### Why should this be worked on?

  Currently, Work Items support a detailed description field, but Modules do not. I organize my Work Items under Modules to group related work together, and I'd like to be able to store an overarching description at the Module level as well — summarizing the goal, scope, or context of that Module. Right now there's no place to capture this, so I end up either duplicating context across individual Work Items or keeping notes outside of Plane entirely.

  This would bring Modules more in line with the functionality already available for Work Items, and would be especially helpful for teams that use Modules as the primary organizational unit for grouping related Work Items.
`.trim();

process.env.ISSUE_NUMBER = "11";
process.env.ISSUE_TITLE = "[feature] Add plain text/rich text description field to Modules";
process.env.ISSUE_BODY = BODY;
// Replace with your actual fork: "IT-ess/plane"
process.env.GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY ?? "IT-ess/plane";
// Local run: skip GitHub label/comment side effects, just exercise the pipeline + Plane work-item creation.
// Set SKIP_GITHUB=0 to also post to GitHub.
process.env.SKIP_GITHUB = process.env.SKIP_GITHUB ?? "1";

await import("./issue-agent.ts");
