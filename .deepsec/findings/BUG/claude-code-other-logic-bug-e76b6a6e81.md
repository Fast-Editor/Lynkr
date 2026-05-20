# [BUG] `logs` does not validate `req.query.since` and accepts NaN

**File:** [`src/dashboard/api.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/dashboard/api.js#L162) (lines 162)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

Line 162: `filters.since = parseInt(req.query.since, 10)` is assigned directly even if the value parses to `NaN` (e.g., `?since=abc`). Downstream in telemetry.query, a NaN comparison silently filters everything out (or, depending on the DB binding, raises). Not a security bug but a quality issue worth flagging.

## Recommendation

`const since = Number.parseInt(req.query.since, 10); if (Number.isFinite(since)) filters.since = since;`

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-05-04)
