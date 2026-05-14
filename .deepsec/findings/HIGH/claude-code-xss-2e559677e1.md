# [HIGH] DOM XSS via attribute injection — `${docName}` interpolated into href inside innerHTML template literal

**File:** [`docs/docs.html`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/docs/docs.html#L127-L133) (lines 127, 133)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

On line 133 the attacker-controlled `docName` is interpolated directly into an `href` attribute inside the same template literal that is later assigned to innerHTML on line 127: `<a href="https://github.com/Fast-Editor/Lynkr/edit/main/documentation/${docName}.md" ...>`. There is no HTML/attribute escaping. An attacker can send `?doc=foo" onclick="alert(document.cookie)//` and break out of the href attribute to inject an event handler, which fires when the link is clicked. Even simpler, `?doc=foo"><img src=x onerror=alert(1)><a href="` injects a fully attacker-controlled element. This is independent of finding 1 — it does not require traversal or a remote fetch.

## Recommendation

Build the link via DOM APIs (`document.createElement('a')` + `.setAttribute('href', ...)`) rather than innerHTML, or HTML-encode `docName` before interpolation (e.g., `encodeURIComponent` for the URL portion plus an attribute-escape helper). Combine with the allow-list in finding 1.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
