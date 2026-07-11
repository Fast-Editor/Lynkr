const express = require("express");
const config = require("../config");
const { processMessage } = require("../orchestrator");
const { getSession } = require("../sessions");
const metrics = require("../metrics");
const logger = require("../logger");
const { createRateLimiter } = require("./middleware/rate-limiter");
const openaiRouter = require("./openai-router");
const providersRouter = require("./providers-handler");
const { getRoutingHeaders, getRoutingStats, analyzeComplexity, getModelTierSelector, analyzeRisk, checkSessionPin, writeSessionPin, checkPinScoreDrift } = require("../routing");

// Upstream streams can die without a clean end (reader.read() never
// resolves on a dropped socket), hanging the client forever. Every
// forwarding loop must read through this idle watchdog. The window is
// IDLE time, reset per chunk — long-thinking models stream for minutes.
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.LYNKR_STREAM_IDLE_TIMEOUT_MS) || 90000;
async function readWithIdleTimeout(reader, label) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`upstream stream idle >${STREAM_IDLE_TIMEOUT_MS}ms (${label})`)),
          STREAM_IDLE_TIMEOUT_MS,
        );
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const SSE_STALL_EVENT = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Lynkr: upstream stream stalled — retry" } })}\n\n`;
const { detectClient } = require("../routing/client-profiles");
const { buildInteractionBlock } = require("../routing/interaction");
const { validateCwd } = require("../workspace");
const { renderText } = require("../utils/markdown-ansi");
const { classifyAuthMode } = require("../auth-mode");

const router = express.Router();

const rateLimiter = createRateLimiter();

/**
 * Decide which tier/provider/model handles an OAuth-subscription request.
 *
 * Runs Lynkr's full `determineProviderSmart` pipeline — same one PAYG / API-key
 * traffic uses — but on a user-intent payload (last user message only) so
 * Claude Code's 12-tool / fat-system bloat doesn't inflate the decision.
 *
 * The pipeline includes:
 *   - force_local / force_cloud regex shortcuts
 *   - risk classifier (high-risk → forced COMPLEX)
 *   - complexity scoring (weighted heuristic)
 *   - agentic-workflow detector (may bump min-tier)
 *   - kNN router (embedding-based nearest-neighbors of historical queries)
 *   - LinUCB contextual bandit (intra-tier model selection, learns from reward)
 *   - cost-optimizer (cheaper qualifying model when safe)
 *   - session affinity (sticks to previous turn's provider for tool chains)
 *   - tenant policy
 *
 * Plus telemetry — every decision is recorded so kNN/bandit improve over time.
 */
async function pickTierByIntent(body) {
  // Build a user-intent payload. We INCLUDE the tools array (signals agentic
  // intent — a request with 12 tools attached is meaningfully different from
  // a chat-only one, even if both messages look short) but EXCLUDE the system
  // prompt (Claude Code's interactive system is several KB and would always
  // push every request into COMPLEX regardless of what the user typed).
  //
  // Window-scored intent (Phase 5.x):
  //   Score the last N user messages independently, apply exponential
  //   recency decay (decay^age, age 0 = latest), take the message with the
  //   max weighted score as the winner. This catches "this conversation had
  //   a complex/risky turn earlier" without inflating short follow-ups like
  //   "yes" or "continue" with the whole 30-turn history.
  //
  //   Research backing: WSeq attention (Tian et al.) shows last-utterance
  //   weighting is empirically the strongest signal in multi-turn dialogues;
  //   sliding-window 3-5 turns matches the de-facto multi-turn intent-
  //   classification convention. See doc comment on LYNKR_INTENT_WINDOW_N.
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const allUserMsgs = messages.filter((m) => m?.role === 'user');
  const N = Math.max(1, Number(process.env.LYNKR_INTENT_WINDOW_N) || 5);
  const decay = Number(process.env.LYNKR_INTENT_DECAY);
  const decayFactor = Number.isFinite(decay) && decay > 0 && decay <= 1 ? decay : 0.7;
  // Window over messages the USER actually authored: tool_result-only and
  // harness frames would otherwise age the typed ask out of the window and
  // score envelope noise in its place. Pure tool exchanges keep the raw
  // window as a fallback.
  const { extractCleanUserText } = require("../routing/intent-score");
  const textBearingMsgs = allUserMsgs.filter(
    (m) => extractCleanUserText({ messages: [m] })
  );
  const windowUserMsgs = (textBearingMsgs.length > 0 ? textBearingMsgs : allUserMsgs)
    .slice(-N); // chronological, oldest-first

  // WS3 — we USED to slice tools to 3 here so Claude Code's 11 baseline
  // tools didn't inflate the agentic detector's tool-count signal. That
  // hack was client-specific and also discarded real MCP tools the user
  // had configured. Now we pass the full tools array and let the detector
  // subtract the client's baseline via the profile threaded onto the
  // payload — same short-message-intent guarantee, but MCP tools count.
  const intentTools = Array.isArray(body?.tools) ? body.tools : undefined;

  // CLEAN each user message: Claude Code wraps user input in
  //   <system-reminder>...</system-reminder> blocks (CLAUDE.md context,
  //   tool-search hints, current-date inserts, etc.). Those blocks make
  //   "Hi" look like a 500-token complex query to the scorer, and
  //   force_local stops matching. Strip them for the intent score.
  const stripReminders = (s) =>
    typeof s === 'string'
      ? s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      : s;
  const cleanMsg = (msg) => {
    if (!msg) return msg;
    if (typeof msg.content === 'string') {
      return { ...msg, content: stripReminders(msg.content) };
    } else if (Array.isArray(msg.content)) {
      const cleanedContent = msg.content
        .map((b) =>
          b?.type === 'text' && typeof b.text === 'string'
            ? { ...b, text: stripReminders(b.text) }
            : b
        )
        .filter((b) => !(b?.type === 'text' && (!b.text || b.text.trim() === '')));
      return { ...msg, content: cleanedContent };
    }
    return msg;
  };

  if (windowUserMsgs.length === 0) {
    // No user messages in payload (shouldn't happen) — fall through to the
    // error fallback below to preserve prior behavior.
    return {
      tier: 'COMPLEX',
      provider: 'azure-anthropic',
      model: null,
      score: null,
      method: 'fallback',
      reason: 'no_user_messages',
    };
  }

  // Per-message scoring intentionally omits _sessionId so session affinity
  // isn't polluted by multiple intent-only routing calls per request. The
  // FINAL provider pick (downstream of this function) uses the full body
  // including _sessionId, so affinity still works end-to-end.
  const { determineProviderSmart } = require("../clients/routing");
  let winner = null;
  let bestWeighted = -Infinity;
  const perMsgScores = [];

  for (let i = 0; i < windowUserMsgs.length; i++) {
    const age = windowUserMsgs.length - 1 - i; // 0 = latest, length-1 = oldest in window
    const cleaned = cleanMsg(windowUserMsgs[i]);
    const intentPayload = {
      messages: cleaned ? [cleaned] : [],
      tools: intentTools,
      // WS3 — inherit the client profile from the parent request so the
      // agentic detector inside determineProviderSmart can subtract the
      // harness's baseline tools during intent scoring too.
      _clientProfile: body?._clientProfile || null,
    };
    try {
      const decision = await determineProviderSmart(intentPayload, {
        workspace: body?._workspace || null,
        tenantPolicy: body?._tenantPolicy || null,
      });
      const rawScore = decision.score ?? 0;
      const weighted = rawScore * Math.pow(decayFactor, age);
      perMsgScores.push({ age, rawScore, weighted, tier: decision.tier });
      if (weighted > bestWeighted) {
        bestWeighted = weighted;
        winner = { decision, age, rawScore, weighted };
      }
    } catch (err) {
      logger.debug({ err: err.message, age }, "[OAuthIntent] per-message scoring failed");
    }
  }

  if (!winner) {
    logger.warn("OAuth smart routing failed across whole window, falling back to azure-anthropic");
    return {
      tier: 'COMPLEX',
      provider: 'azure-anthropic',
      model: null,
      score: null,
      method: 'fallback',
      reason: 'window_all_failed',
    };
  }

  const d = winner.decision;
  logger.debug({
    windowSize: windowUserMsgs.length,
    decayFactor,
    winnerAge: winner.age,
    winnerRawScore: winner.rawScore,
    winnerWeighted: Number(winner.weighted.toFixed(2)),
    perMsg: perMsgScores,
  }, "[OAuthIntent] window scoring decision");

  return {
    tier: d.tier || null,
    provider: d.provider,
    model: d.model || null,
    score: winner.rawScore,
    method: (d.method || 'tier_config') + '+window',
    reason: d.reason || null,
    agenticResult: d.agenticResult || null,
    risk: d.risk || null,
    // WS0: forward the intent-scoring decision's escalation ledger so the
    // downstream forced-provider path can record it in telemetry.
    base_tier: d.base_tier ?? null,
    escalation_source: d.escalation_source ?? null,
    // WS4: off-policy evaluation needs propensity + candidates on every row.
    // The inner determineProviderSmart already sets these — we just forward.
    // Falls back to a deterministic single-candidate view when the inner
    // path returned neither (e.g. legacy shadow decisions).
    propensity: d.propensity ?? 1.0,
    candidates: d.candidates ?? [{ provider: d.provider, model: d.model || null }],
    // WS5: feedback path needs the bandit context vector (to call
    // bandit.update with the same features the arm was scored on) and the
    // query embedding (to add conclusive-quality outcomes to kNN). Both
    // are underscored — they don't leak through response headers.
    _banditContext: d._banditContext ?? null,
    _queryEmbedding: d._queryEmbedding ?? null,
    _queryText: d._queryText ?? null,
  };
}

/**
 * Transparent passthrough for Claude Code OAuth subscription requests.
 * Forwards the inbound body and headers verbatim to api.anthropic.com so the
 * outgoing request is byte-for-byte what Claude Code would have sent directly,
 * with no orchestrator mutations.
 *
 * Observability is bolted on around the call (start telemetry, response
 * telemetry, memory extraction, audit) so we keep visibility even though we're
 * skipping the orchestrator.
 */
async function handleOauthPassthrough(req, res, opts = {}) {
  const upstream = process.env.LYNKR_OAUTH_PASSTHROUGH_URL
    || "https://api.anthropic.com/v1/messages";

  // === Optional: memory injection at last-user-message tail ===
  // Headroom's P0-1 pattern: append memory context to the latest user
  // message's first text block. NEVER touches system prompt or frozen-prefix
  // messages, so the cache-hot zone Anthropic fingerprints stays intact.
  // Opt-in via LYNKR_OAUTH_MEMORY_INJECTION=true since any body mutation on
  // a subscription request has nonzero anti-abuse risk.
  let bodyToSend = req.body;
  if (process.env.LYNKR_OAUTH_MEMORY_INJECTION === 'true' && config.memory?.enabled !== false) {
    try {
      bodyToSend = maybeInjectMemoryIntoUserTail(req.body);
    } catch (err) {
      logger.debug({ err: err.message }, "Memory injection skipped (non-fatal)");
      bodyToSend = req.body;
    }
  }

  // === Observability: start ===
  const startedAt = Date.now();
  const inputTokenEstimate = estimateTokenCount(bodyToSend?.messages, bodyToSend?.system, bodyToSend?.model);
  metrics.recordRequest();

  // Hop-by-hop and proxy-managed headers we must not forward.
  const HOP_BY_HOP = new Set([
    "host", "connection", "keep-alive", "transfer-encoding", "upgrade",
    "proxy-authorization", "proxy-authenticate", "te", "trailer",
    "content-length", "accept-encoding",
    "x-lynkr-tenant-id", "x-lynkr-workspace", "x-workspace-cwd",
    "x-session-id", "x-request-id", "x-forwarded-for", "x-forwarded-proto",
    "x-forwarded-host", "x-real-ip",
  ]);
  const outHeaders = {};
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (value == null) continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    outHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // Strip Lynkr's internal underscore-prefixed fields (_sessionId,
  // _forceProvider, _tierModel, _tierName, _forcedMethod, _baseTier,
  // _escalationSource, _pinnedRoute, _switchReason, _clientProfile,
  // _workspace, _tenantPolicy, _deadlineMs, _suggestionModeModel). Anthropic
  // rejects unknown top-level keys with "Extra inputs are not permitted".
  // The orchestrator's downstream paths whitelist their outbound bodies,
  // but the passthrough sends this body VERBATIM — so we must strip here.
  if (bodyToSend && typeof bodyToSend === 'object') {
    const stripped = { ...bodyToSend };
    for (const key of Object.keys(stripped)) {
      if (key.startsWith('_')) delete stripped[key];
    }
    bodyToSend = stripped;
  }

  // Re-stringify the body — express already parsed it. Identical re-encoding
  // is fine; Anthropic doesn't fingerprint key ordering.
  const bodyText = JSON.stringify(bodyToSend);

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstream, {
      method: "POST",
      headers: outHeaders,
      body: bodyText,
    });
  } catch (err) {
    logger.error({ err: err.message, upstream }, "OAuth passthrough fetch failed");
    res.status(502).json({ type: "error", error: { type: "api_error", message: "upstream fetch failed" } });
    return;
  }

  // Mirror status + content-type + body. For streaming SSE responses, pipe
  // the stream straight through.
  res.status(upstreamResp.status);
  const contentType = upstreamResp.headers.get("content-type") || "application/json";
  res.set("Content-Type", contentType);
  // Forward selected useful headers.
  for (const h of ["request-id", "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset", "retry-after"]) {
    const v = upstreamResp.headers.get(h);
    if (v) res.set(h, v);
  }
  // Lynkr's own decision headers so callers can see which model answered.
  res.set("X-Lynkr-Provider", "azure-anthropic-passthrough");
  if (opts.tier?.tier) res.set("X-Lynkr-Tier", opts.tier.tier);
  if (req.body?.model) res.set("X-Lynkr-Model", req.body.model);
  res.set("X-Lynkr-Routing-Method", "oauth-subscription-stealth");

  // Capture the response (buffered or streamed) so we can do observability hooks
  // on the way back without changing what the client sees.
  let responseTextForObservability = "";

  // LYNKR_VISIBLE_ROUTING=true: inject a routing badge into the response on
  // its way back to the client. Mutating the RESPONSE is safe — Anthropic's
  // anti-abuse fingerprints the inbound request, not what the proxy does
  // with the response stream before handing it to the client.
  const wantsBadge = config.routing?.visibleInteraction && upstreamResp.ok;
  const badgeText = wantsBadge
    ? `*[Lynkr] subscription-passthrough → ${req.body?.model || '—'} (azure-anthropic)*\n\n`
    : null;

  if (contentType.includes("text/event-stream") && upstreamResp.body) {
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    // For SSE: emit the badge as a synthetic content_block_start +
    // content_block_delta + content_block_stop at index 0, BEFORE the
    // upstream stream begins. Anthropic re-indexes subsequent blocks from 1+,
    // which is fine because Claude Code treats index as opaque and just
    // appends to the rendered content array.
    if (badgeText) {
      const synthetic = [
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: badgeText } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      ].join('');
      res.write(synthetic);
    }

    const reader = upstreamResp.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await readWithIdleTimeout(reader, "oauth-passthrough");
        if (done) break;
        const buf = Buffer.from(value);
        res.write(buf);
        if (typeof res.flush === "function") res.flush();
        // Capture for observability (only first 64KB to avoid memory issues).
        if (responseTextForObservability.length < 65536) {
          responseTextForObservability += decoder.decode(value, { stream: true });
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, "OAuth passthrough stream stalled — ending response");
      try { reader.cancel(); } catch { /* already dead */ }
      try { res.write(SSE_STALL_EVENT); } catch { /* client gone */ }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    res.end();
  } else {
    const text = await upstreamResp.text();
    if (!upstreamResp.ok) {
      // Auth-shape diagnostics (prefix only, never the token): sk-ant-oat*
      // = subscription OAuth (fix: /login refresh), sk-ant-api* = an API KEY
      // is overriding the subscription (fix: unset ANTHROPIC_API_KEY or the
      // client's injected key), JWT/none = client sent something unusable.
      const authHdr = String(req.headers?.authorization || "");
      const apiKeyHdr = String(req.headers?.["x-api-key"] || "");
      logger.warn({
        status: upstreamResp.status,
        bodyPreview: text.slice(0, 500),
        upstream,
        authShape: authHdr ? authHdr.replace("Bearer ", "").slice(0, 12) + "…" : "(none)",
        xApiKeyShape: apiKeyHdr ? apiKeyHdr.slice(0, 12) + "…" : "(none)",
      }, "OAuth passthrough upstream returned non-2xx");
    }
    responseTextForObservability = text;

    // For buffered JSON: prepend a text content block.
    if (badgeText && contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed?.type === 'message' && Array.isArray(parsed.content)) {
          parsed.content.unshift({ type: 'text', text: badgeText });
          res.send(JSON.stringify(parsed));
          return;
        }
      } catch (_) { /* fall through to raw send */ }
    }
    res.send(text);
  }

  // === Observability: end ===
  // Fire-and-forget: never block returning to the client. Record telemetry,
  // metrics, audit, memory — all read-only on the response.
  setImmediate(() => {
    try {
      const latencyMs = Date.now() - startedAt;
      const tier = opts.tier || {};
      let parsedResponse = null;
      if (contentType.includes("application/json")) {
        try { parsedResponse = JSON.parse(responseTextForObservability); } catch {}
      } else if (contentType.includes("text/event-stream")) {
        // Extract a usable response object from the SSE stream by finding the
        // final message_delta / message_stop events.
        parsedResponse = extractAnthropicMessageFromSSE(responseTextForObservability);
      }

      const outputTokens = parsedResponse?.usage?.output_tokens
        ?? parsedResponse?.usage?.completion_tokens
        ?? null;
      const inputTokensActual = parsedResponse?.usage?.input_tokens
        ?? parsedResponse?.usage?.prompt_tokens
        ?? inputTokenEstimate;

      // Lynkr-wide metrics
      const { getMetricsCollector } = require("../observability/metrics");
      const mc = getMetricsCollector();
      mc.recordProviderSuccess("azure-anthropic-passthrough", latencyMs);
      if (outputTokens || inputTokensActual) mc.recordTokens(inputTokensActual, outputTokens || 0);

      // Tier router telemetry (so it shows up in dashboards / routing stats)
      const tlm = require("../routing/telemetry");
      tlm.record({
        request_id: req.headers["request-id"] || req.headers["x-request-id"] || null,
        session_id: req.body?._sessionId || req.sessionId || null,
        timestamp: startedAt,
        tier: tier.tier || "COMPLEX",
        provider: "azure-anthropic-passthrough",
        model: req.body?.model || tier.model || null,
        routing_method: "oauth-passthrough",
        status_code: upstreamResp.status,
        latency_ms: latencyMs,
        input_tokens: inputTokensActual || null,
        output_tokens: outputTokens || null,
        message_count: req.body?.messages?.length || null,
        tool_count: Array.isArray(req.body?.tools) ? req.body.tools.length : 0,
        was_fallback: false,
      });

      // Audit log. NOTE: the interface returned by createAuditLogger exposes
      // logLlmRequest/logLlmResponse — no generic `.log` — so the optional
      // call stays until this is migrated to the real audit API.
      const { createAuditLogger } = require("../logger/audit-logger");
      const audit = createAuditLogger(config.audit);
      audit.log?.({
        provider: "azure-anthropic-passthrough",
        destination: upstream,
        status: upstreamResp.status,
        latencyMs,
        inputTokens: inputTokensActual,
        outputTokens,
        model: req.body?.model,
      });

      // Memory extraction (read-only on response, no LLM call — pure regex)
      if (parsedResponse && config.memory?.extraction?.enabled) {
        const memoryExtractor = require("../memory/extractor");
        memoryExtractor.extractMemories(
          parsedResponse,
          req.body?.messages || [],
          { sessionId: req.body?._sessionId || req.sessionId || null }
        ).catch(() => {});
      }
    } catch (err) {
      logger.debug({ err: err.message }, "OAuth passthrough observability hook failed (non-fatal)");
    }
  });
}

/**
 * Extract the final assembled Anthropic message from a captured SSE stream.
 * Looks at message_start (for id/model), content_block_delta (for text),
 * message_delta (for stop_reason and usage), and message_stop events.
 * Best-effort; returns null on failure.
 */
function extractAnthropicMessageFromSSE(sseText) {
  if (!sseText) return null;
  const result = { id: null, type: "message", role: "assistant", content: [], model: null, stop_reason: null, usage: {} };
  const lines = sseText.split("\n");
  let textAcc = "";
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    if (evt.type === "message_start" && evt.message) {
      result.id = evt.message.id;
      result.model = evt.message.model;
      if (evt.message.usage) Object.assign(result.usage, evt.message.usage);
    } else if (evt.type === "content_block_delta" && evt.delta?.text) {
      textAcc += evt.delta.text;
    } else if (evt.type === "message_delta") {
      if (evt.delta?.stop_reason) result.stop_reason = evt.delta.stop_reason;
      if (evt.usage) Object.assign(result.usage, evt.usage);
    }
  }
  if (textAcc) result.content.push({ type: "text", text: textAcc });
  return result;
}

/**
 * Append relevant memories to the FIRST TEXT BLOCK of the LATEST USER MESSAGE.
 *
 * Headroom's P0-1 pattern (`_append_context_to_latest_non_frozen_user_turn`).
 * The cache hot zone (system + frozen prefix) is NEVER touched. Mutating only
 * the latest user message — which is the request's "live zone" — keeps the
 * prompt-cache identity stable and avoids Anthropic anti-abuse fingerprint
 * divergence for subscription tokens.
 *
 * Returns the body unchanged if:
 *   - Memory is disabled
 *   - No memories retrieved
 *   - Latest message is not a user turn (could be tool_result, assistant)
 *
 * Returns a new body with appended context otherwise. Original body never
 * mutated (returns a shallow-cloned messages array).
 */
function maybeInjectMemoryIntoUserTail(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return body;

  const lastIdx = body.messages.length - 1;
  const lastMsg = body.messages[lastIdx];
  if (!lastMsg || lastMsg.role !== "user") return body;

  const { retrieveRelevantMemories, formatMemoriesForContext, extractQueryFromMessage } =
    require("../memory/retriever");
  const query = extractQueryFromMessage(lastMsg);
  if (!query || query.length < 10) return body; // too short to be a useful query

  const memories = retrieveRelevantMemories(query, {
    limit: Math.min(parseInt(process.env.MEMORY_RETRIEVAL_LIMIT, 10) || 5, 10),
    sessionId: body._sessionId || null,
    includeGlobal: process.env.MEMORY_INCLUDE_GLOBAL !== "false",
  });
  if (!memories || memories.length === 0) return body;

  const formatted = formatMemoriesForContext(memories);
  if (!formatted) return body;

  const contextText = `\n\n## Relevant context from earlier sessions:\n${formatted}`;

  // Bound the injection size (Headroom uses a MemoryInjectionBudget; we use
  // a simpler char cap — ~1024 tokens * 4 chars/token = 4096 chars).
  const MAX_INJECTION_CHARS = 4096;
  const boundedContext = contextText.length > MAX_INJECTION_CHARS
    ? contextText.slice(0, MAX_INJECTION_CHARS) + "\n…"
    : contextText;

  // Clone messages array (shallow) so we don't mutate the caller's body.
  const newMessages = body.messages.slice();

  if (typeof lastMsg.content === "string") {
    newMessages[lastIdx] = { ...lastMsg, content: lastMsg.content + boundedContext };
  } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
    // Append to the FIRST text block, preserving every other block (images,
    // tool_use, etc.) untouched.
    const newContent = [];
    let appended = false;
    for (const block of lastMsg.content) {
      if (!appended && block && typeof block === "object" && block.type === "text") {
        newContent.push({ ...block, text: (block.text || "") + boundedContext });
        appended = true;
      } else {
        newContent.push(block);
      }
    }
    if (!appended) return body; // no text block to append to
    newMessages[lastIdx] = { ...lastMsg, content: newContent };
  } else {
    return body;
  }

  logger.debug({
    memoryCount: memories.length,
    appendedChars: boundedContext.length,
  }, "Memory injected into last-user-message tail");

  return { ...body, messages: newMessages };
}

/**
 * Estimate token count for messages.
 *
 * Phase 1.1: tiktoken-backed via routing/tokenizer (graceful fallback to chars/4
 * if js-tiktoken is unavailable).
 */
const { countMessagesTokens } = require("../routing/tokenizer");

function estimateTokenCount(messages = [], system = null, model = null) {
  return countMessagesTokens(messages, system, model);
}

// Root route - Claude Code health check
router.head("/", (req, res) => {
  res.status(200).end();
});

router.get("/", (req, res) => {
  res.json({
    service: "Lynkr",
    version: require("../../package.json").version,
    status: "running"
  });
});

router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Usage report — same data as `lynkr usage` CLI, served as JSON for
// dashboards / agents / scripts that want to surface spend & savings.
router.get("/v1/usage", (req, res) => {
  try {
    const aggregator = require("../usage/aggregator");
    const window = req.query.window || (req.query.days ? `${parseInt(req.query.days, 10)}d` : "30d");
    const usage = aggregator.getUsage({
      window,
      flagship: req.query.flagship,
      provider: req.query.provider,
      model: req.query.model,
    });
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Routing stats endpoint (Phase 3: Metrics)
router.get("/routing/stats", (req, res) => {
  const stats = getRoutingStats();
  res.json({
    status: "ok",
    stats: stats || { message: "No routing decisions recorded yet" },
  });
});

// Model registry info (from LiteLLM + models.dev APIs)
router.get("/routing/models", async (req, res) => {
  try {
    const { getModelRegistry } = require("../routing/model-registry");
    const registry = await getModelRegistry();
    res.json({
      status: "ok",
      ...registry.getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get specific model info
router.get("/routing/models/:model", async (req, res) => {
  try {
    const { getModelRegistry } = require("../routing/model-registry");
    const registry = await getModelRegistry();
    const model = registry.getModel(req.params.model);
    if (!model || model.source === "default") {
      return res.status(404).json({ error: "Model not found", model: req.params.model });
    }
    res.json({ status: "ok", model: req.params.model, ...model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Routing tier information
router.get("/routing/tiers", (req, res) => {
  try {
    const { getModelTierSelector } = require("../routing/model-tiers");
    const selector = getModelTierSelector();
    res.json({
      status: "ok",
      ...selector.getTierStats(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cost optimization stats
router.get("/metrics/cost-optimization", (req, res) => {
  try {
    const { getCostOptimizer } = require("../routing/cost-optimizer");
    const optimizer = getCostOptimizer();
    res.json({
      status: "ok",
      ...optimizer.getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request analysis test endpoint
router.post("/routing/analyze", async (req, res) => {
  try {
    const { getAgenticDetector } = require("../routing/agentic-detector");
    const { getModelTierSelector } = require("../routing/model-tiers");
    const { getModelRegistry } = require("../routing/model-registry");

    const analysis = await analyzeComplexity(req.body, { weighted: req.query.weighted === "true" });
    const agentic = getAgenticDetector().detect(req.body);
    const selector = getModelTierSelector();
    const tier = selector.getTier(analysis.score);

    const provider = req.query.provider || "openai";
    const modelSelection = selector.selectModel(tier, provider);

    let modelInfo = null;
    if (modelSelection.model) {
      const registry = await getModelRegistry();
      modelInfo = registry.getCost(modelSelection.model);
    }

    res.json({
      status: "ok",
      analysis,
      agentic,
      tier,
      modelSelection,
      modelInfo,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/debug/session", (req, res) => {
  if (!req.sessionId) {
    return res.status(400).json({ error: "missing_session_id", message: "Provide x-session-id header" });
  }
  const session = getSession(req.sessionId);
  if (!session) {
    return res.status(404).json({ error: "session_not_found", message: "Session not found" });
  }
  res.json({ session });
});

router.post("/v1/messages/count_tokens", rateLimiter, async (req, res, next) => {
  try {
    const { messages, system } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "messages must be a non-empty array",
        },
      });
    }

    const inputTokens = estimateTokenCount(messages, system);

    // Return token count in Anthropic API format
    res.json({
      input_tokens: inputTokens,
    });
  } catch (error) {
    next(error);
  }
});

// Stub endpoint for event logging (used by Claude CLI)
router.post("/api/event_logging/batch", (req, res) => {
  res.status(200).json({ success: true });
});

// In-process counter so users can see when an agent loop is burning requests.
// Logged on every inbound /v1/messages so a runaway loop is visible at LOG_LEVEL=info.
let messagesRequestCount = 0;
const messagesSessionStart = Date.now();

router.post("/v1/messages", rateLimiter, async (req, res, next) => {
  try {
    const { createTimer } = require("../utils/perf-timer");
    const timer = createTimer("POST /v1/messages");
    metrics.recordRequest();
    // Also bump the rich observability collector — that's what `lynkr wrap`'s
    // session-stats summary and the /metrics/observability dashboard read.
    // Without this call the wrap UI ends every session with "No requests
    // tracked" regardless of actual traffic.
    try {
      const { getMetricsCollector } = require("../observability/metrics");
      getMetricsCollector().recordRequest("POST", "/v1/messages", null, null);
    } catch (_) {}

    messagesRequestCount += 1;

    // Strip prior-turn Lynkr routing badges from inbound history BEFORE any
    // downstream stage (auth classification, tier router, history compression,
    // orchestrator agent loop, invokeModel) sees them. History compression
    // bakes prior message text into a single summary user message, so once
    // compressed the badge is no longer a recognizable prefixed block — it
    // becomes an embedded substring inside a user-role summary, which our
    // assistant-only/anchored strip can't catch. Doing it here is the only
    // chokepoint upstream of all of those.
    if (Array.isArray(req.body?.messages)) {
      const { stripLynkrBadges } = require("../clients/databricks");
      req.body.messages = stripLynkrBadges(req.body.messages);
    }

    const lastMsg = Array.isArray(req.body?.messages) ? req.body.messages[req.body.messages.length - 1] : null;
    const lastRole = lastMsg?.role;
    const hasToolResult = Array.isArray(lastMsg?.content)
      && lastMsg.content.some(b => b?.type === 'tool_result');
    logger.debug({
      reqNumber: messagesRequestCount,
      sessionElapsedMs: Date.now() - messagesSessionStart,
      lastMessageRole: lastRole,
      isToolResultContinuation: hasToolResult,
      messageCount: req.body?.messages?.length,
      hasTools: Array.isArray(req.body?.tools) && req.body.tools.length > 0,
      toolCount: Array.isArray(req.body?.tools) ? req.body.tools.length : 0,
      model: req.body?.model,
    }, "Inbound /v1/messages");

    // WS3 — detect the client harness (Claude Code / Cursor / Codex / …)
    // ONCE per request and stash on the body so every downstream routing
    // stage (pickTierByIntent's per-message scoring, orchestrator's full
    // determineProviderSmart) sees the same profile and can subtract the
    // client's baseline tool loadout when scoring agentic signals.
    if (!req.body._clientProfile) {
      try {
        const profile = detectClient({ headers: req.headers, payload: req.body });
        if (profile) req.body._clientProfile = profile;
      } catch (err) {
        logger.debug({ err: err.message }, '[Router] client detection failed');
      }
    }

    // Auth-mode classification (Headroom-style, UA-first):
    //
    //   - 'subscription': UX-bound CLI/IDE (Claude Code, Cursor, Copilot, …).
    //       Anthropic anti-abuse fingerprints these clients. Stealth required:
    //       tier-route on user intent, then either passthrough to api.anthropic.com
    //       byte-for-byte, or route to a non-Anthropic provider (where mutation
    //       is safe).
    //
    //   - 'oauth' (Bedrock SigV4, Codex/Cursor JWT, Vertex ADC, etc.):
    //       OAuth but NOT a fingerprinted subscription client. Same routing as
    //       PAYG; only difference is upstream credential format.
    //
    //   - 'payg' (API key): full orchestrator with all optimizations.
    //
    // All three paths now share window-scored intent tier picking
    // (`pickTierByIntent`). Subscription still has the additional
    // azure-anthropic passthrough fork for anti-abuse stealth; everything
    // else just falls through to the orchestrator with the picked tier
    // pinned via _forceProvider/_tierModel. The reason all paths share the
    // scorer is that determineProviderSmart's full-body analysis inflates
    // scores (5 KB system prompt + 11 tools + every prior message ≫ user
    // intent), pushing every request — including "yes" follow-ups — into
    // COMPLEX/REASONING regardless of what the user actually typed. Window-
    // scoring fixes that for PAYG too.
    const authMode = classifyAuthMode(req.headers);

    // The session middleware sets req.sessionId from the x-session-id header,
    // but req.body._sessionId isn't populated until deep in the orchestrator
    // (src/orchestrator/index.js). WS1's checkSessionPin reads _sessionId off
    // the payload, so mirror it onto the body here — the orchestrator's later
    // assignment is a no-op when the value already matches.
    if (req.sessionId && !req.body._sessionId) {
      req.body._sessionId = req.sessionId;
    }

    // WS1 — sticky-session reuse. If this session already has a valid pin
    // (guards pass, no compaction), skip pickTierByIntent entirely and reuse
    // the pinned decision. This is the biggest cost win of WS1: repeat turns
    // in a session skip the whole window-scored intent pipeline.
    let tier;
    const pinCheck = checkSessionPin(req.body);
    // Side-request detection. Claude Code fires internal background calls
    // (title generation, summarization, memory extraction, suggestion-mode
    // autocomplete) that REPLAY the conversation — so they share the
    // conversation's content fingerprint — but wrap it in harness prompts
    // and repo transcript text. Two live incidents (2026-07-07):
    //   1. A summarization side request replayed tool outputs full of
    //      "security"/"credential" strings from the repo itself, tripped
    //      the risk guard, re-routed COMPLEX (score 100), and OVERWROTE
    //      the conversation's pin.
    //   2. A suggestion-mode request — which DOES carry the full 13-tool
    //      loadout, defeating the tool-less check — tripped risk on its
    //      own "[SUGGESTION MODE: ...]" wrapper instructions and poisoned
    //      the pin the same way (telemetry: risk+window COMPLEX 100).
    // Discriminators: interactive turns attach tools AND have a plain last
    // user message; side traffic is tool-less OR suggestion-tagged.
    // Side requests are routed to a static cheap tier below — scoring
    // harness wrapper text is meaningless and, worse, can land them on the
    // subscription passthrough, burning quota on autocomplete calls.
    const _lastUserText = (() => {
      const msgs = req.body?.messages;
      if (!Array.isArray(msgs)) return '';
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content.filter(b => b?.type === 'text').map(b => b.text || '').join(' ');
        }
        return '';
      }
      return '';
    })();
    const isSuggestionMode = _lastUserText.includes('[SUGGESTION MODE:');
    // Tool-lessness alone is NOT harness evidence: generic API clients
    // (curl, benchmarks, SDKs) legitimately send bare messages and must get
    // full routing — live regression 2026-07-08: a benchmark's security-
    // analysis scenario was force-SIMPLE'd as a "side request" and never
    // reached the risk classifier. Require a detected client profile
    // (harness UA / tool fingerprint) before treating tool-less traffic as
    // side traffic; a suggestion-mode tag is harness evidence by itself.
    const isKnownHarness = !!req.body?._clientProfile;
    const isSideRequest = isSuggestionMode
      || ((!Array.isArray(req.body?.tools) || req.body.tools.length === 0) && isKnownHarness);
    // Side requests short-circuit to the static SIMPLE tier: no pin read
    // (a COMPLEX-pinned conversation would burn expensive tokens on
    // autocomplete), no pin write, no intent scoring of wrapper text.
    // Upstream failures (e.g. a huge summarization overflowing the SIMPLE
    // model's context) are rescued by the tier-fallback chain.
    let sideTier = null;
    if (isSideRequest) {
      try {
        const sel = getModelTierSelector().selectModel('SIMPLE', null);
        sideTier = {
          tier: 'SIMPLE',
          provider: sel.provider,
          model: sel.model || null,
          score: null,
          method: isSuggestionMode ? 'side_request_suggestion' : 'side_request',
          reason: 'harness_side_request',
          base_tier: null,
          escalation_source: null,
          pinned: false,
          switch_reason: null,
          propensity: 1.0,
          candidates: [{ provider: sel.provider, model: sel.model || null }],
        };
      } catch (err) {
        // Tier selector unavailable — fall through to the normal flow;
        // the isSideRequest guards below still block pin writes.
        logger.debug({ err: err.message }, 'Side-request static tier failed, falling through');
      }
    }
    // WS1.5 — upward-drift check. A session pinned SIMPLE by a trivial
    // opener ("Hi") must escape the pin the moment the real task arrives
    // ("plan a refactor of the whole repo"). Only meaningful for
    // guards_passed serves — tool_history turns must never switch models.
    let pinDrift = null;
    if (!sideTier && pinCheck.serve && pinCheck.reason === 'guards_passed' && !isSideRequest) {
      pinDrift = await checkPinScoreDrift(pinCheck.pin, req.body);
    }
    if (sideTier) {
      tier = sideTier;
      logger.debug({
        reqNumber: messagesRequestCount,
        authMode,
        suggestion: isSuggestionMode,
        provider: tier.provider,
      }, "OAuth intent — side request routed to static SIMPLE");
    } else if (pinCheck.serve && !pinDrift?.drift) {
      tier = {
        tier: pinCheck.pin.tier || null,
        provider: pinCheck.pin.provider,
        model: pinCheck.pin.model || null,
        // Prefer the drift check's fresh per-message score — it's already
        // computed on every guards_passed pinned turn, and showing it makes
        // the badge reflect THIS message instead of repeating the score
        // that created the pin turns ago (users read a wall of "score 0"
        // as the router being asleep). Falls back to the pin's original
        // score on tool_history serves, where drift is deliberately
        // skipped. Never complexity.score — the full-body value is
        // inflated by tools + system + history.
        score: typeof pinDrift?.freshScore === 'number'
          ? pinDrift.freshScore
          : (typeof pinCheck.pin.score === 'number' ? pinCheck.pin.score : null),
        // Original pin score, surfaced in the badge as "pin@N" so both
        // numbers are visible.
        _pinScore: typeof pinCheck.pin.score === 'number' ? pinCheck.pin.score : null,
        method: 'session_pin',
        reason: 'sticky_' + pinCheck.reason,
        base_tier: null,
        escalation_source: null,
        pinned: true,
        switch_reason: null,
      };
      logger.debug({
        reqNumber: messagesRequestCount,
        authMode,
        sessionId: pinCheck.sessionId,
        tier,
      }, "OAuth intent — served from session pin");
    } else {
      if (pinDrift?.drift) {
        logger.info({
          sessionId: pinCheck.sessionId,
          pinnedTier: pinCheck.pin?.tier,
          freshScore: pinDrift.freshScore,
          ceiling: pinDrift.ceiling,
        }, "OAuth intent — pin score drift, re-deciding");
      }
      tier = await pickTierByIntent(req.body);
      if (pinDrift?.drift && tier) tier.switch_reason = 'score_drift';

      // Compaction floor: compaction resets cache economics, not task
      // difficulty — post-compaction windows score harness summaries, not
      // the ask that earned the pin. Re-routes may move up, never below
      // the pinned tier.
      if (pinCheck.reason === 'compaction' && pinCheck.pin?.tier && tier?.tier) {
        const { TIER_DEFINITIONS } = require("../routing/model-tiers");
        const pri = (t) => TIER_DEFINITIONS[t]?.priority ?? -1;
        if (pri(tier.tier) < pri(pinCheck.pin.tier)) {
          const { getModelTierSelector } = require("../routing/model-tiers");
          const floored = getModelTierSelector().selectModel(pinCheck.pin.tier, null);
          logger.info({
            sessionId: pinCheck.sessionId,
            windowTier: tier.tier,
            flooredTo: pinCheck.pin.tier,
          }, "OAuth intent — compaction re-route floored at pinned tier");
          tier = {
            ...tier,
            tier: pinCheck.pin.tier,
            provider: floored.provider,
            model: floored.model,
            method: (tier.method || 'tier_config') + '+compaction_floor',
            switch_reason: 'compaction_floor',
          };
        }
      }
      // Persist the fresh decision so the next turn on this session can
      // reuse it. checkSessionPin returned serve=false (or WS1.5 drift fired),
      // so either there was no pin, the pin lost a guard (context/vision/
      // risk), the session was compacted, or the conversation outgrew its
      // pinned tier — in every case we want the new pin. EXCEPT side
      // requests: their decisions reflect harness wrapper text, not the
      // user's conversation, and must never poison the conversation's pin.
      if (!isSideRequest && pinCheck.sessionId && tier?.provider) {
        writeSessionPin(pinCheck.sessionId, tier, req.body);
      } else if (isSideRequest && pinCheck.sessionId && tier?.provider) {
        logger.debug({
          sessionId: pinCheck.sessionId,
          tier: tier.tier,
          provider: tier.provider,
        }, "OAuth intent — side request (no tools), pin write skipped");
      }
    }

    // Subscription-only fork: anti-abuse stealth passthrough when the picked
    // tier resolves to azure-anthropic. Bypasses the orchestrator entirely
    // so the inbound bytes hit api.anthropic.com unchanged (Anthropic
    // fingerprints subscription clients; any mutation gets flagged).
    // Passthrough forwards the CLIENT's credentials; GUI harnesses that
    // spawn claude headless inject placeholder keys ("dummy") that Anthropic
    // 401s. Placeholder auth ⇒ serve REASONING via the provider's own
    // credentials instead.
    const _clientApiKey = String(req.headers?.['x-api-key'] || '').toLowerCase();
    const _clientAuthHdr = String(req.headers?.authorization || '');
    const _placeholderAuth =
      !_clientAuthHdr &&
      (['dummy', 'test', 'placeholder', 'none', 'x', 'sk-dummy'].includes(_clientApiKey) || _clientApiKey.length < 8);
    if (_placeholderAuth && authMode === 'subscription' && tier.provider === 'azure-anthropic') {
      logger.info({
        reqNumber: messagesRequestCount,
        xApiKeyShape: _clientApiKey.slice(0, 12),
      }, 'Placeholder client auth — skipping passthrough, serving REASONING via provider credentials');
    }
    if (authMode === 'subscription' && tier.provider === 'azure-anthropic' && !_placeholderAuth) {
      logger.debug({
        reqNumber: messagesRequestCount,
        authMode,
        model: req.body?.model,
        tier: tier.tier,
      }, "Subscription passthrough → api.anthropic.com");
      return handleOauthPassthrough(req, res, { tier });
    }

    // All other cases (subscription→non-Anthropic, payg, oauth): pin the
    // window-scored tier so the orchestrator's internal tier router can't
    // override it with a full-body re-score. Badge/headers downstream show
    // OUR pick (scored on user intent only), not the orchestrator's
    // pre-route (scored on full payload including system prompt + tools).
    logger.debug({
      reqNumber: messagesRequestCount,
      authMode,
      tier: tier.tier,
      provider: tier.provider,
      model: tier.model,
      method: tier.method,
    }, "Intent-scored tier routing → orchestrator (forced provider)");
    req.body._forceProvider = tier.provider;
    if (tier.model) req.body._tierModel = tier.model;
    // Carry the full intent-scored decision into the downstream client so
    // WS0's telemetry columns (tier, base_tier, escalation_source, pinned)
    // are populated for the forced path too — otherwise every OAuth-intent
    // request lands in routing_telemetry with empty tier + method='forced'.
    if (tier.tier) req.body._tierName = tier.tier;
    if (tier.method) req.body._forcedMethod = tier.method;
    if (tier.base_tier) req.body._baseTier = tier.base_tier;
    if (tier.escalation_source) req.body._escalationSource = tier.escalation_source;
    if (tier.pinned) req.body._pinnedRoute = true;
    if (tier.switch_reason) req.body._switchReason = tier.switch_reason;
    // WS4 — propensity + candidates land on every telemetry row so downstream
    // off-policy evaluation can score any counterfactual policy from logs.
    if (tier.propensity != null) req.body._propensity = tier.propensity;
    if (tier.candidates) req.body._candidates = tier.candidates;
    // WS5 — bandit context vector + query embedding for the feedback loop.
    // All three are underscored; `_stripInternalFields` scrubs them before
    // the outbound provider request so no risk of leaking to Anthropic/Ollama.
    if (tier._banditContext) req.body._banditContext = tier._banditContext;
    if (tier._queryEmbedding) req.body._queryEmbedding = tier._queryEmbedding;
    if (tier._queryText) req.body._queryText = tier._queryText;
    req._intentTier = tier;

    // Convert Anthropic server tools (web_search_20260209, etc.) to regular
    // function tools so non-Anthropic providers can execute them via Lynkr.
    // The orchestrator's SERVER_SIDE_TOOLS handling will execute them server-side.
    if (Array.isArray(req.body?.tools)) {
      const incomingToolTypes = req.body.tools.map(t => t?.type || t?.name).filter(Boolean);
      logger.info({ incomingToolTypes }, "Incoming /v1/messages tool types");
      req.body.tools = req.body.tools.map((tool) => {
        if (tool?.type?.startsWith?.("web_search_20")) {
          logger.info({ originalType: tool.type, name: tool.name }, "Converting web_search server tool to function tool");
          return {
            name: tool.name || "web_search",
            description: "Search the web for up-to-date information. Returns relevant search results from the web.",
            input_schema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
              },
              required: ["query"],
            },
          };
        }
        if (tool?.type?.startsWith?.("web_fetch_")) {
          return {
            name: tool.name || "web_fetch",
            description: "Fetch the contents of a URL.",
            input_schema: {
              type: "object",
              properties: {
                url: { type: "string", description: "URL to fetch" },
              },
              required: ["url"],
            },
          };
        }
        return tool;
      });
    }

// Support both query parameter (?stream=true) and body parameter ({"stream": true})
    const wantsStream = Boolean(req.query?.stream === 'true' || req.body?.stream);
    const hasTools = Array.isArray(req.body?.tools) && req.body.tools.length > 0;
    timer.mark("parseRequest");

    // Analyze complexity for routing headers (Phase 3)
    const complexity = await analyzeComplexity(req.body);
    timer.mark("analyzeComplexity");

    // Risk axis runs alongside complexity. Cheap pure-string scan, no I/O.
    let preRouteRisk = null;
    try {
      preRouteRisk = analyzeRisk(req.body);
    } catch (err) {
      logger.debug({ err: err.message }, '[Router] Risk analysis failed in pre-route');
    }

    // Pre-route tier: high-risk forces COMPLEX, otherwise tier is
    // inferred from the complexity recommendation. The actual final
    // tier may differ (invokeModel re-runs determineProviderSmart) —
    // this is best-effort for header surfacing.
    let preRouteProvider = 'cloud';
    let preRouteTier = null;
    let preRouteModel = null;
    let preRouteMethod = 'complexity';
    let preRouteReason = complexity.breakdown?.taskType?.reason || complexity.recommendation;

    if (preRouteRisk?.level === 'high') {
      try {
        const selector = getModelTierSelector();
        const tierResult = selector.selectModel('COMPLEX', null);
        preRouteProvider = tierResult.provider;
        preRouteTier = 'COMPLEX';
        preRouteModel = tierResult.model;
        preRouteMethod = 'risk';
        preRouteReason = 'high_risk_forced_tier';
      } catch (_) {
        // Risk-forced tier not configured; fall back to normal flow.
      }
    }

    if (!preRouteTier) {
      if (complexity.recommendation === 'local') {
        try {
          const selector = getModelTierSelector();
          const tierResult = selector.selectModel('SIMPLE', null);
          preRouteProvider = tierResult.provider;
          preRouteTier = 'SIMPLE';
          preRouteModel = tierResult.model;
        } catch (_) {
          preRouteProvider = 'ollama';
        }
      }
    }

    // If the OAuth-subscription tier picker already made a decision (scored
    // on user-intent only, not the full Claude Code payload), use its values
    // so the badge/headers reflect the ACTUAL routing decision instead of
    // the pre-route's full-payload score (which is inflated by tools + system).
    if (req._intentTier) {
      preRouteProvider = req._intentTier.provider || preRouteProvider;
      preRouteTier = req._intentTier.tier || preRouteTier;
      preRouteModel = req._intentTier.model || preRouteModel;
      preRouteMethod = 'oauth-tier-routing';
      preRouteReason = 'user_intent';
    }

    // Prefer the intent scorer's per-message score over the full-payload
    // complexity score. The full-payload score is always inflated on
    // subscription clients (5 KB system + 11 tools + prior turns) and would
    // display "score 46" on a trivial "what did I just say?" follow-up.
    // Only fall back to complexity.score when we don't have an intent
    // decision at all (e.g. shouldForceLocal shortcut, or the intent scorer
    // didn't run for this request type).
    let displayScore = null;
    if (req._intentTier && typeof req._intentTier.score === 'number') {
      displayScore = req._intentTier.score;
    } else if (!req._intentTier) {
      displayScore = complexity.score;
    }

    const preRouteDecision = {
      provider: preRouteProvider,
      tier: preRouteTier,
      model: preRouteModel,
      method: preRouteMethod,
      reason: preRouteReason,
      score: displayScore,
      threshold: complexity.threshold,
      risk: preRouteRisk,
      // Pin-serve turns carry the pin's original score so the badge can
      // show "score <fresh> · pin@<original>".
      _pinScore: typeof req._intentTier?._pinScore === 'number' ? req._intentTier._pinScore : null,
    };

    const routingHeaders = getRoutingHeaders(preRouteDecision);

    // Build the interaction block once. It travels in headers always
    // (X-Lynkr-Interaction-* derived fields) and optionally into the
    // response body when LYNKR_VISIBLE_ROUTING=true.
    const interaction = buildInteractionBlock(preRouteDecision);

    const clientCwd = validateCwd(req.body?.cwd || req.headers['x-workspace-cwd']);

    // For true streaming: only support non-tool requests for MVP
    // Tool requests require buffering for agent loop
    if (wantsStream && !hasTools) {
      metrics.recordStreamingStart();
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...routingHeaders,
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      const result = await processMessage({
        payload: req.body,
        headers: req.headers,
        session: req.session,
        cwd: clientCwd,
        options: {
          maxSteps: req.body?.max_steps,
          maxDurationMs: req.body?.max_duration_ms,
          tenantPolicy: res.locals?.tenantPolicy || null,
        },
      });

      if (result.stream) {
        // Parse SSE stream from provider and forward to client
        const reader = result.stream.getReader();
        const decoder = new TextDecoder();
        const bufferChunks = []; // Use array to avoid string concatenation overhead

        try {
          while (true) {
            const { done, value } = await readWithIdleTimeout(reader, "provider-stream");
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            bufferChunks.push(chunk);

            const buffer = bufferChunks.join('');
            const lines = buffer.split('\n');

            // Keep last incomplete line in buffer chunks
            const remaining = lines.pop() || '';
            bufferChunks.length = 0;
            if (remaining) bufferChunks.push(remaining);

            for (const line of lines) {
              if (line.trim()) {
                res.write(line + '\n');
              }
            }

            if (typeof res.flush === 'function') {
              res.flush();
            }
          }

          const remaining = bufferChunks.join('');
          if (remaining.trim()) {
            res.write(remaining + '\n');
          }

          metrics.recordResponse(200);
          res.end();
          return;
        } catch (streamError) {
          logger.error({ error: streamError }, "Error streaming response");

          try {
            await reader.cancel();
          } catch (cancelError) {
            logger.debug({ error: cancelError }, "Failed to cancel stream");
          }

          if (!res.headersSent) {
            res.status(500).json({ error: "Streaming error" });
          } else {
            // Mid-stream failure: emit a parseable Anthropic error event so
            // the client fails fast and retries, instead of seeing a
            // truncated stream it may wait on.
            try { res.write(SSE_STALL_EVENT); } catch { /* client gone */ }
            res.end();
          }
          return;
        } finally {
          // CRITICAL: Always release lock
          try {
            reader.releaseLock();
          } catch (releaseError) {
            // Lock may already be released, ignore
            logger.debug({ error: releaseError }, "Stream lock already released");
          }
        }
      }

      if (!result || !result.body) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ type: "error", error: { message: "Empty response from provider" } })}\n\n`);
        res.end();
        return;
      }

      const msg = result.body;

      res.write(`event: message_start\n`);
      res.write(`data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: msg.id,
          type: "message",
          role: "assistant",
          content: [],
          model: msg.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: msg.usage?.input_tokens || 0, output_tokens: 1 }
        }
      })}\n\n`);

      // Filter out server-side tools that shouldn't reach the client
      // Server-tool filtering is server-mode only: in client mode Task and
      // WebSearch are the CLIENT'S tools, and stripping them emits a
      // malformed turn (stop_reason tool_use with no tool_use block).
      const _serverTools = new Set(["task", "websearch", "webfetch", "web_search", "web_fetch", "web_agent"]);
      const _clientOwnsTools = config.toolExecutionMode === "client" || config.toolExecutionMode === "passthrough";
      let contentBlocks = _clientOwnsTools
        ? (msg.content || []).slice()
        : (msg.content || []).filter(b =>
            !(b.type === "tool_use" && _serverTools.has((b.name || "").toLowerCase()))
          );

      // When LYNKR_VISIBLE_ROUTING=true, prepend a one-line routing badge so
      // users can see which tier/provider/model handled the request inside
      // Claude Code's TUI (TUI only renders content blocks; unknown top-level
      // fields are silently dropped).
      if (config.routing?.visibleInteraction && interaction) {
        const badge = `*[Lynkr] ${interaction.tier || '—'} → ${interaction.model || '—'} (${interaction.provider || '—'}) · score ${interaction.complexity_score ?? '—'}${interaction.pin_score != null ? ` · pin@${interaction.pin_score}` : ''}*\n\n`;
        contentBlocks = [{ type: 'text', text: badge }, ...contentBlocks];
      }

      for (let i = 0; i < contentBlocks.length; i++) {
        const block = contentBlocks[i];

        if (block.type === "text") {
          res.write(`event: content_block_start\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "text", text: "" }
          })}\n\n`);

          // Send text — one chunk when ANSI rendering is active (splitting
          // ANSI escape sequences across 20-char chunks breaks terminal output).
          // Plain text falls back to line-level chunks for a trickle effect.
          // Never apply ANSI rendering to HTML content (<artifact> blocks):
          // ANSI codes corrupt CSS selectors like `*` and break the browser viewer.
          const rawBlockText = block.text || "";
          const isHtmlContent = rawBlockText.includes("<artifact") || rawBlockText.trimStart().startsWith("<");
          const text = isHtmlContent ? rawBlockText : renderText(rawBlockText);
          const { enabled: ansiEnabled } = require("../utils/markdown-ansi");
          if (ansiEnabled && !isHtmlContent) {
            if (text.length > 0) {
              res.write(`event: content_block_delta\n`);
              res.write(`data: ${JSON.stringify({
                type: "content_block_delta",
                index: i,
                delta: { type: "text_delta", text }
              })}\n\n`);
            }
          } else {
            const lines = text.split("\n");
            for (const line of lines) {
              const lineWithNl = line + "\n";
              res.write(`event: content_block_delta\n`);
              res.write(`data: ${JSON.stringify({
                type: "content_block_delta",
                index: i,
                delta: { type: "text_delta", text: lineWithNl }
              })}\n\n`);
            }
          }

          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        } else if (block.type === "thinking") {
          res.write(`event: content_block_start\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "thinking", thinking: "" }
          })}\n\n`);
          const thinkingText = block.thinking || "";
          const thinkChunkSize = 40;
          for (let j = 0; j < thinkingText.length; j += thinkChunkSize) {
            res.write(`event: content_block_delta\n`);
            res.write(`data: ${JSON.stringify({
              type: "content_block_delta",
              index: i,
              delta: { type: "thinking_delta", thinking: thinkingText.slice(j, j + thinkChunkSize) }
            })}\n\n`);
          }
          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        } else if (block.type === "tool_use") {
          // Original request had no tools → model hallucinated a tool call.
          // Extract file content from write-style tools and wrap it in an
          // <artifact> block so open-design routes it to the Design panel.
          const toolName = (block.name || "").toLowerCase();
          const writeTools = new Set(["write", "create_file", "write_file", "str_replace_editor"]);
          if (writeTools.has(toolName)) {
            const rawContent = block.input?.content ?? block.input?.file_content ?? block.input?.new_content ?? "";
            const filePath = String(block.input?.file_path ?? block.input?.filename ?? "design.html");
            const content = String(rawContent);
            if (content) {
              // Wrap in <artifact> so open-design's parser routes it to the file viewer.
              const identifier = filePath.replace(/[^a-zA-Z0-9._-]/g, "_");
              const title = filePath;
              const wrapped = `<artifact identifier="${identifier}" type="text/html" title="${title}">\n${content}\n</artifact>`;
              res.write(`event: content_block_start\n`);
              res.write(`data: ${JSON.stringify({
                type: "content_block_start",
                index: i,
                content_block: { type: "text", text: "" }
              })}\n\n`);
              res.write(`event: content_block_delta\n`);
              res.write(`data: ${JSON.stringify({
                type: "content_block_delta",
                index: i,
                delta: { type: "text_delta", text: wrapped }
              })}\n\n`);
              res.write(`event: content_block_stop\n`);
              res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
            }
          }
          // Non-write tool_use in a tool-less request is silently dropped.
        }
      }

      res.write(`event: message_delta\n`);
      res.write(`data: ${JSON.stringify({
        type: "message_delta",
        // Consistency: never claim tool_use if no tool_use block was emitted
        // (a stop_reason pointing at a missing block hangs the client).
        delta: {
          stop_reason: (msg.stop_reason === "tool_use" && !contentBlocks.some(b => b.type === "tool_use"))
            ? "end_turn"
            : (msg.stop_reason || "end_turn"),
          stop_sequence: null,
        },
        usage: { output_tokens: msg.usage?.output_tokens || 0 }
      })}\n\n`);

      res.write(`event: message_stop\n`);
      res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);

      metrics.recordResponse(result.status);
      res.end();
      return;
    }

    // Non-streaming or tool-based requests (buffered path)
    timer.mark("preProcessMessage");
    const result = await processMessage({
      payload: req.body,
      headers: req.headers,
      session: req.session,
      cwd: clientCwd,
      options: {
        maxSteps: req.body?.max_steps,
        maxDurationMs: req.body?.max_duration_ms,
        tenantPolicy: res.locals?.tenantPolicy || null,
      },
    });
    timer.mark("processMessage");
    timer.done();

    // Legacy streaming wrapper (for tool-based requests that requested streaming)
    if (wantsStream && hasTools) {
      metrics.recordStreamingStart();
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      if (!result || !result.body) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ type: "error", error: { message: "Empty response from provider" } })}\n\n`);
        res.end();
        return;
      }

      const msg = result.body;

      res.write(`event: message_start\n`);
      res.write(`data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: msg.id,
          type: "message",
          role: "assistant",
          content: [],
          model: msg.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: msg.usage?.input_tokens || 0, output_tokens: 1 }
        }
      })}\n\n`);

      // Filter out server-side tools that shouldn't reach the client
      // Server-tool filtering is server-mode only: in client mode Task and
      // WebSearch are the CLIENT'S tools, and stripping them emits a
      // malformed turn (stop_reason tool_use with no tool_use block).
      const _serverTools = new Set(["task", "websearch", "webfetch", "web_search", "web_fetch", "web_agent"]);
      const _clientOwnsTools = config.toolExecutionMode === "client" || config.toolExecutionMode === "passthrough";
      let contentBlocks = _clientOwnsTools
        ? (msg.content || []).slice()
        : (msg.content || []).filter(b =>
            !(b.type === "tool_use" && _serverTools.has((b.name || "").toLowerCase()))
          );

      // When LYNKR_VISIBLE_ROUTING=true, prepend a one-line routing badge so
      // users can see which tier/provider/model handled the request inside
      // Claude Code's TUI (TUI only renders content blocks; unknown top-level
      // fields are silently dropped).
      if (config.routing?.visibleInteraction && interaction) {
        const badge = `*[Lynkr] ${interaction.tier || '—'} → ${interaction.model || '—'} (${interaction.provider || '—'}) · score ${interaction.complexity_score ?? '—'}${interaction.pin_score != null ? ` · pin@${interaction.pin_score}` : ''}*\n\n`;
        contentBlocks = [{ type: 'text', text: badge }, ...contentBlocks];
      }

      for (let i = 0; i < contentBlocks.length; i++) {
        const block = contentBlocks[i];

        if (block.type === "text") {
          res.write(`event: content_block_start\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "text", text: "" }
          })}\n\n`);

          const rawBlockText2 = block.text || "";
          const isHtmlContent2 = rawBlockText2.includes("<artifact") || rawBlockText2.trimStart().startsWith("<");
          const text = isHtmlContent2 ? rawBlockText2 : renderText(rawBlockText2);
          const { enabled: ansiEnabled } = require("../utils/markdown-ansi");
          if (ansiEnabled && !isHtmlContent2) {
            if (text.length > 0) {
              res.write(`event: content_block_delta\n`);
              res.write(`data: ${JSON.stringify({
                type: "content_block_delta",
                index: i,
                delta: { type: "text_delta", text }
              })}\n\n`);
            }
          } else {
            const lines = text.split("\n");
            for (const line of lines) {
              const lineWithNl = line + "\n";
              res.write(`event: content_block_delta\n`);
              res.write(`data: ${JSON.stringify({
                type: "content_block_delta",
                index: i,
                delta: { type: "text_delta", text: lineWithNl }
              })}\n\n`);
            }
          }

          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        } else if (block.type === "thinking") {
          res.write(`event: content_block_start\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "thinking", thinking: "" }
          })}\n\n`);
          const thinkingText = block.thinking || "";
          const thinkChunkSize = 40;
          for (let j = 0; j < thinkingText.length; j += thinkChunkSize) {
            res.write(`event: content_block_delta\n`);
            res.write(`data: ${JSON.stringify({
              type: "content_block_delta",
              index: i,
              delta: { type: "thinking_delta", thinking: thinkingText.slice(j, j + thinkChunkSize) }
            })}\n\n`);
          }
          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        } else if (block.type === "tool_use") {
          res.write(`event: content_block_start\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
          })}\n\n`);

          res.write(`event: content_block_delta\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_delta",
            index: i,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          })}\n\n`);

          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        }
      }

      res.write(`event: message_delta\n`);
      res.write(`data: ${JSON.stringify({
        type: "message_delta",
        // Consistency: never claim tool_use if no tool_use block was emitted
        // (a stop_reason pointing at a missing block hangs the client).
        delta: {
          stop_reason: (msg.stop_reason === "tool_use" && !contentBlocks.some(b => b.type === "tool_use"))
            ? "end_turn"
            : (msg.stop_reason || "end_turn"),
          stop_sequence: null,
        },
        usage: { output_tokens: msg.usage?.output_tokens || 0 }
      })}\n\n`);

      res.write(`event: message_stop\n`);
      res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);

      metrics.recordResponse(result.status);
      res.end();
      return;
    }

    // Add routing headers (Phase 3)
    Object.entries(routingHeaders).forEach(([key, value]) => {
      if (value !== undefined) {
        res.setHeader(key, value);
      }
    });

    if (result.headers) {
      Object.entries(result.headers).forEach(([key, value]) => {
        if (value !== undefined) {
          res.setHeader(key, value);
        }
      });
    }

    // Inject visible interaction block into the response body when
    // LYNKR_VISIBLE_ROUTING=true. We only mutate JSON bodies — and only
    // when the response looks like a valid Anthropic Message — so this
    // is a no-op for streamed / error / non-message responses.
    let finalBody = result.body;
    if (
      config.routing?.visibleInteraction &&
      interaction &&
      result.status >= 200 && result.status < 300 &&
      result.body
    ) {
      try {
        // result.body can be: a parsed object, a JSON string, or a Buffer.
        // Normalize to a parsed object first.
        let parsed;
        if (typeof result.body === 'object' && !Buffer.isBuffer(result.body)) {
          parsed = result.body;
        } else {
          const text = Buffer.isBuffer(result.body) ? result.body.toString('utf8') : result.body;
          if (typeof text === 'string' && text.startsWith('{')) {
            parsed = JSON.parse(text);
          }
        }
        if (parsed && typeof parsed === 'object' && parsed.type === 'message') {
          parsed.lynkr_interaction = interaction;
          // Inject a one-line routing badge into content so the TUI renders it.
          if (Array.isArray(parsed.content)) {
            const badge = `*[Lynkr] ${interaction.tier || '—'} → ${interaction.model || '—'} (${interaction.provider || '—'}) · score ${interaction.complexity_score ?? '—'}${interaction.pin_score != null ? ` · pin@${interaction.pin_score}` : ''} · savings ~${interaction.estimated_savings_percent ?? 0}%*\n\n`;
            parsed.content.unshift({ type: 'text', text: badge });
          }
          finalBody = JSON.stringify(parsed);
        }
      } catch (err) {
        logger.debug({ err: err.message }, '[Router] Skipped interaction injection');
      }
    }

    metrics.recordResponse(result.status);
    res.status(result.status).send(finalBody);
  } catch (error) {
    next(error);
  }
});

// List available agents (must come before parameterized routes)
router.get("/v1/agents", (req, res) => {
  try {
    const { listAgents } = require("../agents");
    const agents = listAgents();
    res.json({ agents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Agent stats endpoint (specific path before parameterized)
router.get("/v1/agents/stats", (req, res) => {
  try {
    const { getAgentStats } = require("../agents");
    const stats = getAgentStats();
    res.json({ stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Read agent transcript (specific path with param before catch-all)
router.get("/v1/agents/:agentId/transcript", (req, res) => {
  try {
    const ContextManager = require("../agents/context-manager");
    const cm = new ContextManager();
    const transcript = cm.readTranscript(req.params.agentId);

    if (!transcript) {
      return res.status(404).json({ error: "Transcript not found" });
    }

    res.json({ transcript });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Agent execution details (parameterized - must come last)
router.get("/v1/agents/:executionId", (req, res) => {
  try {
    const { getAgentExecution } = require("../agents");
    const details = getAgentExecution(req.params.executionId);

    if (!details) {
      return res.status(404).json({ error: "Execution not found" });
    }

    res.json(details);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Token usage statistics for a session
router.get("/api/sessions/:sessionId/tokens", (req, res) => {
  try {
    const tokens = require("../utils/tokens");
    const { sessionId } = req.params;
    const session = getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const stats = tokens.getSessionTokenStats(session);

    res.json({
      sessionId,
      stats: {
        turns: stats.turns,
        totalTokens: stats.totalTokens,
        totalCost: parseFloat(stats.totalCost.toFixed(4)),
        averageTokensPerTurn: stats.averageTokensPerTurn,
        cacheHitRate: parseFloat(stats.cacheHitRate) + '%'
      },
      breakdown: stats.breakdown.map(turn => ({
        turn: turn.turn,
        timestamp: turn.timestamp,
        model: turn.model,
        estimated: turn.estimated.total,
        actual: {
          input: turn.actual.inputTokens,
          output: turn.actual.outputTokens,
          cached: turn.actual.cacheReadTokens,
          total: turn.actual.totalTokens
        },
        cost: parseFloat(turn.cost.total.toFixed(6))
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Global token usage statistics (all sessions)
router.get("/api/tokens/stats", (req, res) => {
  try {
    const tokens = require("../utils/tokens");
    const { getAllSessions } = require("../sessions");
    const allSessions = getAllSessions();

    let totalTokens = 0;
    let totalCost = 0;
    let totalTurns = 0;
    let totalSessions = 0;

    for (const session of allSessions) {
      const stats = tokens.getSessionTokenStats(session);
      if (stats.turns > 0) {
        totalTokens += stats.totalTokens;
        totalCost += stats.totalCost;
        totalTurns += stats.turns;
        totalSessions++;
      }
    }

    res.json({
      global: {
        sessions: totalSessions,
        turns: totalTurns,
        totalTokens,
        totalCost: parseFloat(totalCost.toFixed(4)),
        averageTokensPerTurn: totalTurns > 0 ? Math.round(totalTokens / totalTurns) : 0,
        averageTokensPerSession: totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mount OpenAI-compatible endpoints for Cursor IDE support
router.use("/v1", openaiRouter);

// Mount Anthropic-compatible provider discovery endpoints (cc-relay style)
// These provide /v1/models and /v1/providers for Claude Code CLI compatibility
router.use("/v1", providersRouter);

// Headroom compression endpoints
router.get("/metrics/compression", async (req, res) => {
  try {
    const { getCombinedMetrics } = require("../headroom");
    const metrics = await getCombinedMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/metrics/tool-compression", (req, res) => {
  const { getMetrics } = require("../context/tool-result-compressor");
  res.json(getMetrics());
});

router.get("/tee/:id", (req, res) => {
  const { teeGet } = require("../context/tool-result-compressor");
  const content = teeGet(req.params.id);
  if (!content) return res.status(404).json({ error: "Tee entry not found or expired" });
  res.type("text/plain").send(content);
});

router.get("/health/headroom", async (req, res) => {
  try {
    const { getHeadroomManager } = require("../headroom");
    const manager = getHeadroomManager();
    const health = await manager.getHealth();
    res.status(health.healthy ? 200 : 503).json(health);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/headroom/status", async (req, res) => {
  try {
    const { getHeadroomManager } = require("../headroom");
    const manager = getHeadroomManager();
    const status = await manager.getDetailedStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/headroom/restart", async (req, res) => {
  try {
    const { getHeadroomManager } = require("../headroom");
    const manager = getHeadroomManager();
    const result = await manager.restart();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/headroom/logs", async (req, res) => {
  try {
    const { getHeadroomManager } = require("../headroom");
    const manager = getHeadroomManager();
    const tail = parseInt(req.query.tail || "100", 10);
    const logs = await manager.getLogs(tail);

    if (logs === null) {
      return res.status(400).json({ error: "Docker management is disabled" });
    }

    res.type("text/plain").send(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
