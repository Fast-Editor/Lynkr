/**
 * Trajectory Compressor
 *
 * Reads completed agent sessions out of Lynkr's session DB,
 * joins with routing telemetry to pick up tier / score / outcome
 * metadata, and emits JSONL training samples for fine-tuning small
 * models on tool-call generation and tier-routing decisions.
 *
 * Each line of the output JSONL is a self-contained sample:
 *
 *   {
 *     "session_id":     "...",
 *     "messages":       [{"role": "...", "content": ...}, ...],
 *     "tool_calls":     [...],
 *     "outcome":        "success" | "error",
 *     "tier":           "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING",
 *     "complexity_score": 38,
 *     "model_used":     "gpt-4o",
 *     "provider_used":  "azure-openai",
 *     "tokens_in":      1234,
 *     "tokens_out":     456,
 *     "latency_ms":     2400,
 *     "started_at":     "2026-05-03T10:11:12Z",
 *     "ended_at":       "2026-05-03T10:11:14Z"
 *   }
 *
 * The compressor is read-only — it never modifies the source DBs.
 */

const fs = require("fs");
const path = require("path");

const db = require("../db");
const telemetry = require("../routing/telemetry");

// Patterns for the optional --anonymize pass. Order matters: more
// specific patterns first so they don't get clobbered by generic ones.
const ANONYMIZE_PATTERNS = [
  // API keys and bearer tokens
  [/sk-[A-Za-z0-9_-]{20,}/g, "<API_KEY>"],
  [/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <REDACTED>"],
  [/dapi_[A-Za-z0-9_-]+/g, "<DATABRICKS_KEY>"],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<JWT>"],
  // AWS keys
  [/AKIA[0-9A-Z]{16}/g, "<AWS_ACCESS_KEY>"],
  // Email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<EMAIL>"],
  // Absolute filesystem paths under /Users/<name>/ or /home/<name>/
  [/\/Users\/[^/\s]+/g, "/Users/<USER>"],
  [/\/home\/[^/\s]+/g, "/home/<USER>"],
  // IPs
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<IP>"],
  // Hostnames containing service-now / corporate domains (configurable)
  [/[A-Za-z0-9-]+\.service-now\.com/gi, "<SERVICENOW_HOST>"],
];

function anonymize(value) {
  if (typeof value === "string") {
    let out = value;
    for (const [re, replacement] of ANONYMIZE_PATTERNS) {
      out = out.replace(re, replacement);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(anonymize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = anonymize(v);
    return out;
  }
  return value;
}

function parseJsonSafe(text, fallback = null) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * List session ids in a window, optionally filtered by tier.
 */
function listSessions({ since = null, tier = null } = {}) {
  if (!db) return [];

  const rows = since
    ? db
        .prepare(
          "SELECT id, created_at, updated_at, metadata FROM sessions WHERE updated_at >= ? ORDER BY updated_at DESC"
        )
        .all(since)
    : db.prepare("SELECT id, created_at, updated_at, metadata FROM sessions ORDER BY updated_at DESC").all();

  if (!tier) return rows;

  // Tier filter requires joining against routing telemetry — we do that
  // per-session lazily so we don't pre-load the whole telemetry table.
  return rows.filter((s) => sessionTier(s.id) === tier);
}

/**
 * Find the dominant tier picked across a session's telemetry rows.
 */
function sessionTier(sessionId) {
  try {
    const rows = telemetry.query({ session_id: sessionId, limit: 1000 });
    if (rows.length === 0) return null;
    const counts = {};
    for (const r of rows) counts[r.tier || "UNKNOWN"] = (counts[r.tier || "UNKNOWN"] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  } catch {
    return null;
  }
}

/**
 * Build one trajectory record for a single session.
 */
function buildTrajectory(session, options = {}) {
  if (!db) return null;

  const historyStmt = db.prepare(
    "SELECT role, type, status, content, metadata, timestamp FROM session_history WHERE session_id = ? ORDER BY timestamp ASC"
  );
  const history = historyStmt.all(session.id);

  // Convert each session_history row into a chat message, preserving
  // tool-call structure when present in metadata.
  const messages = [];
  const toolCalls = [];

  for (const row of history) {
    const meta = parseJsonSafe(row.metadata) || {};
    const content = parseJsonSafe(row.content, row.content);

    if (row.role === "tool" || row.type === "tool_use" || row.type === "tool_result") {
      // Capture tool calls as a separate stream alongside the chat
      toolCalls.push({
        type: row.type,
        timestamp: row.timestamp,
        content,
        metadata: meta,
      });
    }

    if (row.role === "user" || row.role === "assistant" || row.role === "system") {
      messages.push({
        role: row.role,
        content,
      });
    }
  }

  // Pull telemetry records associated with this session to enrich.
  const teleRows = telemetry.query({ session_id: session.id, limit: 1000 });

  const totals = teleRows.reduce(
    (acc, r) => {
      acc.tokens_in += r.input_tokens || 0;
      acc.tokens_out += r.output_tokens || 0;
      acc.latency_ms += r.latency_ms || 0;
      return acc;
    },
    { tokens_in: 0, tokens_out: 0, latency_ms: 0 }
  );

  // Pick the modal tier (most-used) and the most-recent model/provider.
  const tier = sessionTier(session.id);
  const last = teleRows[0]; // telemetry.query orders DESC
  const errorRow = teleRows.find((r) => r.error_type);
  const outcome = errorRow ? "error" : "success";
  const complexityAvg =
    teleRows.length > 0
      ? Math.round(
          teleRows.reduce((sum, r) => sum + (r.complexity_score || 0), 0) /
            teleRows.length
        )
      : null;

  let trajectory = {
    session_id: session.id,
    messages,
    tool_calls: toolCalls,
    outcome,
    tier,
    complexity_score: complexityAvg,
    model_used: last?.model || null,
    provider_used: last?.provider || null,
    tokens_in: totals.tokens_in,
    tokens_out: totals.tokens_out,
    latency_ms: totals.latency_ms,
    started_at: new Date(session.created_at).toISOString(),
    ended_at: new Date(session.updated_at).toISOString(),
  };

  if (options.anonymize) {
    trajectory = anonymize(trajectory);
  }
  return trajectory;
}

/**
 * Stream trajectories to a writable target (a path or a stream).
 *
 * @param {Object} options
 * @param {string|number|Date} [options.since]   Window start (ms / Date / "Nd")
 * @param {string} [options.tier]                Filter to one tier
 * @param {boolean} [options.anonymize=false]    Strip PII / paths / secrets
 * @param {string|stream.Writable} [options.output="-"]   File path, "-" for stdout, or a stream
 * @param {function} [options.onProgress]        Optional progress callback (count) => void
 * @returns {{ count: number, output: string }}
 */
function exportJsonl(options = {}) {
  const since = resolveSince(options.since);
  const sessions = listSessions({ since, tier: options.tier });

  let stream;
  let outputPath = "-";
  let closeStream = false;

  if (!options.output || options.output === "-") {
    stream = process.stdout;
  } else if (typeof options.output === "string") {
    outputPath = options.output;
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    stream = fs.createWriteStream(outputPath);
    closeStream = true;
  } else {
    stream = options.output;
  }

  let count = 0;
  for (const session of sessions) {
    const trajectory = buildTrajectory(session, options);
    if (!trajectory || trajectory.messages.length === 0) continue;
    stream.write(JSON.stringify(trajectory) + "\n");
    count++;
    if (options.onProgress) options.onProgress(count);
  }

  if (closeStream) stream.end();
  return { count, output: outputPath };
}

function resolveSince(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const m = value.match(/^(\d+)d$/);
    if (m) return Date.now() - parseInt(m[1], 10) * 24 * 60 * 60 * 1000;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

module.exports = {
  exportJsonl,
  buildTrajectory,
  listSessions,
  anonymize,
};
