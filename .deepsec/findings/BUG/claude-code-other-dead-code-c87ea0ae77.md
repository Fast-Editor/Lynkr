# [BUG] GPT-specific output formatting permanently disabled with hardcoded `false`

**File:** [`src/tools/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/index.js#L264-L287) (lines 264, 273, 287)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-dead-code`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

Line 273 sets `const isGPT = false; // Disabled for testing` and the call to formatToolResultForGPT is commented out (L266-272). If the GPT formatter performs any safety-relevant transformation (e.g. escaping, length normalization), this is a latent regression. More immediately, this is dead/branching code that will silently rot. Not directly exploitable but worth flagging.

## Recommendation

Either re-enable the GPT formatter behind a config flag and remove the hardcoded `false`, or delete the dead branch entirely.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-02-23)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
