# [MEDIUM] summarizeWithModel sends raw diffs to LLM, response parsed as JSON without validation

**File:** [`src/tools/git.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/git.js#L136-L1304) (lines 136, 154, 416, 443, 982, 1069, 1158, 1260, 1304)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-prompt-injection-rce`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

summarizeWithModel (lines 136-171) sends the unredacted diff body to a Databricks-hosted model and trusts the returned JSON. The diff content is itself attacker-controlled in many threat models (e.g., the agent reviews PRs with adversarial content). The returned JSON.parse() result feeds workspace_diff_summary, workspace_workspace_diff_review, workspace_git_patch_plan, workspace_changelog_generate which the model then displays to the developer. Because the tools wrap the parsed structure back into JSON.stringify, this is mainly an information-disclosure / instruction-injection concern, not direct RCE. However: (1) the LLM's reply could include URLs/commands that, when copied into a terminal by the developer, become RCE; (2) the diff content (potentially sensitive: secrets in env files, customer data in fixtures) leaves the workspace and is sent to a third-party model with no consent or redaction step. This isn't a code defect per se, but worth flagging as a data-exfiltration vector that operators may not realize they're enabling by using these tools.

## Recommendation

Document the data-leakage trade-off prominently for these tools, optionally redact obvious secrets (API keys, tokens) before sending diffs to the model, and never blindly trust the model's parsed JSON for decisions that affect filesystem or repo state.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
