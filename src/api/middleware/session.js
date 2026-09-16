const crypto = require("crypto");
const { getOrCreateSession } = require("../../sessions/store");
const logger = require("../../logger");

const PRIMARY_HEADER = "x-session-id";
const FALLBACK_HEADERS = [
  "x-claude-session-id",
  "x-claude-session",
  "x-claude-conversation-id",
  "anthropic-session-id",
  // open-code-review per-bundle affinity: internal/llm/sessionkey.go sends
  // `x-session-affinity: <ocr_session_key>` (real task key, or an
  // auto-generated fallback). Each file bundle gets its own key so bundles
  // route independently instead of sharing one PR-wide pin.
  "x-session-affinity",
];

function normaliseSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  // Ignore unsubstituted templates (OCR sends literal "{ocr_session_key}"
  // when no key is configured — its own client falls back to auto-generated).
  if (trimmed.includes("{") && trimmed.includes("}")) return null;
  return trimmed;
}

function _contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b?.type === "text" || b?.type === "input_text") && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/**
 * WS1.5 — content-derived session fingerprint.
 *
 * Claude Code (and most Anthropic-API clients) send NO session identifier:
 * no header, no body field. Before this, every request got a fresh
 * crypto.randomUUID(), which made WS1's sticky-session pinning a no-op —
 * live telemetry showed 278 distinct session_ids across 286 requests.
 *
 * These clients DO resend the full conversation history on every turn, so
 * the first user message is a stable identity for the whole conversation.
 * Hash it (plus the system-prompt head and user-agent, to separate two
 * users who both open with "hi") and every turn of one conversation maps
 * to the same session id → the WS1 pin holds.
 *
 * Properties that fall out of this choice:
 *   - Compaction that rewrites/drops the first message → new fingerprint
 *     → fresh routing decision. That matches WS1's compaction semantics.
 *   - <system-reminder> blocks are stripped before hashing: Claude Code
 *     injects them into user messages and their contents (dates, notices)
 *     can vary between replays of the same conversation.
 *   - No user text at all → return null; caller falls back to the
 *     per-request UUID (previous behaviour).
 *
 * Disable with LYNKR_SESSION_FINGERPRINT=false.
 */
function fingerprintSessionId(req) {
  if (process.env.LYNKR_SESSION_FINGERPRINT === "false") return null;
  let messages = req.body?.messages;
  // OpenAI Responses API (/v1/responses) sends `input` — a string or an
  // array of message-shaped items — instead of `messages` (issue #95).
  if (!Array.isArray(messages)) {
    const input = req.body?.input;
    if (typeof input === "string" && input.trim()) {
      messages = [{ role: "user", content: input }];
    } else if (Array.isArray(input)) {
      messages = input;
    }
  }
  if (!Array.isArray(messages)) return null;
  const firstUser = messages.find((m) => m?.role === "user");
  if (!firstUser) return null;

  const raw = _contentText(firstUser.content);
  const stripped = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
  const text = (stripped || raw.trim()).slice(0, 2000);
  if (!text) return null;

  const systemText = _contentText(req.body?.system).slice(0, 500);
  const ua = req.headers["user-agent"] || "";
  const hash = crypto
    .createHash("sha256")
    .update(text + "\0" + systemText + "\0" + ua)
    .digest("hex")
    .slice(0, 32);
  return "fp-" + hash;
}

function extractSessionId(req) {
  const primary = normaliseSessionId(req.headers[PRIMARY_HEADER]);
  if (primary) return primary;

  for (const header of FALLBACK_HEADERS) {
    const candidate = normaliseSessionId(req.headers[header]);
    if (candidate) return candidate;
  }

  const body = req.body ?? {};
  const bodyId =
    normaliseSessionId(body.session_id) ??
    normaliseSessionId(body.sessionId) ??
    normaliseSessionId(body.conversation_id);
  if (bodyId) return bodyId;

  // WS1.5 — prefer a conversation fingerprint over a throwaway UUID so
  // sticky-session pinning works for clients that send no session id.
  const fingerprint = fingerprintSessionId(req);
  if (fingerprint) {
    req.fingerprintedSessionId = true;
    return fingerprint;
  }

  const generated = crypto.randomUUID();
  req.generatedSessionId = true;
  return generated;
}

function sessionMiddleware(req, res, next) {
  try {
    const sessionId = extractSessionId(req);
    req.sessionId = sessionId;

    // Add sessionId to logger context for this request
    req.log = logger.child({ sessionId });

    // Skip DB persistence for auto-generated (ephemeral) session IDs and
    // content fingerprints. Both are created when the client doesn't send
    // a session header, so storing them just bloats the DB with throwaway
    // records. (WS1's pin store lives in telemetry.db, not here — the
    // fingerprint still drives pinning without session-store persistence.)
    if (req.generatedSessionId || req.fingerprintedSessionId) {
      req.session = {
        id: sessionId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
        history: [],
        _ephemeral: true,
      };
    } else {
      req.session = getOrCreateSession(sessionId);
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  sessionMiddleware,
  SESSION_HEADER: PRIMARY_HEADER,
  // WS1.5 — exported for unit tests.
  fingerprintSessionId,
  extractSessionId,
};
