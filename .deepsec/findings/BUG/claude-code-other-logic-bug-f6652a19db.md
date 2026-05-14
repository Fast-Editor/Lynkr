# [BUG] Hardcoded NVDA Yahoo Finance URL overrides any stock-related user query

**File:** [`src/orchestrator/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/orchestrator/index.js#L3258-L3264) (lines 3258, 3259, 3260, 3261, 3262, 3263, 3264)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

Lines 3258-3264 unconditionally rewrite `queryUrl` to `https://query1.finance.yahoo.com/v8/finance/chart/NVDA` whenever the user's message contains `price|stock|data|quote` (case-insensitive) and no explicit URL. This is a hardcoded data-leak: a user asking about *any* stock — AAPL, TSLA, GOOG, MSFT — receives NVDA chart data because of this regex shortcut. Because the tool result is then injected back into the model context, the model receives factually wrong data and may produce answers that confidently misattribute NVDA prices to other tickers. This is a substantive correctness bug (not a security vulnerability), and it appears to be an artifact of test/debug code that was left in production.

## Recommendation

Remove the hardcoded NVDA fallback. If a generic 'fetch financial data' fallback is desired, parse the ticker from the user message and route to the corresponding Yahoo Finance URL (e.g. `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`), or — better — let the model issue an explicit web_fetch with the URL it wants.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
