# [BUG] Async singleton race exposes uninitialized ModelRegistry

**File:** [`src/routing/model-registry.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/routing/model-registry.js#L72-L415) (lines 72, 89, 412, 413, 414, 415)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-race-condition`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

getModelRegistry() sets `instance = new ModelRegistry()` synchronously, then awaits instance.initialize(). A second caller entering the function during the await sees `instance` already set (truthy) and returns it immediately, even though loaded === false and modelIndex is empty. Any caller that uses the returned instance during this window — e.g. getCost() — will fall through every lookup and return DEFAULT_COST with source='default', producing wrong pricing/context limits silently. Same race exists inside instance.initialize() itself: if two concurrent initialize() calls happen, the `if (this.loaded) return;` check passes for both before _fetchAll completes, causing duplicate network fetches against LITELLM_URL and MODELS_DEV_URL plus a duplicate cache write.

## Recommendation

Cache the in-flight initialization promise: replace the singleton with `if (!initPromise) initPromise = (async () => { instance = new ModelRegistry(); await instance.initialize(); return instance; })(); return initPromise;`. Inside initialize(), guard re-entry the same way with a memoized fetch promise so concurrent _fetchAll calls share a single network roundtrip.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
