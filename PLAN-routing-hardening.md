# PLAN: Routing Hardening — Sticky Sessions, De-escalation, Closed Feedback Loop

Implementation plan for five verified defects in the routing subsystem. Written to be executed
workstream-by-workstream by a coding agent. Each workstream is independently shippable; follow
the order given (later workstreams depend on schema/plumbing from earlier ones).

## Status

- [x] **WS0 — Schema + observability plumbing** (shipped)
- [x] **WS1 — Cache-aware sticky sessions** (shipped)
- [x] **WS1.5 — Content-fingerprint sessions + upward-drift re-pin** (shipped 2026-07-07)
- [x] **WS2 — Escalation ledger + de-escalation** (shipped)
- [x] **WS3 — Client-aware agentic detection** (shipped)
- [x] **WS4 — Propensity + candidates logging** (shipped)
- [x] **WS5 — Close the learning loop** (shipped)

### WS2 — done
- `telemetry.getEscalationStats()` groups by escalation_source (count / cost / input_tokens / avg quality); surfaced in `getRoutingStats()`.
- `telemetry.getQualityByTierAndType()` powers the de-escalator's evidence check.
- kNN-ambiguous leash in `src/routing/index.js`: escalate only when telemetry's `underProvisionedPct >= 2%`; otherwise keep the current tier (method suffix `+knn_ambiguous_kept`). Fail-open to legacy escalation if telemetry lookup fails.
- `src/routing/deescalator.js` — fixed thresholds (MIN_SAMPLES=30, MIN_QUALITY=70, MAX_ERROR_RATE=0.05, 7-day window, 60s cache).
- Registered `deescalate-v1` shadow policy via `shadow-mode.registerPolicy`.
- Live-wire is evidence-gated (no feature flag): applied after tier mapping, before cost-optimizer, only when risk!=high AND no upward escalations AND the deescalator returns a lower tier (which itself requires the >=30 rows / >=70 quality / <5% error proof). Sets `escalation_source='deescalation'` + `demoted_from=<original tier>`.
- Tests: `test/deescalator.test.js`, extended `test/knn-ambiguous-escalate.test.js`.

### WS1.5 — content-fingerprint sessions + upward-drift re-pin (2026-07-07)

A live `lynkr wrap claude` session exposed that WS1 sticky sessions never fired for Claude Code at all, and surfaced a second design gap once they did. Root cause + two fixes:

**Defect 1 — no session identity.** Claude Code sends no session header/body field. Lynkr's session middleware fell back to `crypto.randomUUID()` per request → live telemetry showed **278 distinct session_ids across 286 requests**. Every request looked like a new session, so `checkSessionPin` always returned `no_pin` and every WS1 code path was dead in practice.

**Fix A — content fingerprint** (`src/api/middleware/session.js`): when no session id is supplied, derive one as `'fp-' + sha256(first user message + system-prompt head[500] + user-agent)[0..32]`. Clients that replay full history each turn (Claude Code, Cursor) map every turn of one conversation to the same id. `<system-reminder>` blocks are stripped before hashing (their contents vary between replays); structured content blocks hash like plain strings; no user text → fall back to UUID (old behaviour). Fingerprinted sessions skip session-store DB persistence like generated UUIDs did (the WS1 pin store lives in telemetry.db). Kill-switch: `LYNKR_SESSION_FINGERPRINT=false`.

**Defect 2 — pins can't ratchet up.** With identity fixed, a session opened with "Hi" pins SIMPLE, and WS1's re-decide triggers (compaction / risk / context / vision / economics) all miss the most common case: the *real task* arriving on turn 2 ("plan a refactor of the whole repo" — observed live scoring 45 while pinned to a tier whose ceiling is 25). The session stayed on `minimax-m2.5:cloud` for a Sonnet-class task, subagents inherited nothing, and the weak model lost conversational context entirely.

**Fix B — upward score drift** (`src/routing/index.js` `checkPinScoreDrift`): on `guards_passed` pin serves only (never `tool_history` — switching mid-tool-exchange breaks tool-call ids), heuristically score the latest user message in isolation (same shape as the intent scorer: stripped text + tools + client profile; no embeddings/kNN/bandit). If `score > pinned tier's calibrated ceiling + LYNKR_PIN_DRIFT_MARGIN` (default 15 ≈ half a tier band), fall through to full routing with `switch_reason='score_drift'` and re-pin when the fresh tier ≥ pinned tier. One-directional by design: downward drift stays pinned (the economic-downgrade rule owns that, since switching pays a cold-cache re-read). Wired into both `determineProviderSmart` (pin-serve branch) and the OAuth intent path in `src/api/router.js`.

**Tests** — `test/session-fingerprint.test.js` (14): fingerprint stability across turns, distinct convos/UAs differ, reminder-stripping invariance, structured-vs-string content equivalence, empty/absent-text null fallbacks, feature-flag off, header-precedence in `extractSessionId`, UUID fallback; drift: REASONING never drifts, tool-result-only turns never drift, null/missing pins never throw, verdict consistent with the scorer's own output (wiring test, not scorer test), trivial follow-up stays pinned. Added to `test:unit`. Full suite: **1018/1021** (same 3 pre-existing undici mock failures).

**Live verification (port 8081, 2026-07-07):**
- 3-turn no-header conversation → **1** fingerprint (`fp-…`) across all rows (pre-fix: 1 id per request); turn 3 served `session_pin` with `pinned=1`.
- Risk-bearing turn 2 escaped the SIMPLE pin via the existing guard path (guards win over drift, correct precedence).
- Drift branch end-to-end (forced with `LYNKR_PIN_DRIFT_MARGIN=5` since bare-curl payloads score lower than real Claude Code traffic, which carries MCP tools): `freshScore 36 > ceiling 25 + 5` → re-decided SIMPLE→COMPLEX, telemetry row stamped `switch_reason='score_drift'`. Restored default margin after the demo; real traffic equivalents scored 43-45 in the failing session, which clears the default threshold of 40.

**Follow-up worth noting:** subagent requests have *different first messages* than their parent conversation, so they fingerprint as separate sessions and re-route independently — fingerprinting fixes turn-to-turn identity, not parent→child tier inheritance. If subagent under-tiering keeps hurting, the practical lever remains pointing `TIER_MEDIUM` at a stronger model.

### Post-ship follow-up: risk classifier scanned harness-injected text (2026-07-07)

Live repro: a conversation of "Hi" → "23+45" routed the arithmetic turn to **subscription-passthrough COMPLEX** with `instructionHits: ["credential","security"]` — words the user never typed. Root cause: `analyzeRisk` scans the last user message via `extractContent`, and Claude Code appends `<system-reminder>` blocks (CLAUDE.md contents, "7 MCP servers need authentication" notices) to exactly that message. Injected boilerplate tripped the high-risk keyword scan → forced COMPLEX → the risk decision was then **written as the session pin** (score 100), so every later turn of the conversation stuck to the expensive model. 36 poisoned score-100 pins were found in the live pin store.

Fix (`src/routing/risk-analyzer.js` + `src/routing/risk-classifier.js`): new `stripSystemReminders(text)` applied to the instruction text before both the keyword scan and the path extraction, and to the LR classifier's feature text. Genuinely risky *typed* text still fires (covered by test); paths reached via real `tool_use` blocks still count (separate extraction path, untouched). This brings the risk scan in line with the intent scorers, which have stripped reminders since WS3. Tests: 7 new cases in `test/risk-analyzer.test.js` (trivial+reminder stays low, reminder paths don't leak, typed risk still fires, structured blocks, multiple blocks, tool_use survival). Full suite **1024/1027** (same 3 pre-existing undici failures). Live verification post-fix: the exact repro payload routes `SIMPLE → ollama`.

### Post-ship follow-up: side requests poisoned session pins (2026-07-07)

Second pin-poisoning vector, found live minutes after the reminder-stripping fix. Claude Code fires internal background calls (title generation, summarization, memory extraction) that REPLAY the full conversation — so they share the conversation's content fingerprint — wrapped in harness prompts plus transcript text. A summarization side request replayed tool outputs from the repo itself (which is full of "security"/"credential"/"auth" strings, untagged by `<system-reminder>`), tripped the risk guard, re-routed COMPLEX (score 100), and overwrote the conversation's pin at `writeSessionPin` — so the user's next trivial turn ("read and explain the repo", true score 14/SIMPLE) served the subscription model.

Fix (`src/api/router.js` OAuth path): side requests are detected by the absence of a tools array — every interactive Claude Code turn attaches its ~13-tool loadout; internal calls attach none. Tool-less requests may still READ the pin (cheap serving is fine) but (a) never WRITE it, and (b) skip the WS1.5 drift check (scoring harness wrapper text is meaningless). Interactive turns are unaffected.

Known residual (accepted): a side request serving the pin still refreshes the pin's `messageCount` via `checkSessionPin`'s keep-alive, which can make the next real turn look compacted and burn one fast-path re-route — mild latency cost, never a wrong model, and the re-route re-pins from the real turn. Full suite 1024/1027 post-change.

### Post-ship follow-up: hardening batch — risk pins, suggestion mode, badge echo (2026-07-07)

Third live poisoning incident, plus a batch of known-issue fixes.

**Incident**: "Hi" → "321+21" served COMPLEX (moonshot kimi, score 100). Telemetry caught the poisoner exactly: a **suggestion-mode** request (`[SUGGESTION MODE: Suggest what the user might naturally type next…]`, `tool_count=13`, `escalation_source=risk`). Suggestion mode defeats BOTH earlier defenses: it carries the full tool loadout (so the tool-less side-request check misses it) and its risk words live in its own wrapper instructions (not `<system-reminder>` tags, so stripping misses it). It replays the conversation → shares the fingerprint → risk-forced COMPLEX(100) → pin overwritten → next real turn served expensive.

**Fixes:**
1. **`writeSessionPin` structurally refuses risk-forced decisions** (`src/routing/index.js`): `method === 'risk'`, `method.startsWith('risk+')`, or `escalation_source === 'risk'` → no pin write. Rationale: risk analysis re-runs on every turn (guards + inner routing), so escalating THIS turn never needed a pin; pinning only created the one-way ratchet. This kills the entire poisoning class regardless of which future harness wrapper trips risk.
2. **Side-request detection extended + static routing** (`src/api/router.js`): `isSideRequest = tool-less OR last user message contains '[SUGGESTION MODE:'`. Side requests now short-circuit to a static `SIMPLE` selection (`method='side_request[_suggestion]'`) — no pin read (a COMPLEX-pinned convo would burn expensive tokens on autocomplete), no pin write, no intent scoring of wrapper text, no subscription-passthrough quota burn. Upstream overflow rescued by the tier-fallback chain.
3. **Badge stripping bugs** (`src/clients/databricks.js` `stripLynkrBadges`): (a) array branch dropped any block whose text *started* with a badge — clients that merge blocks on replay would lose the model's real answer; now strips the prefix and keeps the remainder. (b) badge-only placeholder was `text: ''` — Anthropic rejects empty text blocks, which is the mechanism behind the interrupted-response badge echo loop; placeholder is now `'…'` (string branch got the same guard).
4. **Tool-less serves don't refresh pins** (`src/routing/index.js` `checkSessionPin`): side requests may be served from a pin but no longer update its `ts`/`messageCount`, eliminating the phantom-compaction re-route their inflated message counts caused.

**Tests**: `test/side-request-guards.test.js` (11) — risk-pin refusal (4 method/source shapes + non-misfire), badge stripping (merged block preserved, badge-only placeholders non-empty, siblings kept, user messages untouched), tool-less refresh skip. Full suite **1035/1038** (same 3 pre-existing undici failures).

**Deferred (documented, not fixed):** MCP tool load inflating per-message scores (drift jitter for MCP-heavy users); fingerprint collisions across identical-opener conversations; semantic-cache-served traffic invisible to telemetry/feedback; replay-regression suite from captured live traffic (the systematic catch-all for this bug class).

**Tool-history over-match (same day, found BY the new badge):** `payloadHasToolHistory` matched tool blocks **anywhere** in the conversation, so one tool call permanently welded a session to its pin — every later frame (including freshly typed user messages) took the unconditional `tool_history` serve, silently disabling the risk/context/vision guards AND the WS1.5 drift check for the rest of the session. The new `score N · pin@N` badge exposed it immediately: a heavyweight typed ask displayed `score 0 · pin@0` (drift never ran). Fixed to true mid-exchange semantics: only a LAST message carrying `tool_result`/`tool_use` blocks is unswitchable; completed exchanges earlier in history are safe to carry across providers. Tests updated in `test/session-affinity.test.js` (+ new completed-exchange regression case). Full suite 1038/1041.

**Force-cloud bypass on pinned turns (same day):** "refactor the entire codebase give me a plan" scored 28, missed the drift threshold by 1 (margin had just been env-tuned to 5 → threshold 29), and rode a SIMPLE pin — even though the phrase matches `FORCE_CLOUD_PATTERNS`, an absolute override full routing always honours. Pinned turns never reached full routing, so the force patterns were dead there. Fix: `checkPinScoreDrift` now tests the stripped TYPED text against `shouldForceCloud` before the score comparison and returns `{drift:true, forced:'force_cloud', freshScore:100}` on match — the caller falls through to full routing where the pattern fires properly. `force_local` deliberately not checked (downward stays pinned per economics). Reminder-injected phrases can't trigger it (text is stripped first — covered by test). `LYNKR_PIN_DRIFT_MARGIN=5` set in the user's `.env` (+ documented in `.env.example`); code default stays 15. Full suite 1040/1043.

**Wrap session stats never worked (same day):** `lynkr wrap`'s exit summary read `metrics.totalRequests`/`requestCount` — fields that don't exist; `getMetrics()` returns snake_case (`requests_total`, `tokens_total`, `cost_usd_total`). `hasRequests` was therefore always false and every session ended "No requests tracked" since the feature shipped. (A previous "fix" added a `recordRequest` call in router.js — right counter, but the reader was matching the wrong field names.) Rewritten: `showSessionStats(port)` now fetches `/metrics/observability` over HTTP first (correct under cluster mode, where workers hold the counters) with an in-process fallback, and renders requests/errors, in/out tokens, est. cost, and p95 latency from the real field names. Both call sites pass the port. `test/wrap.test.js` 6/6.

**Force-cloud ignored tier config → self-proxy hang (same day):** the newly-reachable force-cloud path exposed a dormant bug: the `shouldForceCloud` branch in `_determineProviderSmartInner` used `getBestCloudProvider()` — a credential-priority list starting with databricks-if-credentialed. Pure tier-routing installs carry DUMMY databricks values to pass startup validation (`DATABRICKS_API_BASE=http://localhost:8081` — Lynkr's own port), so "Do an architecture review of the orchestrator" routed to databricks → **Lynkr proxying to itself** → hang, badge `— → — (databricks) · score 100`. The `force_local` branch received a tier-aware fix long ago; `force_cloud` never did. Fix: when `modelTiers.enabled`, force-cloud selects the COMPLEX tier's configured model (`selector.selectModel('COMPLEX')`), falling back to the legacy credential list only when tier routing is off. Also hardened the user's `.env`: dummy databricks base moved from `:8081` to `http://127.0.0.1:9` (fails fast, can never self-loop). Regression test in `test/session-fingerprint.test.js`. Full suite 1041/1044.

**AUTONOMOUS-agentic path: same credential-list landmine (same day):** investigating "when does REASONING trigger" found the AUTONOMOUS early-return in `_determineProviderSmartInner` had the identical bug as force-cloud: it bypassed tier mapping (so its declared `minTier: 'REASONING'` never applied) and picked from `getBestCloudProvider()`'s credential list. Fixed the same way: with tier routing on, AUTONOMOUS serves the REASONING tier's configured model (`tier: 'REASONING'`); legacy credential-list fallback only when tiers are off. Full suite 1041/1044.

**Test suite was clobbering the production kNN index (same day):** `test/knn-cold-start.test.js`'s save-threshold test stubbed `save()` as `count++ THEN call the real save` — and `KnnRouter.INDEX_DIR` is a module constant pointing at the production `data/knn/`. Every `npm run test:unit` run overwrote the live learned index with ~100 dim-4 `p:m` fixtures, silencing kNN routing (and explaining the earlier "dim 4 pollution" incident, which was mis-attributed to historical debris). Fixed: the stub counts only, never calls through. Production index wiped clean; regrows from live traffic via WS5 feedback. Full suite verified to leave `data/knn/` untouched.

**Side-request guard over-matched generic API traffic (2026-07-08, caught by user's benchmark):** the tool-less-⇒-side-request discriminator was only valid for Claude Code traffic. Generic API clients (curl, benchmarks, SDKs) legitimately send bare messages; the guard force-SIMPLE'd them via `method='side_request'`, bypassing risk/scoring entirely — a benchmark's security-analysis scenario (contains "security"+"jwt", should be risk-forced COMPLEX) landed on SIMPLE minimax. Fix (`src/api/router.js`): tool-less traffic is side traffic only when a client profile was detected (harness UA/tool fingerprint); suggestion-mode tags remain harness evidence by themselves. Verified live: the exact benchmark prompt now routes `risk+window COMPLEX`. Full suite 1041/1044.

**Badge UX follow-up (same day):** pinned turns used to re-display the score that created the pin — a wall of "score 0" after a "Hi" opener read as the router being asleep. The badge now shows the drift check's fresh per-message score (already computed on every guards_passed pinned turn) with the pin's original score as a `pin@N` suffix: `score 14 · pin@0`. `tool_history` serves keep the old display (drift is skipped there by design). Threaded `_pinScore` → `buildInteractionBlock().pin_score` → three badge templates in `src/api/router.js`. Tests in `test/side-request-guards.test.js` (13 total). Full suite 1037/1040.

### Post-ship follow-ups WS4 + WS5 (2026-07-07)

The initial WS4/WS5 ship passed all unit tests but a live gateway session (Claude Code OAuth intent routing to Ollama + Azure) surfaced three end-to-end gaps that unit tests didn't catch. All three land on the OAuth intent path — the direct `/v1/messages` handler that calls `determineProviderSmart` was fine; the subscription-forced path stripped WS4/WS5 fields between decision and telemetry.

1. **`pickTierByIntent` stripped WS4/WS5 fields on return** (`src/api/router.js:173-193`). Function returned a hand-built decision shape forwarding only WS0 columns (`base_tier`, `escalation_source`). Downstream `databricks.js` had no `propensity` / `candidates` / `_banditContext` / `_queryEmbedding` to record → every telemetry row on OAuth traffic had `propensity=NULL` (0/151 rows had propensity in live data, breaking WS4 off-policy evaluation). Fix: forward all five new fields on the return object with sensible defaults (`propensity ?? 1.0`, single-entry candidates array pointing at the served pair).

2. **OAuth handler didn't stash context on `req.body`** (`src/api/router.js:965-970`). The handler stashed WS0 fields on `req.body._baseTier` / `._escalationSource` etc. for the downstream client to read, but not the new WS4/WS5 ones. Fix: added guarded assignments — `req.body._propensity`, `._candidates`, `._banditContext`, `._queryEmbedding`, `._queryText`. All underscored so `_stripInternalFields` in `databricks.js:69` scrubs them before the outbound provider request (verified — no risk of leaking a 12-D bandit context vector or 768-D embedding to Anthropic/Ollama).

3. **`databricks.js` forced-provider reconstitution didn't read them** (`src/clients/databricks.js:2548-2578`). The `options.forceProvider` branch built `routingResult` by reading `body._*` fields but only picked up WS0 columns. Fix: added five more field reads with the same deterministic fallbacks. Fallback is important because a stale gateway (started before the router.js edit) could send bodies without the new fields — the deterministic default keeps telemetry rows valid.

4. **`_queryEmbedding` never set on early-return decision paths** (`src/routing/index.js`). WS5.5's original wire built `queryText` + `queryEmbedding` inside the kNN block, halfway down `_determineProviderSmartInner`. Every early-return path (static, risk-forced, force-local, force-cloud, autonomous-agentic) short-circuited *before* that block, so those decisions had `_queryEmbedding=undefined`. Live symptom: every risk-classifier hit (e.g., prompts containing "encrypt") produced `hasEmbedding: false` in feedback logs → kNN online growth never learned from risk-tier traffic. Fix: **hoisted** the query-text extraction + embedding capture to the top of `_determineProviderSmartInner`, right after risk analysis. Cost is one Ollama `/api/embeddings` call (~200ms) per routing decision, applied uniformly. Every early-return decision object now attaches `_queryEmbedding` + `_queryText`, and the deep kNN block re-uses the captured vector instead of re-embedding.

**Live verification (2026-07-07, port 8081, fresh state → 100 sequential cache-busted requests):**
```
completed HTTP 200s:     100
reward observations:      75    (25/50/75 save cadence firing)
telemetry rows:           88    (12 hit semantic cache)
kNN entries on disk:      50    (save-every-50 threshold fired)
feedback events:          88
hasEmbedding=true:        88    (100% coverage — was 0% pre-fix)
propensity coverage:      88/88 (100% — was 0/151 pre-fix)
candidates coverage:      88/88 (100%)
degradation:              null  (no subsystem broken)
```

**Manual test coverage** (tests 7-15 executed against live gateway on 2026-07-07):
- T7 — feedback path never poisons response under corrupt state ✅
- T8 — malformed state file → clean fallback ✅
- T9a/b — calibration scheduler arms + disable flag skips ✅
- T10 — insufficient data → skip with `insufficient_samples` reason ✅
- T11 — force calibration seeds → SIMPLE upper shrinks 25→24, MEDIUM auto-stitches to 25 ✅
- T12 — `reloadCalibratedThresholds()` remaps `getTier()` immediately ✅
- T13 — CLI + module produce byte-identical output (ignoring `calibratedAt`) ✅
- T14 — full end-to-end learning cycle produces all artifacts ✅
- T15 — clean teardown ✅

**Regression tests**: `test/routing-propensity.test.js`, `test/wrap.test.js`, `test/init.test.js`, `test/routing.test.js`, `test/strip-internal-fields.test.js` — 37/37 pass after the fixes. Full suite unchanged from the WS5 ship (1004/1007, same pre-existing undici mock failures).

**Hardcoding pass (2026-07-07, post-WS5)**: `LYNKR_AUTO_CALIBRATE` and `LYNKR_TELEMETRY_DB_PATH` env knobs removed at user request. Auto-calibration is unconditionally armed in `src/server.js` (it self-gates on telemetry sample count); the telemetry DB path is hardcoded to `<cwd>/.lynkr/telemetry.db` in `src/routing/telemetry.js`. Tests now isolate their DBs via exported test-only helpers `telemetry._setDbPathForTests()` / `._disableForTests()` / `._resetForTests()` (6 test files migrated). `.env`, `.env.example`, `Dockerfile`, `docker-compose.yml` updated to note the hardcoding. Full suite 1004/1007 post-change.

**Known caveats not addressed** (out of scope for this fix):
- Semantic-cache-served responses bypass the routing/feedback pipeline entirely. Cache hits produce no telemetry row and no feedback event by design. In live traffic this is dominant (~65% cache-served on repeated prompts). Any future feedback-completeness work will need to fork off the semantic-cache path too.
- `knn-router.js` `beforeExit` save doesn't fire on SIGTERM (Node runs `beforeExit` only when the event loop empties naturally). `SAVE_EVERY_N_ADDS=50` catches most growth incrementally so this is a slow leak, not a correctness bug. A `SIGTERM` handler that force-saves is a small follow-up.

### WS5 — done
- `src/routing/reward-pipeline.js` — added `_save()/_load()` mirroring the bandit pattern. State lives at `data/reward-state.json`, written every 25 `reward()` calls; `Infinity`/`-Infinity` ranges round-trip as `null` and re-hydrate on load. Malformed state on disk falls back cleanly to defaults.
- `src/routing/knn-router.js`:
  - `MIN_INDEX_SIZE` default 1000 → **100**. Env override retained (`LYNKR_KNN_MIN_INDEX_SIZE`).
  - `query()` now multiplies confidence by `min(1, size/DAMP_FULL_SIZE)` (`DAMP_FULL_SIZE=1000`) so a small index advises weakly — HIGH/LOW thresholds in `src/routing/index.js` treat sparse advice as ambiguous rather than trusting it.
  - New `embed(text)` public helper — returns the vector or null, memoised through the embedding cache.
  - `add()` persists every `SAVE_EVERY_N_ADDS=50` entries; graceful-exit `beforeExit` save bound once per process.
- `src/routing/index.js` — kNN block computes the query embedding once, reuses it for the search, and stashes it on the decision as `decision._queryEmbedding` + `decision._queryText`. Underscored so it never leaks through `getRoutingHeaders`. When the embedder is unavailable, both fields fall through as null and the feedback path does not add to the kNN index (per plan: only learn from requests that already paid for the embedding).
- `src/routing/feedback.js` (new) — `recordOutcome({routingResult, body, outcome})`:
  - Runs inside `setImmediate` so the response path is never blocked.
  - Computes `reward = quality − λ·norm_cost·100 − μ·norm_latency·100` via `getRewardPipeline()`.
  - Calls `bandit.update(tier, provider, model, ctx, reward)` IFF `_banditContext` + provider/model/tier present. First real caller of `bandit.update` (`src/routing/bandit.js:179` — zero callers pre-WS5).
  - Calls `kNN.add(embedding, meta)` IFF `_queryEmbedding` present AND quality is conclusive (≥ 70 positive, ≤ 40 negative). Mid-band (41-69) is deliberately skipped to avoid muddying advice.
  - Every subsystem is wrapped in its own try/catch → `degradation.record('feedback', err)`. An outer top-level guard catches even the `degradation` module blowing up. `recordOutcome()` never throws — verified by test that passes garbage (`null`, non-object) at the API surface.
- `src/clients/databricks.js` — imported `recordFeedbackOutcome` and wired all four `telemetry.record` sites: success, primary-failed-no-fallback, fallback-success, double-failure. Failed outcomes pass low quality scores through so the bandit learns negative signal.
- `src/routing/calibration.js` (new) — core of `scripts/calibrate-thresholds.js` extracted into `runCalibration({days, dryRun, dbPath, outputPath})`. Same bucketing + median-vs-floor rule, but callable from within the server process. The CLI script is now a thin wrapper preserving all existing behaviour.
- `src/routing/model-tiers.js` — new `reloadCalibratedThresholds()` re-reads the calibrated JSON into the singleton without a process restart.
- `src/server.js` — new auto-calibration scheduler: jittered first run at 30-90 minutes post-boot, then every 24 h. `setTimeout` + `setInterval` are `.unref()`d so they don't hold the process open. On success, hot-reloads via `reloadCalibratedThresholds()` and logs the old vs new ranges. On failure, `degradation.record('calibration', err)`.
- Tests (37 new, exhaustive):
  - `test/reward-pipeline.test.js` (8): clamp to [0, 100], λ+μ penalty math, missing-value defaults, negative-value rejection, quality default 50, persistence + reload, Infinity → null round-trip, malformed-state fallback.
  - `test/knn-cold-start.test.js` (10): constant exports, size-gate returns null, damping at small/mid/full/beyond-full index sizes, `embed()` no-throw contract + short-circuit on empty/non-string, `add()` triggers save every N entries.
  - `test/calibration.test.js` (6): insufficient samples → skip (no file written), missing DB → skip, bucket-below-floor → upper-bound shrinks + re-stitch, `dryRun=true` → no write, `reloadCalibratedThresholds()` picks up on-disk changes and re-maps `getTier()`, malformed file → defaults.
  - `test/feedback-loop.test.js` (13): missing routingResult no-ops, reward computed from outcome, bandit.update called only when `_banditContext` present, skipped when reward throws, kNN.add fires for ≥70 and ≤40 but not 41–69, kNN.add skipped without `_queryEmbedding`, never throws when every subsystem is broken (degradation counter increments), returns synchronously (work runs on setImmediate), swallows outer garbage inputs (null, non-object), exported thresholds equal plan.
- All four new test files added to `test:unit`. Full suite: **1004/1007** (same 3 pre-existing `test/web-tools.test.js` undici mock failures — no WS5 regressions).

### WS4 — done
- `src/routing/bandit.js` — `pick()` returns `propensity`: exploited pick has `1 − ε + ε/K`, explored pick has `ε/K` (both collapse to 1.0 when K=1 on the exploit branch). `explorationRate` promoted to a constructor option + instance property so tests can pin ε; `EXPLORATION_RATE` re-exported.
- `src/routing/index.js` — every decision-return site sets `propensity` + `candidates`:
  - Static (`tier_routing_disabled`), force-local (both tier + non-tier branches), force-cloud, risk-forced, autonomous-agentic, and pin-serve short-circuits all set `propensity: 1.0` with a single-entry `candidates` array matching the served (provider, model).
  - Main path: `banditPropensity` / `banditCandidates` / `banditContext` captured at the bandit call site regardless of whether the bandit's pick overrode the model. If a downstream override (deadline / tenant) later swapped the served model out of the bandit's candidate set, the decision collapses to `propensity=1.0` + single candidate so the logged propensity always describes the actually-served choice.
  - `decision._banditContext` (underscored) stashed for WS5's `bandit.update()` call; `getRoutingHeaders` picks named fields only so it never leaks.
- Databricks telemetry sites and columns were already in place from WS0 (`routingResult.propensity ?? null`, `routingResult.candidates ?? null`) — no changes needed there.
- Tests: extended `test/bandit.test.js` with 4 propensity cases (exploit branch, explore branch, K=1 collapse, Σ propensities = 1); new `test/routing-propensity.test.js` covering static / tier_config / risk-forced / session-pin decision paths. Both files added to `test:unit`.
- Full suite: 967/970 (same 3 pre-existing `test/web-tools.test.js` undici mock failures as WS3).

### WS3 — done
- `src/routing/client-profiles.js` — profiles for `claude-code`, `cursor`, `openai-codex`; user overrides via `data/client-profiles.json`. `detectClient({headers, payload})` = UA regex → tool-set fingerprint (≥80% match). `effectiveTools(payload, profile)` subtracts baseline. `allToolsAreBaseline(payload)` powers the unknown-harness guard.
- `src/routing/agentic-detector.js` — `detect(payload, opts.clientProfile?)` uses effective tools for Signals 1 & 2; unknown-harness guard zeroes tool-count signals when `tools.length >= 10` and every name is a known-baseline. Signals 3-6 unchanged.
- `src/api/router.js` — detects client once per `/v1/messages` request, stashes on `req.body._clientProfile`. `pickTierByIntent` passes the FULL tools array (slice(0,3) hack removed) plus the profile; each per-message intent payload inherits it.
- `src/routing/index.js` — `_determineProviderSmartInner` reads `payload._clientProfile || options.clientProfile` and threads into the detector.
- Tests: `test/client-profiles.test.js`.

### Post-ship follow-ups (2026-07-05)
The initial WS3 ship was verified against synthetic curl payloads, but a live Claude Code CLI session surfaced three regressions that needed fast fixes:

- **Complexity analyzer counted raw tools** (`src/routing/complexity-analyzer.js:428, :631, :859`). `scoreTools` and `calculateWeightedScore` used `payload.tools.length` directly, so a trivial follow-up like "what did I just say?" with 11 Claude Code baseline tools scored 46 → COMPLEX → subscription-passthrough. Fixed by adding `_effectiveTools(payload)` (mirrors the agentic detector's WS3 subtraction) and wiring it into both scoring paths + `meta.toolCount`/`breakdown.tools.count`.
- **`_sessionId` leaking to Ollama Cloud** as a 400 `Extra inputs are not permitted`. Added defense-in-depth strip at the last-hop chokepoint `performJsonRequest` (`src/clients/databricks.js:66`) and in the OAuth passthrough body (`src/api/router.js`). Tests: `test/strip-internal-fields.test.js`.
- **UA regex too narrow.** `client-profiles.js` only matched `/claude[-_]code/i`, but Claude Code CLI actually sends `user-agent: claude-cli/x.y.z` (see `auth-mode.js:50-59`'s `SUBSCRIPTION_UA_PREFIXES`). Widened to `/claude[-_](cli|code|vscode)/i` + tests covering `claude-cli/…` and `claude-vscode/…`.
- **Pin score display bug.** WS1 set `tier.score = null` when a pin served; the badge's `req._intentTier?.score ?? complexity.score` fallback then displayed the inflated full-body complexity score. Fixed by (a) persisting `score` on the pin (additive `ALTER TABLE session_pins ADD COLUMN score`), (b) restoring it in the pin-serve branch of `router.js`, and (c) replacing the `??` fallback with explicit logic that only uses `complexity.score` when the intent scorer didn't run at all.
- **New tests:** `test/complexity-tool-subtraction.test.js` (5), `test/strip-internal-fields.test.js` (5). All added to `test:unit`. Full suite: 954/957 (3 pre-existing `test/web-tools.test.js` undici mock failures).

### WS0 — done
- 6 columns added to `routing_telemetry` with additive migration (`base_tier`,
  `escalation_source`, `propensity`, `candidates`, `pinned`, `switch_reason`).
- `src/routing/degradation.js` — new registry, warn-once-per-hour, exposed via `getRoutingStats().degradation`.
- 10 silent `logger.debug` catch blocks in `src/routing/index.js` replaced with `degradation.record(...)`.
- Decision object now carries `base_tier`, `escalations[]`, `escalation_source`; threaded through all 4 `telemetry.record` sites in `src/clients/databricks.js`.
- Tests: `test/degradation.test.js`, `test/routing-telemetry-columns.test.js`.
- Prometheus wiring intentionally skipped (no `prom-client` in the tree) — TODO left in `degradation.js`.

### WS1 — done
- `src/routing/affinity-store.js` — SQLite-backed pin store sharing the telemetry DB handle via new `telemetry.getDb()`.
- `src/routing/session-affinity.js` — rewritten: memory Map as read-through cache; new `getPin` / `setPin` / `shouldRepin` API; 6h TTL via `LYNKR_STICKY_TTL_MS`; legacy `getPinned` / `setPinned` kept as compat.
- `src/routing/index.js` — new `checkSessionPin` / `writeSessionPin` shared by `determineProviderSmart` and the OAuth intent path. Fast path skips complexity/kNN/bandit on pin hit. Economic-downgrade guard (`LYNKR_SWITCH_MAX_PROMPT_TOKENS`, default 20k; ≥25% cheaper rule). Vision is `pinExempt`. Feature-gated by `LYNKR_STICKY_SESSIONS`.
- `src/api/router.js` — OAuth intent path consults the pin before `pickTierByIntent` and writes it after.
- `src/sessions/cleanup.js` — `runCleanup()` extended to also prune telemetry rows + expired pins on the same 5-min tick (previously `telemetry.cleanup()` had zero callers).
- Tests: `test/sticky-routing.test.js`, extended `test/session-affinity.test.js`.


## The five defects (verified against current code)

| # | Defect | Evidence |
|---|--------|----------|
| D1 | Escalation-only ratchets: kNN-ambiguous (+1 tier), vision guard, context validation, agentic minTier all escalate; nothing ever de-escalates or accounts for over-provisioning cost | `src/routing/index.js:352-359, 414-444, 450-474, 502-526` |
| D2 | Session affinity is provider-level, in-memory only, enforced only on tool-bearing turns; lost on restart | `src/routing/session-affinity.js` (Map at line 23), enforced at `src/routing/index.js:155-175` |
| D3 | Per-request re-routing ignores prompt-cache economics: a mid-session model switch cold-reads the whole conversation (~10x that turn's input cost) and is never priced in. Cost-optimizer compares sticker price only (`index.js:394-396`) | `src/routing/index.js:150-178` re-decides every turn |
| D4 | Learning loop never closes: `bandit.update()` has **zero callers**; `reward-pipeline.js` has **zero importers**; kNN index gated behind `MIN_INDEX_SIZE=1000` and never grows online; no propensity logged; every ML-path failure is a silent `logger.debug`; calibration is a manual external script | `src/routing/bandit.js:179`, `src/routing/reward-pipeline.js`, `src/routing/knn-router.js:35`, catch blocks in `src/routing/index.js` (lines 191, 299, 338, 409, 442, 471, 528, 587, 609, 632), `scripts/calibrate-thresholds.js` |
| D5 | Agentic detector inflates scores from Claude Code's ~11 always-attached tools; the `slice(0, 3)` workaround in `pickTierByIntent` is client-specific and discards real signal | `src/routing/agentic-detector.js:104-131`, hack at `src/api/router.js:71` |

## Global constraints (read before coding)

- **Style**: CommonJS (`require`/`module.exports`), singletons via `getX()` factory (see
  `bandit.js:241`), lazy `better-sqlite3` init guarded for optionalDependency absence (copy the
  pattern in `src/routing/telemetry.js:22-49`), non-fatal failures log via `logger.debug` and
  fall through, env flags prefixed `LYNKR_`, feature flags default-on unless risky.
- **Tests**: `node --test` files in `test/*.test.js`; run with
  `DATABRICKS_API_KEY=test-key DATABRICKS_API_BASE=http://test.com node --test test/<file>`.
  Use `telemetry._setDbPathForTests()` / `._disableForTests()` to point telemetry at a temp DB
  in tests (the old `LYNKR_TELEMETRY_DB_PATH` env override was removed in the hardcoding pass).
  Add each new test file to the `test:unit` list in `package.json`.
- **Do not touch**: the OAuth passthrough body path (`handleOauthPassthrough` in
  `src/api/router.js`) must stay byte-identical; `pickTierByIntent`'s per-message
  `determineProviderSmart` calls intentionally omit `_sessionId` — they must never read or
  write session pins.
- **Migrations**: `telemetry.db` schema changes follow the existing additive pattern —
  `PRAGMA table_info` check + `ALTER TABLE ADD COLUMN` (see `telemetry.js:130-137`). Never
  drop/rename columns.
- After each workstream: run the full `npm run test:unit` suite, not just the new tests.

## Rollout order and flags

| Order | WS | Risk | Flag (default) |
|-------|----|------|----------------|
| 1 | WS0 plumbing | none (additive) | — |
| 2 | WS1 sticky sessions | medium — changes serving behavior | `LYNKR_STICKY_SESSIONS` (on) |
| 2b | WS1.5 fingerprint + drift | low — only adds capability (pinning was dead for Claude Code) | `LYNKR_SESSION_FINGERPRINT` (on), `LYNKR_PIN_DRIFT_MARGIN` (15) |
| 3 | WS3 client profiles | low — replaces a hack with a superset | `LYNKR_CLIENT_PROFILES` (on) |
| 4 | WS4 propensity | none (logging only) | — |
| 5 | WS2 ledger + de-escalation | ledger: none; de-escalation live: evidence-gated | — |
| 6 | WS5 feedback loop | low — all off-response-path | auto-calibration hardcoded on |

Verification after full rollout: `npm run test:unit && npm run test:performance`, then a manual
smoke with `lynkr wrap claude` — confirm (a) a multi-turn session shows `session_pin` methods in
telemetry after turn 1, (b) a trivial "hi" routes SIMPLE with 11 tools attached, (c) routing
stats expose escalation counts and degradation counters, (d) `data/bandit-state.json` mtime
advances during traffic.
