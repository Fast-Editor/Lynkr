# [MEDIUM] ReDoS via tempered-greedy-token regex in HTML script/style stripping

**File:** [`src/tools/web.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/web.js#L20-L354) (lines 20, 21, 354)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-redos`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

extractTextFromHtml at L20-21 uses two 'tempered greedy token' regex patterns to strip script and style tags:

  text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');

The nested quantifier `[^<]*(?:(?!<\/script>)<[^<]*)*` over the same input character `<` is a classic ReDoS antipattern. With adversarial input (e.g., a long unterminated `<script>` followed by many `<` characters and no closing tag, like `<script>` + `<` × 50000), the engine can spend pathological time exploring overlapping match positions. JavaScript's V8 has some optimizations but is not immune — issues have been demonstrated against very similar patterns.

Exploit path: this regex runs on the body of any URL fetched by web_fetch (L354). An attacker who can influence the URL the LLM fetches (prompt injection from external content, or crafted user input) hosts a page whose body is constructed to trigger backtracking, causing the proxy event loop to stall. Because Node.js is single-threaded, this hangs the entire proxy server (denial of service for all concurrent users, not just the attacker's session). The body is also bounded only by `bodyPreviewMax` for output, but the FULL body is processed by these regexes (see L341-343 — `rawBody = document.body` is passed to extractTextFromHtml, no upstream size limit on `response.text()` either).

## Recommendation

Replace the regex-based HTML cleaning with a real HTML parser that's not subject to ReDoS — e.g., `node-html-parser`, `cheerio`, `parse5`, or `htmlparser2`. They are O(n) and handle malformed input safely. If keeping a regex approach for some reason, (a) impose a hard size cap on `rawBody` before any regex runs (e.g., reject or truncate bodies > 1MB), and (b) rewrite the patterns to avoid the nested quantifier — for example, `/<script\b[\s\S]*?<\/script>/gi` is linear (lazy quantifier) and handles the same cases. Also consider running extraction on a worker thread so a stall doesn't take down the proxy.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
