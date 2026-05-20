# [MEDIUM] Base images use mutable tags instead of pinned digests

**File:** [`Dockerfile`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/Dockerfile#L4-L22) (lines 4, 22)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `dockerfile-from-mutable-tag`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

Both `FROM node:24-alpine` declarations (lines 4 and 22) reference a mutable tag. The `node:24-alpine` tag is updated by upstream maintainers, meaning the same Dockerfile can produce different images over time. This breaks reproducibility and creates a supply-chain attack window: a compromise of the upstream registry or image-signing infrastructure would propagate to any rebuild. Reproducible builds and supply-chain integrity require digest pinning.

## Recommendation

Pin both FROM lines to immutable digests, e.g., `FROM node:24-alpine@sha256:<digest> AS build`. Use Dependabot or Renovate to update the digest on a controlled cadence so security patches still flow in deliberately rather than implicitly on every rebuild.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
- hillct <hillct@users.noreply.github.com> (2026-01-30)
