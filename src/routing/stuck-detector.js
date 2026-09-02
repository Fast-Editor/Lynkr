/**
 * Stuck-loop / no-progress detection (ROUTING-NOTES §4.10.5).
 *
 * The escalation ladder reacts to score drift, context overflow, risk
 * keywords, and vision needs — but nothing watches for "the pinned model is
 * thrashing": re-issuing the same tool call with the same input over and
 * over, or repeating the same assistant text verbatim. A cheap-tier model
 * stuck in that state burns turns indefinitely, because every frame of the
 * loop is a mid-tool-exchange pin serve (which is unconditional — tool-call
 * IDs aren't portable across providers, so switching mid-exchange would 400).
 *
 * The safe intervention is the one the pin path already uses for embedded
 * text triggers: don't switch this turn — DROP THE PIN, so the next turn
 * boundary re-routes fresh (and full routing, seeing the whole struggling
 * conversation, escalates on its own signals).
 *
 * Detection is deliberately narrow to keep false positives near zero:
 *   - tool repetition: the last K assistant tool_use blocks are the SAME
 *     tool with the SAME input, K >= LYNKR_STUCK_TOOL_REPEATS (default 3).
 *     Agents legitimately re-run a tool (poll, retry-once); three identical
 *     consecutive calls is a loop.
 *   - text repetition: the last K assistant text blocks are identical after
 *     whitespace normalization, K >= LYNKR_STUCK_TEXT_REPEATS (default 3).
 *
 * Only the tail of the conversation is scanned (SCAN_WINDOW messages), so
 * the check is O(1)-ish per request regardless of conversation length.
 *
 * @module routing/stuck-detector
 */

const SCAN_WINDOW = 20;

function _toolRepeats() {
  const n = Number.parseInt(process.env.LYNKR_STUCK_TOOL_REPEATS, 10);
  return Number.isNaN(n) ? 3 : Math.max(2, n);
}

function _textRepeats() {
  const n = Number.parseInt(process.env.LYNKR_STUCK_TEXT_REPEATS, 10);
  return Number.isNaN(n) ? 3 : Math.max(2, n);
}

function _enabled() {
  return process.env.LYNKR_STUCK_DETECTOR_ENABLED !== 'false';
}

/**
 * Extract, oldest→newest, the assistant tool_use signatures and text blocks
 * from the tail of the conversation.
 */
function _assistantTail(messages) {
  const tail = messages.slice(-SCAN_WINDOW);
  const toolSigs = [];
  const texts = [];
  for (const msg of tail) {
    if (msg?.role !== 'assistant') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (block?.type === 'tool_use') {
        let inputSig;
        try {
          inputSig = JSON.stringify(block.input ?? null);
        } catch {
          inputSig = String(block.input);
        }
        toolSigs.push(`${block.name}::${inputSig}`);
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        const normalized = block.text.replace(/\s+/g, ' ').trim();
        if (normalized.length > 0) texts.push(normalized);
      }
    }
    // String-content assistant messages count as text blocks too.
    if (typeof msg.content === 'string') {
      const normalized = msg.content.replace(/\s+/g, ' ').trim();
      if (normalized.length > 0) texts.push(normalized);
    }
  }
  return { toolSigs, texts };
}

function _trailingRun(items) {
  if (items.length === 0) return 0;
  const last = items[items.length - 1];
  let run = 0;
  for (let i = items.length - 1; i >= 0 && items[i] === last; i--) run++;
  return run;
}

/**
 * Detect a stuck loop in the conversation tail.
 *
 * @param {object} payload — request payload with .messages
 * @returns {{ stuck: boolean, reason?: 'tool_repetition'|'text_repetition',
 *             repeats?: number, signature?: string }}
 */
function detectStuckLoop(payload) {
  if (!_enabled()) return { stuck: false };
  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length < 4) return { stuck: false };

  const { toolSigs, texts } = _assistantTail(messages);

  const toolRun = _trailingRun(toolSigs);
  if (toolRun >= _toolRepeats()) {
    return {
      stuck: true,
      reason: 'tool_repetition',
      repeats: toolRun,
      // Truncated for logging — the full input may be huge or sensitive.
      signature: toolSigs[toolSigs.length - 1].slice(0, 120),
    };
  }

  const textRun = _trailingRun(texts);
  if (textRun >= _textRepeats()) {
    return {
      stuck: true,
      reason: 'text_repetition',
      repeats: textRun,
      signature: texts[texts.length - 1].slice(0, 120),
    };
  }

  return { stuck: false };
}

module.exports = { detectStuckLoop };
