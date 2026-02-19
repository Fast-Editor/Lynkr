const logger = require("../logger");

let cachedEncode;
let cachedLoadError;
let warnedMissingDependency = false;

function normaliseSettings(settings = {}) {
  const minBytesRaw =
    typeof settings.minBytes === "number" ? settings.minBytes : Number.parseInt(settings.minBytes ?? "4096", 10);
  return {
    enabled: settings.enabled === true,
    minBytes: Number.isFinite(minBytesRaw) && minBytesRaw > 0 ? minBytesRaw : 4096,
    failOpen: settings.failOpen !== false,
    logStats: settings.logStats !== false,
  };
}

function resolveEncodeFn(overrideEncode) {
  if (typeof overrideEncode === "function") return overrideEncode;
  if (cachedEncode !== undefined) return cachedEncode;
  try {
    const toon = require("@toon-format/toon");
    cachedEncode = typeof toon?.encode === "function" ? toon.encode : null;
    cachedLoadError = cachedEncode ? null : new Error("Missing encode() export from @toon-format/toon");
  } catch (err) {
    cachedEncode = null;
    cachedLoadError = err;
  }
  return cachedEncode;
}

function looksLikeJsonObjectOrArray(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toToonString(encodeFn, value) {
  const encoded = encodeFn(value);
  if (typeof encoded === "string") return encoded;
  if (encoded && typeof encoded[Symbol.iterator] === "function") {
    return Array.from(encoded).join("\n");
  }
  return "";
}

function compressStringContent(content, cfg, encodeFn, stats) {
  if (typeof content !== "string") return content;

  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes < cfg.minBytes) {
    stats.skippedBySize += 1;
    return content;
  }

  stats.candidateCount += 1;
  if (!looksLikeJsonObjectOrArray(content)) {
    stats.skippedByShape += 1;
    return content;
  }

  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    stats.skippedByParse += 1;
    return content;
  }

  const toonText = toToonString(encodeFn, parsed);
  if (typeof toonText !== "string" || toonText.trim().length === 0) {
    return content;
  }

  const compressedBytes = Buffer.byteLength(toonText, "utf8");
  stats.convertedCount += 1;
  stats.originalBytes += originalBytes;
  stats.compressedBytes += compressedBytes;
  return toonText;
}

function applyToonCompression(payload, settings = {}, options = {}) {
  const cfg = normaliseSettings(settings);
  const stats = {
    enabled: cfg.enabled,
    available: true,
    convertedCount: 0,
    candidateCount: 0,
    skippedBySize: 0,
    skippedByShape: 0,
    skippedByParse: 0,
    failureCount: 0,
    originalBytes: 0,
    compressedBytes: 0,
  };

  if (!cfg.enabled) return { payload, stats };
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return { payload, stats };
  }

  const encodeFn = resolveEncodeFn(options.encode);
  if (typeof encodeFn !== "function") {
    stats.available = false;
    const err = cachedLoadError ?? new Error("TOON encoder unavailable");
    if (!cfg.failOpen) throw err;
    if (!warnedMissingDependency) {
      logger.warn(
        { error: err.message },
        "TOON enabled but encoder dependency is unavailable; falling back to JSON",
      );
      warnedMissingDependency = true;
    }
    return { payload, stats };
  }

  for (const message of payload.messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "tool") continue; // Never mutate machine-executed protocol payloads
    try {
      if (typeof message.content === "string") {
        message.content = compressStringContent(message.content, cfg, encodeFn, stats);
        continue;
      }

      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;

        // Keep protocol blocks untouched. Only compress user-language text fields.
        if (block.type === "text" && typeof block.text === "string") {
          block.text = compressStringContent(block.text, cfg, encodeFn, stats);
          continue;
        }

        if (block.type === "input_text" && typeof block.input_text === "string") {
          block.input_text = compressStringContent(block.input_text, cfg, encodeFn, stats);
        }
      }
    } catch (err) {
      stats.failureCount += 1;
      if (!cfg.failOpen) throw err;
    }
  }

  if (cfg.logStats && stats.convertedCount > 0) {
    logger.info(
      {
        convertedCount: stats.convertedCount,
        candidateCount: stats.candidateCount,
        originalBytes: stats.originalBytes,
        compressedBytes: stats.compressedBytes,
      },
      "TOON compression applied to message context",
    );
  }

  return { payload, stats };
}

module.exports = {
  applyToonCompression,
};
