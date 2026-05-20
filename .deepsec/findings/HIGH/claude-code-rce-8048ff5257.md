# [HIGH] workspace_test_run forwards LLM-controlled cwd, env, and args to a child process unchecked

**File:** [`src/tools/tests.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/tests.js#L42-L49) (lines 42, 47, 48, 49)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `rce`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The handler at L37-71 passes user-controlled args.cwd (L48), args.env (L49), and args.args (L47) directly to runWorkspaceTests, which (in src/tests/index.js L48-77) spreads `env` straight into runEnv (L63-66) and forwards `cwd` and `args` to runProcess unmodified. The command itself is locked to a server-configured profile/defaultCommand, but the test harness is overwhelmingly something like `npm test`, `pytest`, `pnpm test`, or `make test` — all of which will happily execute arbitrary scripts in whatever cwd they are launched in (e.g. arbitrary `package.json` scripts, `conftest.py`, `Makefile`). Combined with attacker-controlled env, this is full RCE in the agent's process context: setting `cwd` to a directory the attacker created (via fs_write — see workspace traversal finding) lets `npm test` run arbitrary lifecycle scripts; setting env.PATH=/tmp/evil, env.NODE_OPTIONS='--require /tmp/evil.js', or env.LD_PRELOAD=/tmp/evil.so substitutes commands or hijacks the runtime. Because the LLM produces these arguments, prompt injection (which is highly plausible given the agent's web_agent and fs_read tools ingest external content) is enough to trigger this. There is no allowlist on cwd (no workspace boundary check), no env-key filter, and no arg validation.

## Recommendation

Constrain cwd to paths inside the workspace (using a fixed prefix check that handles path.sep). Enforce an allowlist of safe env keys (e.g. CI, NODE_ENV, TEST_FILTER) and strip dangerous ones (PATH, LD_*, NODE_OPTIONS, DYLD_*, PYTHONSTARTUP, PERL5OPT, etc.). Validate args against per-profile patterns or refuse extra args entirely. Document that test profiles run untrusted code paths and require explicit human approval.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
