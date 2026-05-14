# [HIGH] No rate limiting on LLM and embedding endpoints — server's API keys can be drained

**File:** [`src/api/openai-router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/openai-router.js#L334-L1397) (lines 334, 1283, 1397)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `expensive-api-abuse`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

/v1/chat/completions (L334), /v1/embeddings (L1283) and /v1/responses (L1397) make outbound calls to paid providers (OpenAI, OpenRouter, Bedrock, Databricks, etc.) using the server's API keys taken from .env. No rate limiter is registered on these routes — only /v1/messages in router.js gets the rateLimiter middleware. Combined with the missing auth, an attacker can issue unbounded requests, draining the operator's quota and incurring real cost. The embeddings endpoint is particularly attractive because each request can include large input arrays.

## Recommendation

Apply the existing createRateLimiter() middleware to these routes, or apply it globally in server.js. Add a per-key spend cap and a max-tokens-per-request limit for unauthenticated callers.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-03-21)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
