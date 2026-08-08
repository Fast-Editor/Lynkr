/**
 * Conversation Distiller — L0-L3 Pipeline (TencentDB-Agent-Memory inspired)
 *
 * Long conversations resend every turn on every request. Once a
 * conversation reaches the turn threshold, this module replaces the older
 * turns with one compact distilled block and keeps only the most recent
 * turns verbatim:
 *
 *   L0 — raw turns (the messages themselves, dropped after distillation)
 *   L1 — facts/decisions extracted from the dropped turns (heuristic)
 *   L2 — scenario summary: what was asked, done, and decided
 *   L3 — persona: durable user preferences pulled from the memory store
 *
 * Large repeated blocks inside the dropped turns are dereferenced through
 * the wiki registry before summarization. All processing is local and
 * synchronous — no LLM calls.
 */

const store = require("./store");
const extractor = require("./extractor");
const wiki = require("./wiki");
const config = require("../config");
const logger = require("../logger");

const MAX_SCENARIO_POINTS = 12;
const MAX_PERSONA_ITEMS = 5;
const MAX_POINT_CHARS = 140;
const DEFAULT_REFRESH_EVERY_TURNS = 5;
const MAX_FROZEN_SESSIONS = 500;

function distillConfig() {
  return config.memory?.distillation ?? {};
}

// ---------------------------------------------------------------------------
// Frozen distilled blocks (Phase 5, cache-aware routing).
//
// Re-distilling on every request rewrites the front of the conversation each
// turn, which invalidates the provider's prompt cache wholesale — on exactly
// the long sessions where caching matters most. Once emitted, a session's
// distilled block is frozen: the same block bytes and the same split point
// are served verbatim until K more user turns have accumulated
// (config.memory.distillation.refreshEveryTurns, default 5). Each refresh is
// then ONE deliberate, scheduled cache write instead of one per request.
// ---------------------------------------------------------------------------

/** @type {Map<string, {frozenAtTurns:number, splitIdx:number, boundaryFp:string, distilledContent:string, stats:Object}>} */
const _frozen = new Map();

function _refreshEveryTurns() {
  const k = distillConfig().refreshEveryTurns;
  return Number.isFinite(k) && k > 0 ? k : DEFAULT_REFRESH_EVERY_TURNS;
}

/**
 * Cheap byte-stability fingerprint for the frozen prefix: split position
 * plus samples of the first and boundary messages. Detects client-side
 * history rewrites (compaction, edits) that make the frozen block stale.
 */
function _boundaryFingerprint(messages, splitIdx) {
  const sample = (m) => {
    if (!m) return "?";
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return `${m.role}:${c.slice(0, 80)}`;
  };
  return `${splitIdx}|${sample(messages[0])}|${sample(messages[splitIdx - 1])}`;
}

function _rememberFrozen(sessionId, entry) {
  if (!sessionId) return;
  _frozen.delete(sessionId);
  _frozen.set(sessionId, entry);
  if (_frozen.size > MAX_FROZEN_SESSIONS) {
    const oldest = _frozen.keys().next().value;
    if (oldest !== undefined) _frozen.delete(oldest);
  }
}

/** Test helper — drop all frozen blocks. */
function _clearFrozen() {
  _frozen.clear();
}

/**
 * A "real" user turn carries user-authored text — tool_result-only
 * user-role messages are plumbing, not turns.
 */
function isRealUserTurn(msg) {
  if (msg?.role !== "user") return false;
  if (typeof msg.content === "string") return msg.content.trim().length > 0;
  if (Array.isArray(msg.content)) {
    return msg.content.some(b => b?.type === "text" && b.text?.trim());
  }
  return false;
}

function realUserTurnIndices(messages) {
  const indices = [];
  for (let i = 0; i < messages.length; i++) {
    if (isRealUserTurn(messages[i])) indices.push(i);
  }
  return indices;
}

const CHARS_PER_TOKEN = 4;

/**
 * Rough token estimate for the message history (text + tool content).
 */
function estimateHistoryTokens(messages) {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.text) chars += block.text.length;
        else if (typeof block?.content === "string") chars += block.content.length;
        else if (Array.isArray(block?.content)) {
          for (const item of block.content) {
            chars += typeof item === "string" ? item.length : (item?.text?.length ?? 0);
          }
        }
        if (block?.input) chars += JSON.stringify(block.input).length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Whether the conversation should be distilled. Two triggers:
 *  - turn count: conversation reached turnThreshold user turns, OR
 *  - size rescue: history alone exceeds tokenThreshold estimated tokens
 *    (protects small-context models that overflow long before the turn
 *    threshold — observed with 4k-context Ollama models dying at turn 8).
 * Either way there must be at least one turn older than the keep window,
 * or there is nothing to distill.
 */
function needsDistillation(messages) {
  const cfg = distillConfig();
  if (cfg.enabled === false) return false;
  if (!messages?.length) return false;

  const turns = realUserTurnIndices(messages).length;
  const keepRecent = cfg.keepRecentTurns ?? 3;
  if (turns <= keepRecent) return false;

  if (turns >= (cfg.turnThreshold ?? 10)) return true;

  const tokenThreshold = cfg.tokenThreshold ?? 3000;
  return estimateHistoryTokens(messages) >= tokenThreshold;
}

function extractText(msg) {
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .filter(b => b?.type === "text" && b.text)
      .map(b => b.text)
      .join(" ");
  }
  return "";
}

function truncate(text, max = MAX_POINT_CHARS) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * L2 — scenario summary of the dropped turns: user asks, decisions and
 * facts surfaced by the assistant, and tool usage counts.
 */
function buildScenario(oldMessages) {
  const asks = [];
  const toolCounts = new Map();
  let assistantText = "";

  for (const msg of oldMessages) {
    if (isRealUserTurn(msg)) {
      asks.push(truncate(extractText(msg), 100));
    } else if (msg.role === "assistant") {
      assistantText += `${extractText(msg)}\n`;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "tool_use" && block.name) {
            toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
          }
        }
      }
    }
  }

  // L1 — reuse the extraction patterns on the dropped assistant output
  const decisions = extractor.extractByType(assistantText, "decision").slice(0, 4);
  const facts = extractor.extractByType(assistantText, "fact").slice(0, 4);

  const parts = [];
  if (asks.length) {
    const shown = asks.slice(-MAX_SCENARIO_POINTS);
    const omitted = asks.length - shown.length;
    parts.push(`Requests${omitted > 0 ? ` (${omitted} earlier omitted)` : ""}: ${shown.join(" → ")}`);
  }
  if (decisions.length) parts.push(`Decisions: ${decisions.map(d => truncate(d)).join("; ")}`);
  if (facts.length) parts.push(`Facts: ${facts.map(f => truncate(f)).join("; ")}`);
  if (toolCounts.size) {
    const tools = Array.from(toolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
      .join(", ");
    parts.push(`Tools used: ${tools}`);
  }

  return parts.join("\n");
}

/**
 * L3 — persona line from durable preference memories (global + session).
 */
function buildPersona(sessionId) {
  try {
    const prefs = store
      .getMemoriesByType("preference", 50)
      .filter(m => m.sessionId === null || m.sessionId === sessionId)
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
      .slice(0, MAX_PERSONA_ITEMS);

    if (!prefs.length) return "";
    return prefs.map(m => truncate(m.content, 80)).join("; ");
  } catch (err) {
    logger.warn({ err, sessionId }, "[distiller] Persona build failed");
    return "";
  }
}

/**
 * Distill a long conversation: dereference repeated large blocks via wiki,
 * summarize everything before the last keepRecentTurns user turns into one
 * block, and keep the recent turns verbatim.
 *
 * The split lands on a real user turn boundary, so assistant tool_use /
 * user tool_result pairs are never separated.
 *
 * @param {Array} messages - Full conversation
 * @param {Object} options
 * @param {string} options.sessionId
 * @returns {{messages: Array, applied: boolean, stats: Object}}
 */
function distillMessages(messages, options = {}) {
  const { sessionId = null } = options;

  if (!needsDistillation(messages)) {
    return { messages, applied: false, stats: {} };
  }

  const keepRecent = distillConfig().keepRecentTurns ?? 3;
  const turnIndices = realUserTurnIndices(messages);

  // Phase 5 freeze: serve the session's frozen block verbatim while it is
  // still fresh (fewer than K user turns since it was built) and the
  // history prefix it covers is byte-stable. The block and split point are
  // identical across requests, so the provider prompt cache keeps hitting.
  if (sessionId) {
    const cached = _frozen.get(sessionId);
    if (
      cached
      && cached.splitIdx < messages.length
      && turnIndices.length - cached.frozenAtTurns < _refreshEveryTurns()
      && _boundaryFingerprint(messages, cached.splitIdx) === cached.boundaryFp
    ) {
      return {
        messages: [
          { role: "user", content: cached.distilledContent },
          ...messages.slice(cached.splitIdx),
        ],
        applied: true,
        stats: { ...cached.stats, fromFrozenCache: true },
      };
    }
  }

  const splitIdx = turnIndices[Math.max(0, turnIndices.length - keepRecent)];

  if (!splitIdx) {
    return { messages, applied: false, stats: {} };
  }

  const oldMessages = messages.slice(0, splitIdx);
  const recentMessages = messages.slice(splitIdx);

  // Wiki pass over dropped turns: registers large blocks for cross-request
  // dedup and shrinks repeats before the scenario is built
  const { messages: dereferenced, stats: wikiStats } = wiki.dereferenceMessages(oldMessages);

  const scenario = buildScenario(dereferenced);
  const persona = buildPersona(sessionId);

  const sections = [`[Distilled context — earlier ${turnIndices.length - keepRecent} turns compressed]`];
  if (persona) sections.push(`User profile: ${persona}`);
  if (scenario) sections.push(scenario);

  const distilledBlock = {
    role: "user",
    content: sections.join("\n"),
  };

  const originalChars = JSON.stringify(oldMessages).length;
  const distilledChars = distilledBlock.content.length;

  const stats = {
    droppedMessages: oldMessages.length,
    keptMessages: recentMessages.length,
    originalChars,
    distilledChars,
    savingsPct: originalChars > 0
      ? (((originalChars - distilledChars) / originalChars) * 100).toFixed(1)
      : "0.0",
    wiki: wikiStats,
  };

  logger.debug({ sessionId, ...stats }, "[distiller] Conversation distilled");

  // Freeze the block for the next K user turns (Phase 5). Keyed by the
  // split fingerprint so a client-side history rewrite invalidates it.
  _rememberFrozen(sessionId, {
    frozenAtTurns: turnIndices.length,
    splitIdx,
    boundaryFp: _boundaryFingerprint(messages, splitIdx),
    distilledContent: distilledBlock.content,
    stats,
  });

  return {
    messages: [distilledBlock, ...recentMessages],
    applied: true,
    stats,
  };
}

module.exports = {
  needsDistillation,
  distillMessages,
  buildScenario,
  buildPersona,
  isRealUserTurn,
  estimateHistoryTokens,
  _clearFrozen,
};
