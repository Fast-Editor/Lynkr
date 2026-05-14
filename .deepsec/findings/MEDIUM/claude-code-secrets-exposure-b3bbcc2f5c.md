# [MEDIUM] Missing .dockerignore allows .env secrets into build-stage image

**File:** [`Dockerfile`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/Dockerfile#L16) (lines 16)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `secrets-exposure`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

The repository has no .dockerignore file (verified via filesystem listing). Line 16 of the Dockerfile (`COPY . .`) executes inside the `build` stage and will copy any developer-side `.env` / `.env.test` files — which contain real, active API keys (Azure OpenAI, Moonshot, TinyFish, Databricks per the scanner) — into the build-stage image layer. While the runtime stage at lines 41-46 only copies a curated subset (index.js, package.json, node_modules, src, config, bin, scripts/setup.js) and therefore the final runtime image does not include .env, multi-stage Docker builds do not erase intermediate layers from caches or registries. If the build stage is ever pushed (e.g., for CI caching, BuildKit cache exports, or a tagged build target), the secrets leak. Additionally, the build context itself is transmitted to the Docker daemon, so secrets are exposed to anyone with daemon access during build.

## Recommendation

Create a .dockerignore at the repo root that excludes at minimum: .env, .env.*, .git, node_modules, *.log, data/, logs/, .deepsec/, test files, and any local-only configuration. Additionally, rotate any keys that may have been included in previously built images. Consider using BuildKit secrets (`--mount=type=secret`) for build-time secrets rather than relying on env files.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
- hillct <hillct@users.noreply.github.com> (2026-01-30)
