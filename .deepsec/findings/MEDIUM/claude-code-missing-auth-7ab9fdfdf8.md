# [MEDIUM] POST /routing/analyze accepts unauthenticated input and runs analysis

**File:** [`src/api/router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/router.js#L151) (lines 151)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

Line 151 — POST /routing/analyze accepts arbitrary req.body, runs analyzeComplexity / agentic detection, and returns rich routing/cost/model details. An attacker can use this to probe the model registry, infer routing rules, and consume CPU. Not the worst issue but the endpoint should at minimum be loopback-only.

## Recommendation

Auth-gate or remove from production deployments.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
