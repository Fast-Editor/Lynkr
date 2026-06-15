/**
 * Tool-call id repair for OpenAI-format message arrays.
 *
 * OpenAI-compatible providers (Moonshot/Kimi, OpenAI, OpenRouter, …) reject a
 * request with `Invalid request: tool_call_id <x> is not found` whenever a
 * `tool` message references an id that has no matching entry in a preceding
 * assistant `tool_calls` array. This happens in practice when:
 *
 *   1. A `tool` message's tool_call_id is empty/missing — e.g. Codex Desktop's
 *      bundled-plugin (Browser/Computer-use) function_call_output items, and
 *      synthetic "unsupported call: shell" outputs, arrive without a usable
 *      `call_id`, so both the assistant tool_call id and the tool_call_id
 *      flatten to "". (The error shows a blank id: "tool_call_id  is not found".)
 *   2. An assistant tool_calls entry has an empty/missing id.
 *   3. Ids drift across multiple conversion layers (Responses↔Chat↔Anthropic),
 *      leaving a `tool` message pointing at an id no assistant ever issued.
 *
 * This helper repairs all three in place: it backfills synthetic ids onto
 * assistant tool_calls that lack one, re-links each `tool` message to an unused
 * tool_call id on the nearest preceding assistant, and drops any `tool` message
 * that has no assistant tool_call to attach to (a dangling result is a hard
 * 400 at the provider, so dropping it is strictly safer than forwarding it).
 *
 * @module clients/tool-call-repair
 */

const logger = require("../logger");

function isBlankId(id) {
  return !id || String(id).trim() === "";
}

/**
 * Repair tool_call_id linkage in an OpenAI chat-format message array, in place.
 *
 * @param {Array} messages - OpenAI chat-format messages (role/content, with
 *   assistant `tool_calls` and `tool` `tool_call_id`). Mutated in place.
 * @returns {Array} the same array reference, with orphan tool messages removed.
 */
function repairToolCallIds(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  let synthCounter = 0;
  const nextSyntheticId = () => `call_auto_${synthCounter++}`;

  // Pass 1 — guarantee every assistant tool_call has a non-empty id.
  for (const msg of messages) {
    if (msg && msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc && isBlankId(tc.id)) {
          tc.id = nextSyntheticId();
          logger.info({ assignedId: tc.id }, "Backfilled missing assistant tool_call id");
        }
      }
    }
  }

  // Pass 2 — relink (or drop) every tool message.
  const repaired = [];
  let dropped = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "tool") {
      repaired.push(msg);
      continue;
    }

    // Nearest preceding assistant that carries tool_calls (stop at a user turn).
    let assistant = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j];
      if (!prev) continue;
      if (prev.role === "user") break;
      if (prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0) {
        assistant = prev;
        break;
      }
    }

    const matches =
      assistant &&
      !isBlankId(msg.tool_call_id) &&
      assistant.tool_calls.some((tc) => tc.id === msg.tool_call_id);

    if (matches) {
      repaired.push(msg);
      continue;
    }

    if (assistant) {
      // Pick the first tool_call id not already consumed by an earlier result.
      const usedIds = new Set(
        repaired.filter((r) => r && r.role === "tool" && r.tool_call_id).map((r) => r.tool_call_id)
      );
      const available = assistant.tool_calls.find((tc) => !usedIds.has(tc.id));
      if (available) {
        logger.info(
          { from: isBlankId(msg.tool_call_id) ? "(blank)" : msg.tool_call_id, to: available.id },
          "Repaired tool_call_id linkage"
        );
        msg.tool_call_id = available.id;
        repaired.push(msg);
        continue;
      }
    }

    // No assistant tool_call to attach to — drop the orphan rather than let it
    // 400 the whole request at the provider.
    dropped++;
    logger.warn(
      {
        tool_call_id: isBlankId(msg.tool_call_id) ? "(blank)" : msg.tool_call_id,
        contentPreview: typeof msg.content === "string" ? msg.content.slice(0, 80) : "",
      },
      "Dropped orphan tool message with no matching tool_call"
    );
  }

  if (dropped > 0) {
    logger.info({ dropped, before: messages.length, after: repaired.length }, "Removed orphan tool messages");
  }

  // Rewrite the array contents in place so callers holding this reference see
  // the repaired result.
  messages.length = 0;
  for (const m of repaired) messages.push(m);
  return messages;
}

module.exports = { repairToolCallIds, isBlankId };
