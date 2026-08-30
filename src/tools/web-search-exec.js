/**
 * Server-side web_search / web_fetch execution — narrowly scoped resurrection.
 *
 * Context: src/tools/web.js used to implement this (SearXNG-backed search,
 * host-allowlisted fetch) and was deleted 2026-07-22 in commit b32e988,
 * "Remove server-mode tool execution: Lynkr always forwards tool calls to
 * the client." That was a deliberate architecture pivot, not a bug — Lynkr
 * stopped executing ANY tool itself.
 *
 * This does NOT reintroduce general server-mode tool execution. It only
 * auto-resolves `web_search`/`web_fetch` calls, and ONLY when the calling
 * client is unrecognized by src/routing/client-profiles.js's detectClient()
 * — i.e. Lynkr has no signal the caller can fulfill the call itself.
 * Known harnesses (Claude Code / Claude Desktop's shared agent-sdk — both
 * present as `claude-cli/...`, Cursor, goose, Codex) already execute these
 * client-side today and are never routed through this module; see the call
 * site in src/orchestrator/index.js's runAgentLoop.
 *
 * @module tools/web-search-exec
 */

const config = require("../config");
const logger = require("../logger");

const AUTO_RESOLVABLE_NAMES = new Set(["web_search", "websearch", "web_fetch", "webfetch"]);

/**
 * @param {string} name
 * @returns {boolean}
 */
function isAutoResolvable(name) {
  return AUTO_RESOLVABLE_NAMES.has(String(name || "").toLowerCase());
}

/**
 * True only when every call in this batch is one we can resolve ourselves —
 * a mixed batch (one auto-resolvable + one arbitrary client tool) falls
 * through to the normal "forward to client" path untouched, since we can't
 * partially resolve a batch the model expects answered together.
 *
 * @param {Array} toolCalls - normalized {id, function:{name}} or {name} calls
 * @returns {boolean}
 */
function canAutoResolveAll(toolCalls) {
  return Array.isArray(toolCalls) && toolCalls.length > 0
    && toolCalls.every((tc) => isAutoResolvable(tc?.function?.name ?? tc?.name));
}

function isHostAllowed(urlStr) {
  if (config.webSearch?.allowAllHosts) return true;
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    const allowed = config.webSearch?.allowedHosts;
    return Array.isArray(allowed) && allowed.includes(host);
  } catch {
    return false;
  }
}

async function _withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SearXNG-backed search. Retries transient failures per config.webSearch
 * (retryEnabled/maxRetries) — mirrors the retry policy the deleted web.js
 * had, since a single dropped connection to a local sidecar shouldn't fail
 * the whole tool call.
 *
 * @param {string} query
 * @returns {Promise<Object>} { query, results: [{title,url,snippet}] } or { error }
 */
async function searchWeb(query) {
  const endpoint = config.webSearch?.endpoint || "http://localhost:8888/search";
  const timeoutMs = config.webSearch?.timeoutMs || 10000;
  const maxRetries = config.webSearch?.retryEnabled ? (config.webSearch?.maxRetries ?? 2) : 0;
  const url = `${endpoint}?q=${encodeURIComponent(query || "")}&format=json`;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await _withTimeout(
        (signal) => fetch(url, { signal }),
        timeoutMs,
      );
      if (!res.ok) {
        lastErr = `search backend returned HTTP ${res.status}`;
        continue;
      }
      const json = await res.json();
      const results = (Array.isArray(json.results) ? json.results : [])
        .slice(0, 8)
        .map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
      return { query, results };
    } catch (err) {
      lastErr = err.message;
    }
  }
  logger.warn({ query, endpoint, err: lastErr }, "[web-search-exec] search failed after retries");
  return { query, error: `search failed: ${lastErr}` };
}

const MAX_REDIRECT_HOPS = 5;

/**
 * Read up to `maxBytes` (well, chars — decoded text) from a Response body,
 * without ever buffering more than that in memory. Node's global fetch
 * always provides a ReadableStream body; the non-streaming fallback exists
 * only for defensiveness.
 *
 * @param {Response} response
 * @param {number} maxChars
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
async function _readBounded(response, maxChars) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const full = await response.text();
    return { text: full.slice(0, maxChars), truncated: full.length > maxChars };
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) return { text, truncated: false };
      text += decoder.decode(value, { stream: true });
    }
    // Hit the cap — confirm there was more data waiting (vs. landing exactly
    // on the boundary) so `truncated` is accurate either way.
    const over = text.length > maxChars;
    if (over) text = text.slice(0, maxChars);
    const { done } = await reader.read().catch(() => ({ done: true }));
    return { text, truncated: over || !done };
  } finally {
    try { await reader.cancel(); } catch { /* best-effort; body may already be spent */ }
  }
}

/**
 * Generic URL fetch, host-allowlisted per config.webSearch (allowAllHosts /
 * allowedHosts), truncated per config.webSearch.bodyPreviewMax.
 *
 * Redirects are followed manually, not via fetch's default redirect:"follow"
 * — Node's global fetch would otherwise follow a redirect from an allowlisted
 * endpoint straight to a blocked/private address without ever re-checking
 * allowedHosts, defeating the allowlist entirely. Every hop's resolved
 * Location is validated the same way the original targetUrl was.
 *
 * The same per-hop abort timer stays alive through body consumption too —
 * previously it was cleared the moment fetch() resolved (headers received),
 * before the body was ever read, so a slow or hostile allowed endpoint could
 * hold the response open indefinitely with no timeout, and `.slice()` only
 * trimmed the string AFTER it had already been fully buffered in memory.
 * _readBounded() now runs inside the same _withTimeout(signal) call as the
 * fetch itself, so an abort mid-read is a real abort, not just a display cap.
 *
 * @param {string} targetUrl
 * @returns {Promise<Object>}
 */
async function fetchUrl(targetUrl) {
  if (!targetUrl) return { error: "no url provided" };
  if (!isHostAllowed(targetUrl)) {
    logger.warn({ url: targetUrl }, "[web-search-exec] fetch blocked — host not allowed");
    return { url: targetUrl, error: "host not in allowedHosts (WEB_SEARCH_ALLOW_ALL=false)" };
  }
  const maxPreview = config.webSearch?.bodyPreviewMax || 10000;
  const timeoutMs = config.webSearch?.timeoutMs || 10000;

  let currentUrl = targetUrl;
  try {
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECT_HOPS) {
        return { url: targetUrl, error: `too many redirects (>${MAX_REDIRECT_HOPS})` };
      }

      const outcome = await _withTimeout(async (signal) => {
        const response = await fetch(currentUrl, { signal, redirect: "manual" });
        if (response.status >= 300 && response.status < 400) {
          return { redirect: true, status: response.status, location: response.headers.get("location") };
        }
        const { text, truncated } = await _readBounded(response, maxPreview);
        return { redirect: false, status: response.status, text, truncated };
      }, timeoutMs);

      if (outcome.redirect) {
        if (!outcome.location) {
          return { url: currentUrl, status: outcome.status, error: "redirect with no Location header" };
        }
        const nextUrl = new URL(outcome.location, currentUrl).toString();
        if (!isHostAllowed(nextUrl)) {
          logger.warn({ from: currentUrl, to: nextUrl }, "[web-search-exec] blocked redirect to disallowed host");
          return { url: targetUrl, error: "redirect target host not in allowedHosts" };
        }
        currentUrl = nextUrl;
        continue;
      }

      return {
        url: currentUrl,
        status: outcome.status,
        content: outcome.text,
        truncated: outcome.truncated,
      };
    }
  } catch (err) {
    logger.warn({ url: targetUrl, err: err.message }, "[web-search-exec] fetch failed");
    return { url: targetUrl, error: `fetch failed: ${err.message}` };
  }
}

/**
 * Execute every call in this (pre-checked via canAutoResolveAll) batch and
 * append the matching assistant tool_use + user tool_result turns to
 * `messages`, mirroring exactly what a real client round-trip would send
 * back — so the next agent-loop iteration behaves identically to a normal
 * client-fulfilled tool exchange, and the client never sees the exchange.
 *
 * @param {Array} toolCalls
 * @param {Array} messages - mutated in place (push only, never rewritten)
 */
async function autoResolve(toolCalls, messages) {
  const toolUseBlocks = [];
  const toolResultBlocks = [];

  for (const tc of toolCalls) {
    const rawName = tc.function?.name ?? tc.name ?? "";
    const name = String(rawName).toLowerCase();
    let input = {};
    try {
      const raw = tc.function?.arguments ?? tc.input ?? {};
      input = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
    } catch { /* leave input empty — result will just reflect an empty query/url */ }

    toolUseBlocks.push({ type: "tool_use", id: tc.id, name: rawName, input });

    const result = (name === "web_search" || name === "websearch")
      ? await searchWeb(input.query || input.q || "")
      : await fetchUrl(input.url || "");

    toolResultBlocks.push({
      type: "tool_result",
      tool_use_id: tc.id,
      content: JSON.stringify(result),
    });
  }

  messages.push({ role: "assistant", content: toolUseBlocks });
  messages.push({ role: "user", content: toolResultBlocks });
}

module.exports = { canAutoResolveAll, autoResolve, searchWeb, fetchUrl, isAutoResolvable };
