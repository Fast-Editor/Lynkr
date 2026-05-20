# [MEDIUM] userId accepted from caller without validation — combined with header-trust in middleware enables trivial rate-limit/budget bypass

**File:** [`src/budget/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/budget/index.js#L119-L337) (lines 119, 192, 278, 306, 337)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

All public methods (`checkRateLimit`, `checkBudget`, `setBudget`, `recordUsage`, `getUsageSummary`) accept a `userId` parameter and use it directly as the SQL key without any validation that the caller actually represents that user. The sole production caller, `src/api/middleware/budget.js:11`, derives userId from `req.session?.id || req.headers['x-user-id'] || 'default'`. The session id is itself extracted from caller-supplied headers (`x-session-id`, `x-claude-session-id`, etc., per src/api/middleware/session.js) with no authentication. Net effect: any client can rotate the `x-session-id` header on every request to allocate a fresh rate-limit / budget bucket, bypassing all per-user controls. They can also set `x-user-id` to another user's ID to consume that user's quota or to attribute usage costs to them. The `setBudget()` method has no authorization check at all, so if any code path ever exposes it via HTTP it would let any client raise their own — or another user's — limits arbitrarily.

## Recommendation

Require an authenticated principal (validated session, JWT, or API key) and derive the userId server-side from that principal rather than from headers. Reject calls into BudgetManager whose userId was not produced by the auth layer. Add an explicit authorization check to `setBudget()` (admin-only) or remove it from any HTTP-reachable path.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
- Plaidmustache <161773990+Plaidmustache@users.noreply.github.com> (2026-02-19)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-02-18)
