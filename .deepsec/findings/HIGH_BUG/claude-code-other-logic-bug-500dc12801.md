# [HIGH_BUG] telemetry.query has no session_id filter — exported trajectories silently corrupted

**File:** [`src/training/trajectory-compressor.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/training/trajectory-compressor.js#L108-L174) (lines 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 158, 173, 174)
**Project:** claude-code
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Finding

Both sessionTier() (line 109) and buildTrajectory() (line 158) call telemetry.query({ limit: 50 }) / telemetry.query({ limit: 100 }) and then filter the returned rows by session_id in JS. However, telemetry.query in src/routing/telemetry.js (lines 218-247) only supports `provider`, `tier`, `since`, and `limit` filters — there is NO session_id filter. The SQL it executes is `SELECT * FROM routing_telemetry [WHERE …] ORDER BY timestamp DESC LIMIT N`, returning the globally most-recent N rows. For any session whose telemetry is not in the top-50/100 most-recent rows globally (i.e. virtually every older session, or any session under realistic concurrent traffic where >100 telemetry rows are written before the export runs), the JS-side .filter(r => r.session_id === session.id) returns an empty array. The cascading effects in buildTrajectory(): `tier` becomes null; `complexityAvg` becomes null; `last` is undefined → `model_used` and `provider_used` become null; `tokens_in/tokens_out/latency_ms` reduce to 0 from the `{ tokens_in: 0, … }` seed; and most critically `errorRow = teleRows.find(r => r.error_type)` is undefined, so `outcome` is hardcoded to 'success' even for sessions that errored. In sessionTier(), null is returned, so the `--tier COMPLEX` (etc.) filter at line 101 silently excludes legitimate sessions, producing an empty or skewed export. This corrupts fine-tuning labels (outcome and tier) without any visible error.

## Recommendation

Extend telemetry.query (in src/routing/telemetry.js) to accept a `session_id` filter and add a SQLite index on (session_id, timestamp). Then change the trajectory-compressor calls to telemetry.query({ session_id: session.id, limit: 1000 }). Alternatively, prepare a session-scoped query directly inside trajectory-compressor.js using the shared db handle: `SELECT * FROM routing_telemetry WHERE session_id = ? ORDER BY timestamp DESC`. Add a regression test that creates >100 telemetry rows across multiple sessions, then exports trajectories for an older session and asserts that tier/model_used/outcome are populated.
