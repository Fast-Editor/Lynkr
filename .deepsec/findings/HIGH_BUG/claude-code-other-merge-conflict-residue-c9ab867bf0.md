# [HIGH_BUG] Unresolved Git merge conflict and duplicate prepareFTS5Query function

**File:** [`src/memory/search.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/memory/search.js#L66-L308) (lines 66, 145, 263, 264, 267, 308)
**Project:** claude-code
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-merge-conflict-residue`

## Owners

**Suggested assignee:** `hillct@users.noreply.github.com` _(via last-committer)_

## Finding

Line 264 contains a literal '=======' Git merge conflict marker buried inside a JSDoc comment block (it is not a syntax error only because it sits between /** and */). As a direct consequence the function `prepareFTS5Query` is declared twice — once at lines 66-145 (the newer, hardened implementation) and again at lines 267-308 (the older implementation). Because JavaScript function declarations within the same scope are hoisted and the later declaration overrides the earlier one, every call site (searchMemories at L171, the module export at L424) and any test that imports `prepareFTS5Query` actually invokes the OLDER version. The newer version's safety protections — MAX_QUERY_LENGTH=1000 length cap (L70-76), MAX_OR_TERMS=50 cap on OR-chain expansion (L119, DoS protection), the OR-of-individually-quoted-words strategy designed to fix 'fts5: syntax error near ,' on SQLite 3.46+ — are entirely unreachable. This is a botched merge resolution that ships a known-broken state and silently regresses an intentional security/robustness fix.

## Recommendation

Delete the duplicate (older) prepareFTS5Query at lines 267-308 along with the corrupt comment at lines 261-265, and verify the test suite exercises the surviving implementation. Add a CI lint or an ESLint rule (e.g. no-redeclare) to prevent this class of merge-conflict shipping again, and add a grep guard in CI for '<<<<<<<' / '=======' / '>>>>>>>' anywhere in the source tree.

## Recent committers (`git log`)

- hillct <hillct@users.noreply.github.com> (2026-01-25)
- MichaelAnders <developer@call-home.ch> (2026-01-24)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-29)
