# [BUG] Worker initialization timeout leaves dangling Worker reference and unhandled rejection

**File:** [`src/workers/pool.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/workers/pool.js#L59-L140) (lines 59, 78, 81, 131, 138, 140)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

In `_createWorker` (L59-86), if a Worker fails to send the `ready` message within 5 seconds, the timeout at L81-84 rejects the init promise but does not call `worker.terminate()` and does not clear the `error`/`exit` listeners. The `worker` instance is already stored in `this.workers[id]` at L78 before the readiness handshake completes, so the dangling Worker stays in the pool array and can later receive `error`/`exit` events that will trigger `_handleExit` to spawn a replacement. Meanwhile, in `_handleExit` (L131-144), if `_createWorker(index)` rejects (e.g., persistent worker startup failure), the `.catch` at L140 logs the error but the `this.workers[index]` slot still holds the *old* dead worker reference, so `_getAvailableWorker` will iterate over a worker with `busy === false` (default) and dispatch tasks that can never be processed. Not security-relevant, but a reliability/availability bug.

## Recommendation

On init timeout, call `worker.terminate()` and remove the dead worker from `this.workers[id]`. In `_handleExit`'s replacement failure path, either retry with backoff or null out `this.workers[index]` and update `_getAvailableWorker` to skip null slots.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-05)
