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

function distillConfig() {
  return config.memory?.distillation ?? {};
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

/**
 * Whether the conversation is long enough to distill.
 */
function needsDistillation(messages) {
  if (distillConfig().enabled === false) return false;
  if (!messages?.length) return false;

  const threshold = distillConfig().turnThreshold ?? 10;
  return realUserTurnIndices(messages).length >= threshold;
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
};
