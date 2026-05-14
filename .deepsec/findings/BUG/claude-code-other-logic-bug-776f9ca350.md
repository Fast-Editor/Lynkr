# [BUG] setBudget '||' fallback prevents zero or null limits from being applied

**File:** [`src/budget/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/budget/index.js#L313-L328) (lines 313, 314, 315, 316, 317, 322, 323, 324, 325, 326, 327, 328)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

Lines 313-318 and 322-329 use `budget.monthlyTokenLimit || existing.monthly_token_limit` (and similar for request/cost/threshold). Because `0` is falsy in JS, an admin who attempts to set a user's limit to 0 (e.g., to disable a misbehaving user) will silently retain the prior or default value. The same applies to `null` or explicit `undefined`. This is a logic bug that defeats a likely admin operation.

## Recommendation

Use nullish coalescing (`??`) instead of `||`, or explicitly check `typeof budget.monthlyTokenLimit === 'number'`. Validate inputs with a schema (e.g., zod) so 0 is allowed but undefined falls back.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
- Plaidmustache <161773990+Plaidmustache@users.noreply.github.com> (2026-02-19)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-02-18)
