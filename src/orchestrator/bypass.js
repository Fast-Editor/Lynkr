/**
 * Request Bypass
 *
 * Short-circuits Claude Code CLI housekeeping requests that don't need a real
 * model call:
 *   - "Warmup" pings the CLI sends to prime a connection
 *   - Topic/title extraction (the CLI asks for {"isNewTopic":..,"title":..})
 *   - Single-word "count" / "Warmup" probes
 *
 * Returning a canned response here saves a full provider round-trip (latency
 * and tokens) on every session. Inspired by 9router's bypassHandler.
 *
 * Always on — only ever returns a canned response for unambiguous Claude CLI
 * housekeeping traffic, never for real work.
 *
 * @module orchestrator/bypass
 */

const logger = require("../logger");

/** Flatten Anthropic content (string | block[]) into plain text. */
function getText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/** Flatten the top-level Anthropic `system` field (string | block[]). */
function getSystemText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((s) => s && s.type === "text" && typeof s.text === "string")
      .map((s) => s.text)
      .join(" ");
  }
  return "";
}

/**
 * Decide whether a request is a bypassable Claude CLI housekeeping call.
 *
 * @param {object} args
 * @param {object} args.payload - The Anthropic request body.
 * @param {object} [args.headers] - Lowercased request headers.
 * @returns {{kind: string, text: string}|null} bypass descriptor or null.
 */
function detectBypass({ payload, headers = {} }) {
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return null;
  }

  // Only bypass Claude CLI traffic — other clients use these endpoints for
  // real work and must never receive a canned response.
  const ua = String(headers["user-agent"] || "").toLowerCase();
  if (!ua.includes("claude-cli")) return null;

  const messages = payload.messages;
  const lastMsg = messages[messages.length - 1];

  // Pattern 1: Title prefill — the CLI seeds an assistant turn with just "{"
  // to coax a JSON object out of the model.
  if (lastMsg?.role === "assistant") {
    const firstBlockText =
      Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === "text"
        ? lastMsg.content[0].text
        : typeof lastMsg.content === "string"
          ? lastMsg.content
          : "";
    if (firstBlockText.trim() === "{") {
      return { kind: "title_prefill", text: "{}" };
    }
  }

  // Pattern 2: Topic/title extraction — system prompt asks for isNewTopic.
  // Synthesize a title from the first user message instead of calling a model.
  const systemText = getSystemText(payload.system);
  if (systemText.includes("isNewTopic")) {
    const userMsg = messages.find((m) => m.role === "user");
    const userText = getText(userMsg?.content).trim();
    const title = userText.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
    return {
      kind: "title_extraction",
      text: JSON.stringify({ isNewTopic: true, title }),
    };
  }

  // Pattern 3: Warmup / count / quota probes — a single short user message.
  // "quota" observed live 2026-07-09 on claude-cli 2.1.206: the unbypassed
  // probe reached the SIMPLE-tier model, whose confused reply ("Quota what?
  // Clarify…") was auto-extracted into long-term memory and re-injected
  // into real turns — a self-feeding pollution loop.
  if (messages.length === 1 && messages[0]?.role === "user") {
    const firstText = getText(messages[0].content).trim();
    if (firstText === "Warmup" || firstText === "count" || firstText === "quota") {
      return { kind: firstText.toLowerCase(), text: "OK" };
    }
  }

  return null;
}

/**
 * Build the processMessage-shaped response for a bypass descriptor.
 * Matches the `{ status, body, terminationReason }` contract the router
 * consumes (same shape as the prompt-cache early returns).
 *
 * @param {{kind: string, text: string}} bypass
 * @param {string} model - Model id to echo back.
 * @returns {{status: number, body: object, terminationReason: string}}
 */
function buildBypassResponse(bypass, model) {
  logger.info({ kind: bypass.kind }, "[Bypass] Short-circuiting CLI housekeeping request");
  return {
    status: 200,
    body: {
      id: `msg_bypass_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: bypass.text }],
      model: model || "claude-3-unknown",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      lynkr_bypass: { kind: bypass.kind },
    },
    terminationReason: `bypass_${bypass.kind}`,
  };
}

module.exports = {
  detectBypass,
  buildBypassResponse,
};
