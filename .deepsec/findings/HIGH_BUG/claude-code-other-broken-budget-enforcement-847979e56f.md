# [HIGH_BUG] recordUsage is never invoked in production — monthly token/request/cost limits are non-functional

**File:** [`src/budget/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/budget/index.js#L208-L282) (lines 208, 211, 221, 231, 278, 282)
**Project:** claude-code
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-broken-budget-enforcement`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

The `recordUsage()` method (line 278) writes to the `usage_tracking` table that `checkBudget()` reads from at line 208 (and `getUsageSummary()` at line 341). However, a repository-wide search confirms `recordUsage` is only invoked from the test suite (`test/comprehensive-test-suite.js`) and never from any production code path. The budget middleware (src/api/middleware/budget.js) calls `checkBudget()` and stores `req.budgetInfo` but never calls `recordUsage()` after the LLM request completes. Consequence: `usage_tracking` is always empty in production, so `usage.total_tokens`, `usage.request_count`, and `usage.total_cost` returned by the `getMonthlyUsage` query are always 0 and the limit checks at lines 211, 221, and 231 always pass. The advertised cost / token / request budget controls do not enforce anything. Severity flagged HIGH_BUG rather than HIGH security because the failure mode is fail-open and does not let an attacker exceed an otherwise-enforced limit — but operators relying on these limits for cost control will silently overspend.

## Recommendation

Wire `recordUsage()` into the response pipeline (e.g., in the `/v1/messages` handler or as response middleware after `budgetMiddleware`). Use `req.budgetInfo.userId` to attribute usage. Add an integration test that hits the real endpoint and verifies the row was inserted.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
- Plaidmustache <161773990+Plaidmustache@users.noreply.github.com> (2026-02-19)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-02-18)
