# [BUG] Late worker response after task timeout corrupts busy-state, causing worker over-assignment

**File:** [`src/workers/pool.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/workers/pool.js#L88-L181) (lines 88, 112, 113, 114, 175, 181)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-race-condition`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

When a task times out, the timeout handler at L175-184 sets `worker.busy = false` and calls `_processQueue()`, allowing the pool to assign a new task to that worker. The original task is NOT cancelled on the worker thread — it continues running and will eventually post a result back. When that late response arrives, `_handleMessage` at L88-115 looks up `pendingTasks.get(taskId)` (which has already been deleted by the timeout handler at L178), correctly skips the resolve/reject block, but then UNCONDITIONALLY executes `worker.busy = false` at L112 and `_processQueue()` at L114. If the worker is currently processing a *different* task (assigned after the timeout), the busy flag is incorrectly cleared and yet another task can be dispatched to the same worker, producing two (or more) concurrent in-flight tasks per worker. This breaks the load-balancer in `_getAvailableWorker` (L146-159), which uses `worker.busy` and `worker.taskCount` to pick the least-loaded worker. Effects: degraded throughput under timeout pressure, worker queues that grow inside worker_threads, and skewed `worker.taskCount` accounting because the increment at L113 fires for every late message. Not security-relevant — there is no cross-task data leak because results are still keyed by `taskId` in `pendingTasks` — but a real correctness bug.

## Recommendation

Only clear `worker.busy` in `_handleMessage` when the pending entry was found (i.e., move L112-114 inside the `if (pending)` block), or track task assignment per-worker (e.g., `worker.currentTaskId`) and only clear busy when the message taskId matches the worker's current assignment. Optionally also terminate/replace the worker on timeout instead of leaving the timed-out task running on it.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-05)
