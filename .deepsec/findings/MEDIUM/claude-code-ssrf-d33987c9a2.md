# [MEDIUM] Policy web-fetch fallback uses URL extracted from user message and feeds it into web_fetch with permissive default allowlist

**File:** [`src/orchestrator/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/orchestrator/index.js#L3247-L3311) (lines 3247, 3249, 3255, 3279, 3294, 3311)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `ssrf`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The web-fallback path extracts an arbitrary HTTP(S) URL from the last user message via regex (line 3247: `lastUserMessage.content.match(/(https?:\/\/[^\s"']+)/i)`) and assigns it to `queryUrl`, which becomes the argument to a `web_fetch` tool call (line 3279). When combined with the default-permissive `WEB_SEARCH_ALLOW_ALL` (config/index.js:387) — which leaves `webAllowedHosts === null` so `ensureHostAllowed` is a no-op — this provides a one-step path from user-influence to arbitrary HTTP fetch. Furthermore, line 3294's `extractWebSearchUrls()` mines URLs from prior tool_result content and adds them to `orderedCandidates`, which means a URL planted in any prior web_search result (e.g. a poisoned search result link) is also re-fetched.

In the Lynkr threat model — a multi-tenant proxy running with cloud IAM permissions — this enables SSRF chains where: (a) a prompt-injected document or search result contains `http://169.254.169.254/latest/meta-data/...`, (b) the orchestrator's auto-fetch fallback fires, (c) the URL is re-fetched, (d) the metadata response is returned to the model and (potentially) the user. There is no SSRF guard between extraction and execution beyond the (default-disabled) allowlist.

## Recommendation

Before calling `executeToolCall(attemptCall, ...)` for the fallback web_fetch, run the candidate URL through a strict SSRF validator that (1) rejects RFC1918/loopback/link-local/metadata IPs, (2) re-validates after each redirect, and (3) refuses URLs lifted from tool_results unless they came from an explicitly trusted hostname. Consider not fetching URLs extracted via regex from user content at all — require the LLM to explicitly request a fetch with structured parameters.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
