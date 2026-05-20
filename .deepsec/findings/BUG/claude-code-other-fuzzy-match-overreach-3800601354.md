# [BUG] Fuzzy tool-to-category matching by first-token prefix can load wrong category

**File:** [`src/tools/lazy-loader.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/lazy-loader.js#L308-L312) (lines 308, 309, 310, 311, 312)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-fuzzy-match-overreach`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

loadCategoryForTool (lines 308-312) falls back to a fuzzy match: `lowerName.startsWith(toolPattern.split('_')[0])` for every entry in toolToCategory. The first-token prefixes overlap heavily (`workspace_*` exists in git, indexer, edits, tasks, tests, mcp), so the iteration order of `Object.entries(toolToCategory)` decides which category gets loaded for an unknown `workspace_*` tool — and the loop returns on the first match. This is non-deterministic in spirit (relies on object key insertion order) and can load the wrong category, leaving the actually-needed category unloaded. Not a security issue, but a correctness/operational bug that may make tools silently unavailable.

## Recommendation

Replace the prefix fallback with explicit pattern-to-category mapping (e.g., `if (lowerName.startsWith('workspace_git_')) return loadCategory('git');`). Or remove the fuzzy fallback entirely — direct mapping covers all listed tools.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-05)
